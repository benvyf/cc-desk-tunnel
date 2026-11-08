import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as contract from '../../../packages/managed-updates/src/index.ts';
const require = createRequire(import.meta.url);
const { ManagedController } = require('../electron/managed-controller.cjs');
const { signDescriptor } = require('../electron/managed-differential-contract.cjs');
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-managed-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = { fixture: publicKey.export({ type: 'spki', format: 'pem' }) };
  const old = Buffer.alloc(512 * 1024, 7),
    bytes = Buffer.from(old);
  bytes.fill(9, bytes.length - 8192);
  const seed = join(root, 'stock.exe'),
    target = join(root, 'target.exe');
  await writeFile(seed, old);
  await writeFile(target, bytes);
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
  await buildBlockMap(seed, 'gzip', seed + '.blockmap');
  await buildBlockMap(target, 'gzip', target + '.blockmap');
  const maps = [await readFile(seed + '.blockmap'), await readFile(target + '.blockmap')];
  const base = {
    build: 34,
    appVersion: '0.3.10',
    protocol: 24,
    sourceCommit: 'b'.repeat(40),
    filename: 'CC-Space-Setup-0.3.10-x64.exe',
    size: old.length,
    sha256: hash(old),
  };
  const release = {
    ...base,
    build: 35,
    sourceCommit: 'a'.repeat(40),
    sha256: hash(bytes),
    notes: '',
  };
  const identity = {
    product: contract.PRODUCT,
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    build: 34,
    appVersion: base.appVersion,
    protocol: 24,
    sourceCommit: base.sourceCommit,
    origin: 'https://fixture.invalid',
    trustedKeys: keys,
  };
  const descriptors = [base, release].map((r, i) =>
    signDescriptor(
      {
        schema: 1,
        product: 'cc-space-nsis-differential',
        channel: 'pilot',
        platform: 'win32',
        arch: 'x64',
        release: Object.fromEntries(
          ['build', 'appVersion', 'protocol', 'sourceCommit', 'filename', 'size', 'sha256'].map(
            (k) => [k, r[k]],
          ),
        ),
        sha512: createHash('sha512')
          .update(i ? bytes : old)
          .digest('base64'),
        blockmap: { size: maps[i].length, sha256: hash(maps[i]), format: 'gzip-json-v2' },
      },
      'fixture',
      privateKey,
    ),
  );
  let index = contract.signIndex(
    {
      schema: 1,
      product: contract.PRODUCT,
      channel: 'pilot',
      platform: 'win32',
      arch: 'x64',
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      state: 'published',
      release,
    },
    'fixture',
    privateKey,
  );
  const calls = { full: 0, ranges: 0, launch: 0 };
  let mode = 'normal',
    controller;
  const network = {
    index: async () => index,
    descriptor: async (c) => descriptors[c.build === 34 ? 0 : 1],
    blockmap: async (c) => maps[c.build === 34 ? 0 : 1],
    download: async (_url, file) => {
      calls.full++;
      await writeFile(file, bytes);
    },
  };
  const createRequest = ({ headers }) => {
    const req = new EventEmitter();
    req.abort = () => req.emit('close');
    req.end = () =>
      setImmediate(() => {
        if (mode === 'stall') {
          setTimeout(() => controller.cancel(), 10);
          return;
        }
        calls.ranges++;
        const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(headers.range),
          start = +s,
          end = +e;
        const res = new PassThrough();
        res.statusCode = mode === 'bad-range' ? 200 : 206;
        res.headers = {
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          'content-length': String(end - start + 1),
        };
        req.emit('response', res);
        if (!res.destroyed) res.end(bytes.subarray(start, end + 1));
      });
    return req;
  };
  controller = new ManagedController({
    identity,
    executable: join(root, 'app', 'CC Space.exe'),
    localAppData: root,
    contract,
    network,
    seedPaths: [seed],
    createDifferentialRequest: createRequest,
    processes: async () => [process.pid],
    launchInstaller: async () => {
      calls.launch++;
      return 987654321;
    },
    quit: () => {},
    lockName:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-managed-${randomUUID()}`
        : join(root, 'lock.sock'),
  });
  controller.report({ blocked: false });
  t.after(() => controller.stop());
  return {
    root,
    seed,
    release,
    controller,
    network,
    calls,
    bytes,
    mode: (value) => (mode = value),
    withdraw: () => {
      index = contract.signIndex(
        {
          schema: 1,
          product: contract.PRODUCT,
          channel: 'pilot',
          platform: 'win32',
          arch: 'x64',
          revision: 2,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          state: 'empty',
          release: null,
        },
        'fixture',
        privateKey,
      );
    },
  };
}
test('same app version with higher Build automatically reconstructs installer and preserves current baseline', async (t) => {
  const f = await fixture(t);
  const state = await f.controller.download();
  assert.equal(state.downloadMode, 'differential');
  assert.equal(f.calls.full, 0);
  assert.ok(f.calls.ranges > 0);
  assert.deepEqual(await readFile(f.controller.file('ready.exe')), f.bytes);
  const pointer = JSON.parse(await readFile(f.controller.file('baseline.json')));
  assert.ok(pointer.name.startsWith('base-34-'));
  f.controller.report({ blocked: false });
  await f.controller.install();
  assert.equal(f.calls.launch, 1);
});
test('missing metadata or invalid Range falls back to original complete download with isolated partials', async (t) => {
  for (const mode of ['missing', 'bad-range']) {
    const f = await fixture(t);
    if (mode === 'missing') f.network.descriptor = async () => null;
    else f.mode(mode);
    const state = await f.controller.download();
    assert.equal(state.phase, 'ready');
    assert.equal(f.calls.full, 1);
    assert.deepEqual(await readFile(f.controller.file('ready.exe')), f.bytes);
    assert.ok(!(await readdir(f.controller.directory)).some((n) => n.startsWith('differential-')));
  }
});
test('cancelled stalled differential never becomes a complete download', async (t) => {
  const f = await fixture(t);
  f.mode('stall');
  await assert.rejects(f.controller.download());
  assert.equal(f.calls.full, 0);
  assert.ok(!(await readdir(f.controller.directory)).some((n) => n.startsWith('differential-')));
});
test('withdrawal after reconstruction still blocks installation', async (t) => {
  const f = await fixture(t);
  await f.controller.download();
  f.withdraw();
  await assert.rejects(f.controller.install(), /撤回|改变/);
  assert.equal(f.calls.launch, 0);
});

test('cancel during the final installer hash cannot publish a ready update', async (t) => {
  const f = await fixture(t);
  const fs = require('node:fs');
  const original = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (file, ...args) => {
    const stream = original(file, ...args);
    if (String(file).includes('differential-')) stream.once('data', () => f.controller.cancel());
    return stream;
  });
  await assert.rejects(f.controller.download());
  assert.notEqual(f.controller.state().phase, 'ready');
  assert.equal(f.calls.full, 0);
});
