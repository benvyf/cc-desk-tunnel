import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  link,
  symlink,
  chown,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { signIndex } from '../../../packages/managed-updates/src/index.ts';
import { publishDifferential } from '../../../scripts/publish-managed-differential.mjs';
import contract from '../electron/managed-differential-contract.cjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const publicRoot = join(root, 'public');
  await mkdir(source);
  await mkdir(publicRoot);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trustedKeys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  for (const [name, bytes] of Object.entries({
    'apps/desktop/package.json': JSON.stringify({ version: '1.2.3' }),
    'packages/protocol/src/index.ts': 'export const PROTOCOL_VERSION = 7;\n',
    'deploy/managed-client.json': JSON.stringify({
      product: 'cc-desk-tunnel-managed',
      build: 34,
      channel: 'pilot',
      origin: 'https://example.com',
      trustedKeys,
    }),
  })) {
    await mkdir(join(source, name, '..'), { recursive: true });
    await writeFile(join(source, name), bytes);
  }
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-qm',
    'fixture',
  );
  const installer = Buffer.from('complete installer fixture');
  const release = {
    build: 34,
    appVersion: '1.2.3',
    protocol: 7,
    sourceCommit: git('rev-parse', 'HEAD'),
    notes: '',
    filename: 'CC-Space-Setup-1.2.3-x64.exe',
    size: installer.length,
    sha256: hash(installer),
  };
  const payload = {
    schema: 1,
    product: 'cc-desk-tunnel-managed',
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    revision: 1,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    state: 'published',
    release,
  };
  const index = join(root, 'index.json');
  const privateKeyPath = join(root, 'private.pem');
  const blockmap = join(root, 'installer.blockmap');
  const artifact = join(publicRoot, 'artifacts', '34', 'win32-x64', release.filename);
  await mkdir(join(artifact, '..'), { recursive: true });
  await writeFile(artifact, installer);
  await writeFile(index, signIndex(payload, 'fixture', privateKey));
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const map = {
    version: '2',
    files: [
      {
        name: 'file',
        offset: 0,
        checksums: [Buffer.alloc(18).toString('base64')],
        sizes: [installer.length],
      },
    ],
  };
  await writeFile(blockmap, gzipSync(JSON.stringify(map)));
  return {
    root,
    source,
    publicRoot,
    artifact,
    index,
    blockmap,
    privateKeyPath,
    privateKey,
    trustedKeys,
    release,
    payload,
    map,
    git,
    args: {
      source,
      index,
      blockmap,
      'private-key': privateKeyPath,
      'key-id': 'fixture',
      'public-root': publicRoot,
    },
  };
}

test('root publication inherits service ownership and public permissions', async (t) => {
  if (process.platform === 'win32' || process.getuid() !== 0)
    return t.skip('Requires Unix root to reproduce service ownership boundary');
  const f = await fixture(t);
  await chown(f.publicRoot, 65534, 65534);
  const previous = process.umask(0o077);
  try {
    await publishDifferential(f.args);
    for (const [file, mode] of [
      [join(f.publicRoot, 'artifacts/34'), 0o755],
      [join(f.publicRoot, 'artifacts/34/win32-x64'), 0o755],
      [f.artifact, 0o644],
      [f.artifact + '.blockmap', 0o644],
      [f.artifact + '.differential.json', 0o644],
    ]) {
      const info = await stat(file);
      assert.equal(info.uid, 65534);
      assert.equal(info.gid, 65534);
      assert.equal(info.mode & 0o777, mode);
    }
  } finally {
    process.umask(previous);
  }
});

test('publishes immutable signed metadata and reruns without changing bytes', async (t) => {
  const f = await fixture(t);
  const summary = await publishDifferential(f.args);
  assert.equal(summary.build, 34);
  const descriptor = await readFile(
    join(f.publicRoot, summary.descriptorPath.replace('/cc-updates/v1/', '')),
  );
  const verified = contract.verifyDescriptor(descriptor, f.trustedKeys, f.release, 'pilot');
  assert.equal(
    verified.sha512,
    createHash('sha512')
      .update(await readFile(f.artifact))
      .digest('base64'),
  );
  assert.deepEqual(
    await readFile(join(f.publicRoot, summary.blockmapPath.replace('/cc-updates/v1/', ''))),
    await readFile(f.blockmap),
  );
  const second = await publishDifferential(f.args);
  assert.deepEqual(second, summary);
  assert.deepEqual(
    await readFile(join(f.publicRoot, summary.descriptorPath.replace('/cc-updates/v1/', ''))),
    descriptor,
  );
  assert.deepEqual(await readFile(f.artifact), Buffer.from('complete installer fixture'));
});

for (const [name, mutate] of [
  ['dirty source', async (f) => writeFile(join(f.source, 'untracked'), 'x')],
  [
    'source commit mismatch',
    async (f) => {
      f.payload.release.sourceCommit = 'f'.repeat(40);
      await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey));
    },
  ],
  [
    'build mismatch',
    async (f) => {
      f.payload.release.build = 35;
      await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey));
    },
  ],
  [
    'app version mismatch',
    async (f) => {
      f.payload.release.appVersion = '1.2.4';
      f.payload.release.filename = 'CC-Space-Setup-1.2.4-x64.exe';
      await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey));
    },
  ],
  [
    'protocol mismatch',
    async (f) => {
      f.payload.release.protocol++;
      await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey));
    },
  ],
  [
    'channel mismatch',
    async (f) => {
      f.payload.channel = 'stable';
      await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey));
    },
  ],
  [
    'expired signed index',
    async (f) => {
      const now = Date.now() - 86400000;
      f.payload.issuedAt = new Date(now).toISOString();
      f.payload.expiresAt = new Date(now + 3600000).toISOString();
      await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey, now));
    },
  ],
  [
    'tampered signed index',
    async (f) => {
      const envelope = JSON.parse(await readFile(f.index));
      const payload = JSON.parse(Buffer.from(envelope.payload, 'base64'));
      payload.revision++;
      envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
      await writeFile(f.index, JSON.stringify(envelope));
    },
  ],
  [
    'wrong signer',
    async (f) => {
      await writeFile(f.index, signIndex(f.payload, 'other', f.privateKey));
    },
  ],
  [
    'wrong private key',
    async (f) =>
      writeFile(
        f.privateKeyPath,
        generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
      ),
  ],
  ['installer corruption', async (f) => writeFile(f.artifact, 'corrupt')],
  ['bad gzip', async (f) => writeFile(f.blockmap, 'invalid')],
  [
    'bad map sum',
    async (f) => {
      f.map.files[0].sizes[0]++;
      await writeFile(f.blockmap, gzipSync(JSON.stringify(f.map)));
    },
  ],
  ['oversized map', async (f) => writeFile(f.blockmap, Buffer.alloc(4 * 1024 * 1024 + 1))],
  ['hardlinked installer', async (f) => link(f.artifact, join(f.root, 'linked.exe'))],
  ['hardlinked blockmap', async (f) => link(f.blockmap, join(f.root, 'linked.blockmap'))],
  ['oversized index', async (f) => writeFile(f.index, Buffer.alloc(64 * 1024 + 1))],
  [
    'private key in public root',
    async (f) => {
      const key = join(f.publicRoot, 'secret.pem');
      await writeFile(key, await readFile(f.privateKeyPath));
      f.args['private-key'] = key;
    },
  ],
])
  test(`rejects ${name}`, async (t) => {
    const f = await fixture(t);
    await mutate(f);
    await assert.rejects(publishDifferential(f.args));
  });

test('conflicting immutable descriptor prevents any blockmap write', async (t) => {
  const f = await fixture(t);
  const summary = await publishDifferential(f.args);
  const descriptor = join(f.publicRoot, summary.descriptorPath.replace('/cc-updates/v1/', ''));
  const map = join(f.publicRoot, summary.blockmapPath.replace('/cc-updates/v1/', ''));
  await writeFile(descriptor, 'conflict');
  await rm(map);
  await assert.rejects(publishDifferential(f.args));
  await assert.rejects(readFile(map), { code: 'ENOENT' });
});

test('rejects linked output ancestors', async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, 'public-link');
  await symlink(f.publicRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(publishDifferential({ ...f.args, 'public-root': linked }));
});

test('conflicting blockmap prevents descriptor publication', async (t) => {
  const f = await fixture(t);
  const summary = await publishDifferential(f.args);
  const descriptor = join(f.publicRoot, summary.descriptorPath.replace('/cc-updates/v1/', ''));
  const map = join(f.publicRoot, summary.blockmapPath.replace('/cc-updates/v1/', ''));
  await writeFile(map, 'conflict');
  await rm(descriptor);
  await assert.rejects(publishDifferential(f.args));
  await assert.rejects(readFile(descriptor), { code: 'ENOENT' });
});

test('CLI never prints private paths or exception details', async (t) => {
  const f = await fixture(t);
  const result = spawnSync(
    process.execPath,
    ['scripts/publish-managed-differential.mjs', '--private-key', f.privateKeyPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert(!result.stderr.includes(f.privateKeyPath));
  assert(!result.stderr.includes('BEGIN PRIVATE KEY'));
});

test('stages optional full artifact exclusively before publishing sidecars', async (t) => {
  const f = await fixture(t);
  const artifact = join(f.root, 'input.exe');
  const bytes = await readFile(f.artifact);
  await writeFile(artifact, bytes);
  await rm(join(f.publicRoot, 'artifacts'), { recursive: true });
  const summary = await publishDifferential({ ...f.args, artifact });
  assert.equal(summary.build, 34);
  assert.deepEqual(await readFile(f.artifact), bytes);
  await publishDifferential({ ...f.args, artifact });
});

test('bad optional artifact does not write public files', async (t) => {
  const f = await fixture(t);
  const artifact = join(f.root, 'input.exe');
  await writeFile(artifact, 'wrong');
  await rm(f.artifact);
  await assert.rejects(publishDifferential({ ...f.args, artifact }));
  await assert.rejects(readFile(f.artifact), { code: 'ENOENT' });
});

test('optional artifact never replaces contradictory existing public installer', async (t) => {
  const f = await fixture(t);
  const artifact = join(f.root, 'input.exe');
  await writeFile(artifact, await readFile(f.artifact));
  await writeFile(f.artifact, 'wrong existing public installer');
  await assert.rejects(publishDifferential({ ...f.args, artifact }));
  assert.equal(await readFile(f.artifact, 'utf8'), 'wrong existing public installer');
});

test('invalid map is rejected before staging optional full installer', async (t) => {
  const f = await fixture(t);
  const artifact = join(f.root, 'input.exe');
  await writeFile(artifact, await readFile(f.artifact));
  await rm(f.artifact);
  await writeFile(f.blockmap, 'bad map');
  await assert.rejects(publishDifferential({ ...f.args, artifact }));
  await assert.rejects(readFile(f.artifact), { code: 'ENOENT' });
});
