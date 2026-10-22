import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { signIndex, verifyIndex } from '../../../packages/managed-updates/src/index.ts';
import { UpdateStore } from '../src/store.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cc-update-store-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { test: publicKey };
  let store = await UpdateStore.open(root, keys, 'test-admin');
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('installer test fixture');
  function index(revision = 1, build = 1, channel: 'pilot' | 'stable' = 'pilot', empty = false) {
    return signIndex(
      {
        schema: 1,
        product: 'cc-desk-tunnel-managed',
        channel,
        platform: 'win32',
        arch: 'x64',
        revision,
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        state: empty ? 'empty' : 'published',
        release: empty
          ? null
          : {
              build,
              appVersion: '0.3.6',
              protocol: 20,
              sourceCommit: 'a'.repeat(40),
              notes: '<script>untrusted text</script>',
              filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
      },
      'test',
      privateKey,
    );
  }
  return {
    root,
    keys,
    privateKey,
    bytes,
    index,
    get store() {
      return store;
    },
    async reopen() {
      await store.close();
      store = await UpdateStore.open(root, keys, 'test-admin');
    },
  };
}

test('only publishes complete verified files and preserves exact signed index across restart', async (t) => {
  const f = await fixture(t);
  const signed = f.index();
  const candidate = await f.store.createCandidate(signed);
  assert.equal(f.store.channel('pilot'), null);
  await assert.rejects(f.store.activate(candidate.id), /artifact/);
  await f.store.upload(candidate.id, Readable.from([f.bytes]));
  await f.store.activate(candidate.id);
  assert.deepEqual(f.store.channel('pilot'), signed);
  assert.deepEqual(
    await readFile(join(f.root, 'public/artifacts/1/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe')),
    f.bytes,
  );
  assert.equal(verifyIndex(f.store.channel('pilot')!, f.keys).payload.release!.build, 1);
  await f.reopen();
  assert.deepEqual(f.store.channel('pilot'), signed);
  assert.equal(f.store.status().audit[0]!.action, 'published');
  assert.equal(f.store.status().audit[0]!.actor, 'test-admin');
});

test('renewal, stable promotion and signed withdrawal do not require reuploading a known build', async (t) => {
  const f = await fixture(t);
  const first = await f.store.createCandidate(f.index());
  await f.store.upload(first.id, Readable.from([f.bytes]));
  await f.store.activate(first.id);
  for (const [revision, channel, empty] of [
    [2, 'pilot', false],
    [1, 'stable', false],
    [3, 'pilot', true],
  ] as const) {
    const candidate = await f.store.createCandidate(f.index(revision, 1, channel, empty));
    await f.store.activate(candidate.id);
  }
  assert.equal(verifyIndex(f.store.channel('pilot')!, f.keys).payload.state, 'empty');
  assert.equal(verifyIndex(f.store.channel('stable')!, f.keys).payload.state, 'published');
  const replay = await f.store.createCandidate(f.index(1));
  await assert.rejects(f.store.activate(replay.id), /revision/);
});

test('revision conflicts and cross-channel reuse with altered build identity are rejected', async (t) => {
  const f = await fixture(t);
  const first = await f.store.createCandidate(f.index());
  await f.store.upload(first.id, Readable.from([f.bytes]));
  await f.store.activate(first.id);
  await f.store.activate(first.id); // exact retry is idempotent
  const p = verifyIndex(f.index(2, 1, 'stable'), f.keys).payload;
  const conflict = await f.store.createCandidate(
    signIndex({ ...p, release: { ...p.release!, sha256: 'b'.repeat(64) } }, 'test', f.privateKey),
  );
  await assert.rejects(f.store.activate(conflict.id), /build/);
  const conflictingRevision = await f.store.createCandidate(f.index(1, 2));
  await assert.rejects(f.store.activate(conflictingRevision.id), /revision/);
  const high = await f.store.createCandidate(f.index(2, 3));
  await f.store.upload(high.id, Readable.from([f.bytes]));
  await f.store.activate(high.id);
  const low = await f.store.createCandidate(f.index(3, 2));
  await f.store.upload(low.id, Readable.from([f.bytes]));
  await assert.rejects(f.store.activate(low.id), /build/);
  const knownOld = await f.store.createCandidate(f.index(3, 1));
  await assert.rejects(f.store.activate(knownOld.id), /build/);
});

test('truncated, oversized, tampered and interrupted uploads stay private and are cleaned up', async (t) => {
  const f = await fixture(t);
  const candidate = await f.store.createCandidate(f.index());
  for (const data of [
    f.bytes.subarray(1),
    Buffer.concat([f.bytes, Buffer.from('extra')]),
    Buffer.alloc(f.bytes.length),
  ]) {
    await assert.rejects(f.store.upload(candidate.id, Readable.from([data])));
    assert.equal(f.store.channel('pilot'), null);
    await assert.rejects(readFile(join(f.root, 'private', `${candidate.id}.part`)), {
      code: 'ENOENT',
    });
  }
  async function* interrupted() {
    yield f.bytes.subarray(0, 1);
    throw new Error('disconnected');
  }
  await assert.rejects(f.store.upload(candidate.id, Readable.from(interrupted())));
  await f.store.upload(candidate.id, Readable.from([f.bytes]));
  await f.store.removeCandidate(candidate.id);
  await assert.rejects(readFile(join(f.root, 'private', `${candidate.id}.bin`)), {
    code: 'ENOENT',
  });
});

test('a failed artifact activation retains the prior index and reserves identity for safe retry', async (t) => {
  const f = await fixture(t);
  const first = await f.store.createCandidate(f.index());
  await f.store.upload(first.id, Readable.from([f.bytes]));
  await f.store.activate(first.id);
  const next = await f.store.createCandidate(f.index(2, 2));
  await f.store.upload(next.id, Readable.from([f.bytes]));
  const path = join(f.root, 'public/artifacts/2/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'invalid');
  const before = f.store.channel('pilot');
  await assert.rejects(f.store.activate(next.id));
  assert.deepEqual(f.store.channel('pilot'), before);
  await rm(path);
  await f.reopen();
  await f.store.activate(next.id);
  assert.equal(verifyIndex(f.store.channel('pilot')!, f.keys).payload.release!.build, 2);
});

test('a second writer cannot share the data directory; unfinished uploads are removed on restart', async (t) => {
  const f = await fixture(t);
  await assert.rejects(UpdateStore.open(f.root, f.keys, 'second'), /locked/);
  await writeFile(join(f.root, 'private', 'leftover.part'), 'interrupted');
  await f.reopen();
  await assert.rejects(readFile(join(f.root, 'private', 'leftover.part')), { code: 'ENOENT' });
});

test(
  'OS releases the exclusive writer lock after a process is killed',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await f.store.close();
    const moduleUrl = new URL('../src/store.ts', import.meta.url).href;
    const script = `import { UpdateStore } from ${JSON.stringify(moduleUrl)}; await UpdateStore.open(process.argv[1], {}, 'child'); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const ready = await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => {
        throw new Error('Lock fixture failed to start.');
      }),
    ]);
    assert.equal(String(ready[0]), 'ready');
    await assert.rejects(UpdateStore.open(f.root, f.keys, 'second'), /locked/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await f.reopen();
    assert.equal(f.store.status().channels.length, 0);
  },
);

test('concurrent mutations are rejected and unsigned or unbounded candidates never enter storage', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.createCandidate(Buffer.from('{}')));
  await assert.rejects(f.store.createCandidate(Buffer.alloc(65537)));
  const candidate = await f.store.createCandidate(f.index());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* blocked() {
    await gate;
    yield f.bytes;
  }
  const upload = f.store.upload(candidate.id, Readable.from(blocked()));
  await assert.rejects(f.store.activate(candidate.id), /busy/);
  release();
  await upload;
  for (let i = 0; i < 7; i++) await f.store.createCandidate(f.index(i + 2));
  await assert.rejects(f.store.createCandidate(f.index(9)), /limit/);
});
