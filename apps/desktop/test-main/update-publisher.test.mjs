import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, truncate, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyIndex } from '../../../packages/managed-updates/src/index.ts';

const script = fileURLToPath(new URL('../../../scripts/sign-managed-update.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-publisher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const out = join(root, 'out');
  const secrets = join(root, 'secrets');
  for (const dir of [
    out,
    secrets,
    join(source, 'apps/desktop'),
    join(source, 'packages/protocol/src'),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(join(source, 'apps/desktop/package.json'), JSON.stringify({ version: '0.3.6' }));
  await writeFile(
    join(source, 'packages/protocol/src/index.ts'),
    'export const PROTOCOL_VERSION = 20;\n',
  );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  git('add', '.');
  git(
    '-c',
    'user.name=Signing Test',
    '-c',
    'user.email=signing-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  );
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = join(secrets, 'test-key.pem');
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const artifact = join(root, 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe');
  // A fixture only, not a runnable installer or a claimed production build.
  const content = Buffer.from('test installer fixture\n');
  await writeFile(artifact, content);
  const input = join(root, 'input.json');
  const payload = {
    schema: 1,
    product: 'cc-desk-tunnel-managed',
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    revision: 1,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    state: 'published',
    release: {
      build: 1,
      appVersion: '0.3.6',
      protocol: 20,
      sourceCommit: git('rev-parse', 'HEAD'),
      notes: '测试发布',
      filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
    },
  };
  const output = join(out, 'pilot.json');
  const save = () => writeFile(input, JSON.stringify(payload));
  await save();
  const args = [
    '--input',
    input,
    '--key-id',
    'test',
    '--private-key',
    key,
    '--out',
    output,
    '--source',
    source,
    '--artifact',
    artifact,
  ];
  const run = (argv = args) =>
    spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', windowsHide: true });
  return {
    root,
    source,
    out,
    key,
    publicKey,
    artifact,
    content,
    payload,
    input,
    output,
    args,
    save,
    run,
    git,
  };
}

test('CLI signs real streamed artifact size/hash without uploading or overwriting output', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(f.output);
  const verified = verifyIndex(bytes, { test: f.publicKey });
  assert.equal(verified.payload.release.size, f.content.length);
  assert.equal(
    verified.payload.release.sha256,
    createHash('sha256').update(f.content).digest('hex'),
  );
  assert.equal(verified.payload.release.sourceCommit, f.payload.release.sourceCommit);
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(await readFile(f.output), bytes);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/);
});

test('CLI creates a signed empty withdrawal without source or artifact', async (t) => {
  const f = await fixture(t);
  f.payload.state = 'empty';
  f.payload.release = null;
  f.payload.revision = 2;
  await f.save();
  const result = f.run(f.args.slice(0, 8));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(verifyIndex(await readFile(f.output), { test: f.publicKey }).payload.state, 'empty');
  assert.notEqual(f.run(f.args).status, 0);
});

test('CLI refuses false source identity, wrong filename and operator-provided hashes', async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.payload);
  for (const change of [
    { sourceCommit: 'a'.repeat(40) },
    { appVersion: '0.3.7', filename: 'CC-Desk-Tunnel-Setup-0.3.7-x64.exe' },
    { protocol: 19 },
    { sha256: 'a'.repeat(64) },
    { size: 1 },
    { filename: '../evil.exe' },
  ]) {
    f.payload.release = { ...original.release, ...change };
    await f.save();
    assert.notEqual(f.run().status, 0, JSON.stringify(change));
  }
  // Keep the physical filename unchanged to exercise checkSource's version check.
  f.payload.release = { ...original.release, appVersion: '0.3.7' };
  await f.save();
  const mismatch = f.run();
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /appVersion/);
  f.payload.release = original.release;
  await f.save();
  await writeFile(
    join(f.source, 'apps/desktop/package.json'),
    JSON.stringify({ version: '0.3.7' }),
  );
  assert.match(f.run().stderr, /清洁/);
  f.git('add', 'apps/desktop/package.json');
  assert.match(f.run().stderr, /清洁/);
  f.git('restore', '--staged', 'apps/desktop/package.json');
  f.git('restore', 'apps/desktop/package.json');
  await writeFile(join(f.source, 'untracked.txt'), 'dirty');
  assert.notEqual(f.run().status, 0);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('CLI refuses private keys inside source or publication directory, including directory symlinks', async (t) => {
  const f = await fixture(t);
  const secret = await readFile(f.key);
  const changeKey = (path) => f.args.map((arg, i) => (i === 5 ? path : arg));
  for (const path of [join(f.source, 'secret.pem'), join(f.out, 'secret.pem')]) {
    await writeFile(path, secret);
    const result = f.run(changeKey(path));
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(secret.toString()));
    await rm(path);
  }
  // Windows directory junctions require no symlink privilege.
  const alias = join(f.root, 'key-alias');
  await symlink(f.out, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(f.out, 'secret.pem'), secret);
  assert.notEqual(f.run(changeKey(join(alias, 'secret.pem'))).status, 0);
});

test('CLI preserves existing output reached through a directory alias and rejects artifact size limits', async (t) => {
  const f = await fixture(t);
  // Directory junctions make the existing output reachable by an alias without privileges.
  const alias = join(f.root, 'output-alias');
  await symlink(f.out, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(f.output, 'keep existing');
  const args = f.args.map((arg, i) => (i === 7 ? join(alias, 'pilot.json') : arg));
  assert.notEqual(f.run(args).status, 0);
  assert.equal(await readFile(f.output, 'utf8'), 'keep existing');
  await rm(f.output);
  // Sparse file: exercise the actual limit without allocating or hashing 1 GiB.
  await truncate(f.artifact, 1073741825);
  assert.match(f.run().stderr, /1 GiB/);
  await truncate(f.artifact, 0);
  assert.match(f.run().stderr, /1 GiB/);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('CLI refuses non-Ed25519 keys, unknown/duplicate/missing arguments and malformed input', async (t) => {
  const f = await fixture(t);
  for (const args of [
    [],
    [...f.args, '--surprise', '1'],
    [...f.args, '--key-id', 'again'],
    f.args.slice(0, -2),
  ]) {
    assert.notEqual(f.run(args).status, 0);
  }
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(f.key, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.notEqual(f.run().status, 0);
  await writeFile(f.input, '{');
  assert.notEqual(f.run().status, 0);
  await writeFile(f.input, ' '.repeat(65537));
  assert.notEqual(f.run().status, 0);
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});
