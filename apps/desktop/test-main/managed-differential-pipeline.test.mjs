import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { signIndex } from '../../../packages/managed-updates/src/index.ts';
import { prepareDifferential } from '../../../scripts/prepare-managed-differential.mjs';
import contract from '../electron/managed-differential-contract.cjs';

async function fixture(t, modern = true, origin = 'https://example.com') {
  const root = await mkdtemp(join(tmpdir(), 'cc-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const publicRoot = join(root, 'public');
  await mkdir(source);
  await mkdir(publicRoot);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trustedKeys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) };
  const identity = {
    product: 'cc-desk-tunnel-managed',
    build: 34,
    channel: 'pilot',
    origin,
    trustedKeys,
  };
  const files = {
    'apps/desktop/package.json': JSON.stringify({
      version: '1.2.3',
      ...(modern ? { dependencies: { 'electron-updater': '6.8.10' } } : {}),
    }),
    'packages/protocol/src/index.ts': 'export const PROTOCOL_VERSION = 7;\n',
    'deploy/managed-client.json': JSON.stringify(identity),
    ...(modern
      ? { 'apps/desktop/electron/managed-differential-contract.cjs': '// feature marker\n' }
      : {}),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(source, name, '..'), { recursive: true });
    await writeFile(join(source, name), bytes);
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-qm',
    'fixture',
  );
  const bytes = Buffer.from('installer bytes');
  const release = {
    build: 34,
    appVersion: '1.2.3',
    protocol: 7,
    sourceCommit: git('rev-parse', 'HEAD'),
    notes: '',
    filename: 'CC-Space-Setup-1.2.3-x64.exe',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const payload = {
    schema: 1,
    product: identity.product,
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
  const artifact = join(root, release.filename);
  const privateKeyPath = join(root, 'key.pem');
  await writeFile(index, signIndex(payload, 'fixture', privateKey));
  await writeFile(artifact, bytes);
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeFile(
    artifact + '.blockmap',
    gzipSync(
      JSON.stringify({
        version: '2',
        files: [
          {
            name: 'file',
            offset: 0,
            checksums: [Buffer.alloc(18).toString('base64')],
            sizes: [bytes.length],
          },
        ],
      }),
    ),
  );
  return {
    root,
    source,
    publicRoot,
    index,
    artifact,
    release,
    payload,
    privateKey,
    privateKeyPath,
    identity,
    trustedKeys,
    args: {
      source,
      index,
      artifact,
      'private-key': privateKeyPath,
      'key-id': 'fixture',
      'public-root': publicRoot,
    },
  };
}

test('legacy source skips differential publication', async (t) => {
  const f = await fixture(t, false);
  let calls = 0;
  assert.equal(
    await prepareDifferential(f.args, async () => {
      calls++;
    }),
    null,
  );
  assert.equal(calls, 0);
});

test('SDK source requires its blockmap before calling the publisher', async (t) => {
  const f = await fixture(t);
  await rm(f.artifact + '.blockmap');
  let calls = 0;
  await assert.rejects(
    prepareDifferential(f.args, async () => {
      calls++;
    }),
  );
  assert.equal(calls, 0);
});

test('feature detection requires both SDK dependency and contract marker', async (t) => {
  const f = await fixture(t);
  await rm(join(f.source, 'apps/desktop/electron/managed-differential-contract.cjs'));
  assert.equal(
    await prepareDifferential(f.args, () => assert.fail('Legacy publication called publisher')),
    null,
  );
  assert.equal(
    await prepareDifferential({ state: 'empty' }, () => assert.fail('Withdrawal called publisher')),
    null,
  );
});

test('preparation forwards scoped overrides and production public-root default', async (t) => {
  const f = await fixture(t);
  const args = { ...f.args, blockmap: f.artifact + '.blockmap' };
  delete args['public-root'];
  let forwarded;
  const summary = { build: 34 };
  assert.equal(
    await prepareDifferential(args, async (value) => {
      forwarded = value;
      return summary;
    }),
    summary,
  );
  assert.deepEqual(forwarded, { ...args, 'public-root': '/srv/cc-update-service/public' });
});

test('SDK preparation stages real signed installer and immutable sidecars', async (t) => {
  const f = await fixture(t);
  const summary = await prepareDifferential(f.args);
  assert.equal(summary.build, 34);
  const descriptorFile = join(f.publicRoot, summary.descriptorPath.replace('/cc-updates/v1/', ''));
  const first = await readFile(descriptorFile);
  contract.verifyDescriptor(first, f.trustedKeys, f.release, 'pilot');
  assert.deepEqual(await prepareDifferential(f.args), summary);
  assert.deepEqual(await readFile(descriptorFile), first);
  f.payload.revision++;
  f.payload.release.notes = 'Renewed release notes';
  await writeFile(f.index, signIndex(f.payload, 'fixture', f.privateKey));
  const publicArtifact = join(
    f.publicRoot,
    summary.descriptorPath.replace('/cc-updates/v1/', '').replace(/\.differential\.json$/, ''),
  );
  assert.deepEqual(await prepareDifferential({ ...f.args, artifact: publicArtifact }), summary);
  assert.deepEqual(await readFile(descriptorFile), first);
});

for (const scenario of ['valid', 'missing', 'corrupt'])
  test(`publication CLI ${scenario} map gates activation after upload`, async (t) => {
    const events = [];
    let f;
    let output;
    const candidateId = '00000000-0000-0000-0000-000000000001';
    const server = createServer(async (request, response) => {
      try {
        const path = request.url;
        let body;
        if (path.endsWith('/status')) body = JSON.stringify({ channels: [], candidates: [] });
        else if (path.endsWith('/candidates')) body = JSON.stringify({ id: candidateId });
        else if (path.endsWith('/artifact')) {
          for await (const _chunk of request) {
          }
          events.push('upload');
          body = '{}';
        } else if (path.endsWith('/activate')) {
          const descriptor = await readFile(
            join(f.publicRoot, contract.descriptorPath(f.release).replace('/cc-updates/v1/', '')),
          );
          contract.verifyDescriptor(descriptor, f.trustedKeys, f.release, 'pilot');
          events.push('prepare', 'activate');
          body = '{}';
        } else if (path.includes('/channels/stable/')) body = '{}';
        else if (path.includes('/channels/pilot/')) body = await readFile(output);
        else if (path.includes('/artifacts/')) body = await readFile(f.artifact);
        else throw new Error('Unexpected test request');
        response.writeHead(200, { 'Content-Length': Buffer.byteLength(body) });
        response.end(request.method === 'HEAD' ? undefined : body);
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    f = await fixture(t, true, `http://127.0.0.1:${server.address().port}`);
    if (scenario === 'missing') await rm(f.artifact + '.blockmap');
    if (scenario === 'corrupt') await writeFile(f.artifact + '.blockmap', 'bad gzip');
    const admin = join(f.root, 'admin');
    await mkdir(join(admin, 'signing'), { recursive: true });
    await mkdir(join(admin, 'access'));
    await writeFile(join(admin, 'identity-public.json'), JSON.stringify(f.identity));
    await writeFile(join(admin, 'signing/fixture.pem'), await readFile(f.privateKeyPath));
    await writeFile(join(admin, 'access/admin-token.txt'), 'fixture-token');
    const input = join(f.root, 'input.json');
    const { size: _size, sha256: _sha256, ...release } = f.release;
    await writeFile(input, JSON.stringify({ ...f.payload, release }));
    await mkdir(join(f.root, 'output'));
    output = join(f.root, 'output', 'new-index.json');
    const child = spawn(
      process.execPath,
      [
        'scripts/publish-managed-update.mjs',
        '--input',
        input,
        '--out',
        output,
        '--source',
        f.source,
        '--artifact',
        f.artifact,
        '--admin-root',
        admin,
        '--public-root',
        f.publicRoot,
      ],
      { windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const code = await new Promise((resolve) => child.on('close', resolve));
    const evidence = JSON.parse(await readFile(output + '.evidence.json'));
    if (scenario === 'valid') {
      assert.equal(code, 0, stderr);
      assert.deepEqual(events, ['upload', 'prepare', 'activate']);
      assert.equal(evidence.differentialPrepared.build, 34);
    } else {
      assert.equal(code, 1);
      assert(stderr.includes('prepare-differential'));
      assert.deepEqual(events, ['upload']);
      assert.equal(evidence.activation, undefined);
      assert.equal(evidence.differentialPrepared, undefined);
    }
  });
