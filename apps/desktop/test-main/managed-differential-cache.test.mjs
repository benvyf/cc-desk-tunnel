import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-nsis-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'cache');
  await mkdir(directory);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) };
  const bytes = Buffer.alloc(16384, 7),
    seed = join(root, 'seed.exe');
  await writeFile(seed, bytes);
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
  await buildBlockMap(seed, 'gzip', join(root, 'map'));
  const map = await readFile(join(root, 'map'));
  const release = {
    build: 34,
    appVersion: '0.3.10',
    protocol: 24,
    sourceCommit: 'b'.repeat(40),
    filename: 'CC-Space-Setup-0.3.10-x64.exe',
    size: bytes.length,
    sha256: hash(bytes),
  };
  const identity = {
    product: 'cc-desk-tunnel-managed',
    ...release,
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    trustedKeys: keys,
  };
  const { signDescriptor } = require('../electron/managed-differential-contract.cjs');
  const descriptor = {
    schema: 1,
    product: 'cc-space-nsis-differential',
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    release,
    sha512: createHash('sha512').update(bytes).digest('base64'),
    blockmap: { size: map.length, sha256: hash(map), format: 'gzip-json-v2' },
  };
  let calls = 0;
  const network = {
    descriptor: async () => {
      calls++;
      return signDescriptor(descriptor, 'fixture', privateKey);
    },
    blockmap: async () => map,
  };
  const options = {
    identity,
    directory,
    network,
    signal: new AbortController().signal,
    seedPaths: [seed],
  };
  return { root, directory, seed, bytes, options, descriptor, network, calls: () => calls };
}
test('verified baseline is copied into a paired build/hash cache independent of original installer', async (t) => {
  const f = await fixture(t);
  const { ensureBaseline } = require('../electron/managed-differential-cache.cjs');
  const base = await ensureBaseline(f.options);
  assert.ok(base.name.includes('34-' + hash(f.bytes)));
  assert.deepEqual(await readFile(base.installer), f.bytes);
  await rm(f.seed);
  const again = await ensureBaseline({
    ...f.options,
    network: {
      descriptor: async () => {
        throw new Error('offline');
      },
    },
  });
  assert.equal(again.name, base.name);
  assert.equal(f.calls(), 1);
});
test('damaged cached bytes without a matching seed never become a valid baseline', async (t) => {
  const f = await fixture(t);
  const { ensureBaseline } = require('../electron/managed-differential-cache.cjs');
  const base = await ensureBaseline(f.options);
  await writeFile(base.installer, 'corrupt');
  await rm(f.seed);
  assert.equal(await ensureBaseline(f.options), null);
});
test('baseline promotion requires matching running identity rather than downloaded target', async (t) => {
  const f = await fixture(t);
  const { ensureBaseline } = require('../electron/managed-differential-cache.cjs');
  const base = await ensureBaseline(f.options);
  const pointer = await readFile(join(f.directory, 'baseline.json'), 'utf8');
  await assert.rejects(
    ensureBaseline({ ...f.options, identity: { ...f.options.identity, build: 35 } }),
  );
  assert.equal(await readFile(join(f.directory, 'baseline.json'), 'utf8'), pointer);
  assert.ok(await access(base.installer).then(() => true));
});
test('unsafe pointers and unavailable metadata cannot touch paths outside the owned cache', async (t) => {
  const f = await fixture(t);
  const { ensureBaseline } = require('../electron/managed-differential-cache.cjs');
  await writeFile(join(f.root, 'keep.txt'), 'keep');
  await writeFile(join(f.directory, 'baseline.json'), JSON.stringify({ name: '../' }));
  assert.equal(
    await ensureBaseline({
      ...f.options,
      network: { descriptor: async () => null },
      seedPaths: [],
    }),
    null,
  );
  assert.equal(await readFile(join(f.root, 'keep.txt'), 'utf8'), 'keep');
});

test('abandoned cache copies are reclaimed but unknown cache contents are preserved', async (t) => {
  const f = await fixture(t);
  const { ensureBaseline } = require('../electron/managed-differential-cache.cjs');
  const abandoned = `base-34-${hash(f.bytes)}-${randomUUID()}`,
    unknown = `base-34-${hash(f.bytes)}-${randomUUID()}`;
  await mkdir(join(f.directory, abandoned));
  await writeFile(join(f.directory, abandoned, 'installer.exe'), 'partial');
  await mkdir(join(f.directory, unknown));
  await writeFile(join(f.directory, unknown, 'keep.txt'), 'keep');
  const partial = `differential-35-${randomUUID()}.part`;
  await writeFile(join(f.directory, partial), 'partial');
  await ensureBaseline(f.options);
  await assert.rejects(access(join(f.directory, abandoned)), { code: 'ENOENT' });
  await assert.rejects(access(join(f.directory, partial)), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.directory, unknown, 'keep.txt'), 'utf8'), 'keep');
});
