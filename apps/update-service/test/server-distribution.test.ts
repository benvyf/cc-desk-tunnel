import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { UpdateStore } from '../src/store.ts';
import { createUpdateServer } from '../src/http.ts';
import { validateConfig } from '../src/config.ts';
import {
  buildDescriptor,
  compatibility,
  COMPATIBILITY_PATHS,
  RUNTIME_LEVEL,
  sha256,
  signServerIndex,
} from '../../../packages/managed-server/src/index.ts';
import {
  ServerDistribution,
  bootstrapCommand,
  releaseFromArchive,
  renewalPayload,
} from '../src/server-distribution.ts';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'server-dist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const files: Record<string, string> = Object.fromEntries(
    [
      'package.json',
      'package-lock.json',
      'apps/server/src/managed-main.ts',
      'packages/protocol/package.json',
      ...COMPATIBILITY_PATHS,
    ].map((p) => [
      p,
      p === 'packages/protocol/src/index.ts' ? 'export const PROTOCOL_VERSION = 42;\n' : p,
    ]),
  );
  for (const [p, b] of Object.entries(files)) {
    mkdirSync(dirname(join(source, p)), { recursive: true });
    writeFileSync(join(source, p), b);
  }
  const keys = generateKeyPairSync('ed25519');
  const trusted = { test: keys.publicKey };
  const descriptor = buildDescriptor(source, {
    build: 1,
    appVersion: '0.3.6',
    protocol: 42,
    sourceCommit: 'a'.repeat(40),
  });
  const descriptorBytes = JSON.stringify(descriptor);
  const blocks: Buffer[] = [];
  for (const [p, value] of Object.entries({ ...files, 'SERVER-RELEASE.json': descriptorBytes })) {
    const b = Buffer.from(value),
      h = Buffer.alloc(512);
    h.write(p);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(b.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(32, 148, 156);
    h[156] = 48;
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(
      h
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(h, b, Buffer.alloc((512 - (b.length % 512)) % 512));
  }
  const archive = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const release = {
    build: 1,
    appVersion: '0.3.6',
    protocol: 42,
    sourceCommit: 'a'.repeat(40),
    size: archive.length,
    sha256: sha256(archive),
    descriptorSha256: sha256(descriptorBytes),
    packageLockSha256: sha256(files['package-lock.json']!),
    runtimeLevel: RUNTIME_LEVEL,
    compatibility: compatibility(source),
  };
  const signed = (revision: number, override = {}) =>
    Buffer.from(
      JSON.stringify(
        signServerIndex(
          {
            schema: 1,
            product: 'cc-desk-tunnel-managed-server',
            channel: 'pilot',
            platform: 'linux',
            arch: 'x64',
            revision,
            issuedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            release: { ...release, ...override },
          },
          'test',
          keys.privateKey,
        ),
      ),
    );
  return { root, archive, release, signed, trusted, keys };
}

test('Linux publication verifies full archive, retains immutable builds and rejects replay/substitution after restart', (t) => {
  const f = fixture(t),
    data = join(f.root, 'data');
  mkdirSync(join(data, 'public/channels'), { recursive: true });
  writeFileSync(join(data, 'public/channels/windows-fixture.json'), 'Windows bytes');
  const d = new ServerDistribution(data, f.trusted);
  assert.equal(d.index(), undefined);
  const first = f.signed(1);
  assert.throws(() => d.publish(first, Buffer.from('corrupt')));
  assert.equal(d.index(), undefined);
  d.publish(first, f.archive);
  assert.deepEqual(d.index(), first);
  assert.deepEqual(
    d.artifact(
      '/cc-updates/server/v1/artifacts/1/linux-x64/cc-desk-tunnel-server-0.3.6-build1.tar.gz',
    ),
    f.archive,
  );
  const next = f.signed(2);
  d.publish(next, f.archive);
  const restarted = new ServerDistribution(data, f.trusted);
  assert.throws(() => restarted.publish(first, f.archive));
  assert.throws(() => restarted.publish(f.signed(3, { sha256: 'b'.repeat(64) }), f.archive));
  assert.deepEqual(restarted.index(), next);
  assert.equal(
    readFileSync(join(data, 'public/channels/windows-fixture.json'), 'utf8'),
    'Windows bytes',
  );
  for (const path of [
    '/cc-updates/server/v1/artifacts/01/linux-x64/cc-desk-tunnel-server-0.3.6-build1.tar.gz',
    '/cc-updates/server/v1/artifacts/1/linux-x64/../secret',
    '/cc-updates/server/v1/artifacts/1/linux-x64/wrong.tar.gz',
  ])
    assert.equal(d.artifact(path), undefined);
});

test('bootstrap command pins installer and exact signed release and uses POSIX shell quoting', (t) => {
  const f = fixture(t),
    command = bootstrapCommand(f.release, 'b'.repeat(64));
  assert.match(command, /^sudo python3 -c '/);
  assert.match(command, /--build/);
  assert.match(command, new RegExp(f.release.sha256));
  assert.doesNotMatch(command, /curl|wget|pip |npm |`|\$\(/);
  if (process.platform === 'win32')
    execFileSync(
      'python',
      [
        '-c',
        "import shlex,sys; a=shlex.split(sys.stdin.read()); assert a[:3]==['sudo','python3','-c'] and len(a)==4; compile(a[3],'<bootstrap-command>','exec')",
      ],
      { input: command, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  else {
    const parsed = execFileSync(
      '/bin/sh',
      [
        '-c',
        `set -e\nset -- ${command}\ntest "$#" -eq 4\ntest "$1" = sudo\ntest "$2" = python3\ntest "$3" = -c\nprintf '%s' "$4"`,
      ],
      { encoding: 'utf8' },
    );
    assert.match(parsed, /class NoRedirect/);
    assert.match(parsed, new RegExp(f.release.sha256));
  }
  assert.throws(() => bootstrapCommand({ ...f.release, build: NaN }, 'b'.repeat(64)));
});

test('publication derives exact descriptor and compatibility from a complete validated archive', (t) => {
  const f = fixture(t);
  assert.deepEqual(releaseFromArchive(f.archive), f.release);
  assert.throws(() => releaseFromArchive(Buffer.from('invalid')));
});

test('Linux renewal requires exact registered release and advances only revision/timestamps', (t) => {
  const f = fixture(t),
    p = JSON.parse(Buffer.from(JSON.parse(f.signed(9).toString()).payload, 'base64url').toString());
  assert.throws(() => renewalPayload(p, { ...f.release, build: 2 }));
  const renewed = renewalPayload(p, f.release, Date.now(), true)!;
  assert.equal(renewed.revision, 10);
  assert.deepEqual(renewed.release, p.release);
  assert.equal(
    renewalPayload(
      { ...p, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() },
      f.release,
    ),
    undefined,
  );
});

test(
  'Linux root publication remains readable under the private administrator umask',
  { skip: process.platform === 'win32' },
  (t) => {
    const f = fixture(t),
      d = new ServerDistribution(join(f.root, 'data'), f.trusted),
      old = process.umask(0o077);
    try {
      d.publish(f.signed(1), f.archive);
    } finally {
      process.umask(old);
    }
    for (const p of [
      'index.json',
      'artifacts/1/release.json',
      'artifacts/1/cc-desk-tunnel-server-0.3.6-build1.tar.gz',
    ])
      assert.equal(statSync(join(d.root, p)).mode & 0o777, 0o644);
    for (const p of ['', 'artifacts', 'artifacts/1'])
      assert.equal(statSync(join(d.root, p)).mode & 0o777, 0o755);
  },
);

test('publication CLI signs, publishes and renews only the exactly registered Linux release', (t) => {
  const f = fixture(t),
    data = join(f.root, 'data'),
    config = join(f.root, 'config.json'),
    key = join(f.root, 'test-signing.pem'),
    archive = join(f.root, 'server.tar.gz'),
    index = join(f.root, 'index.json'),
    renewal = join(f.root, 'renew.json');
  const cli = join(import.meta.dirname, '../../../scripts/managed-server-publication.mjs');
  writeFileSync(
    config,
    JSON.stringify({
      origin: 'https://api.ghostapi.org',
      dataDir: data,
      port: 8817,
      adminName: 'test',
      adminTokenSha256: 'a'.repeat(64),
      trustedKeys: { test: f.keys.publicKey.export({ type: 'spki', format: 'pem' }) },
    }),
  );
  writeFileSync(key, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(archive, f.archive);
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [cli, ...args], { windowsHide: true, stdio: 'pipe' });
  run('sign', config, archive, key, 'test', '1', index);
  run('publish', config, index, archive);
  const d = new ServerDistribution(data, f.trusted),
    before = d.index()!;
  writeFileSync(
    renewal,
    JSON.stringify({
      serviceConfig: config,
      keyFile: key,
      keyId: 'test',
      expectedRelease: { ...f.release, build: 999 },
    }),
  );
  assert.throws(() => run('renew', renewal, '--force'));
  assert.deepEqual(d.index(), before);
  writeFileSync(
    renewal,
    JSON.stringify({
      serviceConfig: config,
      keyFile: key,
      keyId: 'test',
      expectedRelease: f.release,
    }),
  );
  assert.equal(run('renew', renewal).toString().trim(), 'not-due');
  assert.equal(run('renew', renewal, '--force').toString().trim(), 'renewed');
  assert.equal(d.status().published, true);
  assert.throws(() => run('publish', config, index, archive));
});

test('published Linux GET/HEAD and authenticated bootstrap command expose exact signed bytes', async (t) => {
  const f = fixture({ after() {} }),
    data = join(f.root, 'http-data'),
    token = 'synthetic_admin_token_12345678901234567';
  const config = validateConfig({
    origin: 'https://api.ghostapi.org',
    dataDir: data,
    port: 8817,
    adminName: 'test',
    adminTokenSha256: sha256(token),
    trustedKeys: { test: f.keys.publicKey.export({ type: 'spki', format: 'pem' }) },
  });
  const store = await UpdateStore.open(data, config.trustedKeys, config.adminName);
  const d = new ServerDistribution(data, config.trustedKeys),
    index = f.signed(1);
  d.publish(index, f.archive);
  const server = await createUpdateServer(store, config);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    rmSync(f.root, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const signed = await fetch(base + '/cc-updates/server/v1/channels/pilot/linux-x64.json');
  assert.equal(signed.status, 200);
  assert.deepEqual(Buffer.from(await signed.arrayBuffer()), index);
  const artifact = await fetch(base + d.path(f.release));
  assert.equal(artifact.status, 200);
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), f.archive);
  const head = await fetch(base + d.path(f.release), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), f.archive.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await fetch(base + d.path(f.release), { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/cc-updates/admin/api/server')).status, 401);
  const status = await (
    await fetch(base + '/cc-updates/admin/api/server', {
      headers: { authorization: 'Bearer ' + token },
    })
  ).json();
  assert.equal(status.payload.release.sha256, f.release.sha256);
  assert.equal(status.downloadPath, d.path(f.release));
  assert.match(status.command, /^sudo python3 -c '/);
});
