import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, request as httpsRequest } from 'node:https';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
const require = createRequire(import.meta.url);
const load = () => require('../electron/managed-differential.cjs');
const oldBytes = Buffer.from('AAAABBBBCCCC');
const newBytes = Buffer.from('AAAAXXXXCCCC');
const map = (checksums) => ({
  version: '2',
  files: [{ name: 'file', offset: 0, sizes: [4, 4, 4], checksums }],
});
const oldBlockMap = map(['a', 'b', 'c']);
const newBlockMap = map(['a', 'x', 'c']);
async function fixture(t, mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'managed-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldFile = join(root, 'old.exe'),
    newFile = join(root, 'new.partial');
  await writeFile(oldFile, oldBytes);
  const controller = new AbortController();
  const active = new Set();
  const requests = [];
  const createRequest = ({ url, headers }) => {
    assert.equal(url, 'https://updates.test/installer.exe');
    assert.equal(headers['accept-encoding'], 'identity');
    const req = new EventEmitter();
    requests.push(req);
    active.add(req);
    req.abort = () => {
      active.delete(req);
      req.emit('abort');
      req.emit('close');
    };
    req.end = () =>
      setImmediate(() => {
        if (!active.has(req)) return;
        if (mode === 'no-headers') {
          setTimeout(() => controller.abort(), 20);
          return;
        }
        if (mode === 'redirect') {
          req.emit('redirect', 302, 'GET', 'https://evil.test/file');
          return;
        }
        const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(headers.range);
        const start = +s,
          end = +e;
        const res = new PassThrough();
        req.response = res;
        res.statusCode = mode === '200' ? 200 : 206;
        res.headers = {
          'content-range': `bytes ${start}-${end}/${newBytes.length}`,
          'content-length': String(end - start + 1),
        };
        if (mode === 'range') res.headers['content-range'] = 'bytes 0-1/12';
        if (mode === 'length') res.headers['content-length'] = '5';
        if (mode === 'encoding') res.headers['content-encoding'] = 'gzip';
        if (mode === 'array') res.headers['content-length'] = ['4', '4'];
        res.once('close', () => {
          active.delete(req);
          req.emit('close');
        });
        req.emit('response', res);
        if (mode === 'stall') {
          setTimeout(() => controller.abort(), 20);
          return;
        }
        if (res.destroyed) return;
        let body = newBytes.subarray(start, end + 1);
        if (mode === 'short') body = body.subarray(1);
        if (mode === 'oversized') body = Buffer.concat([body, Buffer.from('!')]);
        res.end(body);
      });
    return req;
  };
  return {
    root,
    active,
    requests,
    controller,
    opts: {
      oldFile,
      newFile,
      newUrl: new URL('https://updates.test/installer.exe'),
      size: newBytes.length,
      sha512: createHash('sha512').update(newBytes).digest('base64'),
      oldBlockMap,
      newBlockMap,
      signal: controller.signal,
      onProgress: () => {},
      createRequest,
    },
  };
}
test(
  'engine exports pinned mature planning and reconstructs verified bytes',
  { timeout: 3000 },
  async (t) => {
    const { runDifferential, estimateDifferential } = load();
    assert.deepEqual(estimateDifferential(oldBlockMap, newBlockMap), {
      downloadBytes: 4,
      copyBytes: 8,
    });
    const f = await fixture(t);
    await runDifferential(f.opts);
    assert.deepEqual(await readFile(f.opts.newFile), newBytes);
    assert.deepEqual(await readFile(f.opts.oldFile), oldBytes);
    assert.equal(f.active.size, 0);
  },
);
for (const mode of [
  '200',
  'range',
  'length',
  'encoding',
  'array',
  'short',
  'oversized',
  'redirect',
  'stall',
  'no-headers',
])
  test(`rejects ${mode} and settles requests`, { timeout: 3000 }, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(load().runDifferential(f.opts));
    assert.equal(f.active.size, 0);
    assert.deepEqual(await readFile(f.opts.oldFile), oldBytes);
  });
test('rejects a linked ancestor without changing original bytes', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    load().runDifferential({ ...f.opts, newFile: join(alias, 'unsafe.partial') }),
    /link/i,
  );
  assert.deepEqual(await readFile(f.opts.oldFile), oldBytes);
});
test('rejects wrong SHA512', { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  f.opts.sha512 = Buffer.alloc(64).toString('base64');
  await assert.rejects(load().runDifferential(f.opts), /checksum/i);
});
test('cancellation before start never opens a request', async (t) => {
  const f = await fixture(t);
  f.controller.abort();
  await assert.rejects(load().runDifferential(f.opts), /cancel/i);
  assert.equal(f.requests.length, 0);
});
test('rejects source output alias and hardlinks before truncation', async (t) => {
  const f = await fixture(t);
  const { runDifferential } = load();
  await assert.rejects(runDifferential({ ...f.opts, newFile: f.opts.oldFile }));
  await link(f.opts.oldFile, f.opts.newFile);
  await assert.rejects(runDifferential(f.opts));
  await assert.rejects(
    runDifferential({ ...f.opts, newUrl: new URL('https://updates.test/installer.exe?q=1') }),
  );
  assert.deepEqual(await readFile(f.opts.oldFile), oldBytes);
});
test('rejects inconsistent map size before opening output', async (t) => {
  const f = await fixture(t);
  await assert.rejects(load().runDifferential({ ...f.opts, size: 99 }));
  assert.equal(f.requests.length, 0);
});
test('cancels during a pure cache copy with no HTTP requests', { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(32 * 1024 * 1024, 0x61);
  await writeFile(f.opts.oldFile, bytes);
  const copyMap = {
    version: '2',
    files: [{ name: 'file', offset: 0, sizes: [bytes.length], checksums: ['same'] }],
  };
  const promise = load().runDifferential({
    ...f.opts,
    size: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64'),
    oldBlockMap: copyMap,
    newBlockMap: copyMap,
  });
  setTimeout(() => f.controller.abort(), 10);
  await assert.rejects(promise, /cancel/i);
  assert.equal(f.requests.length, 0);
});
test(
  'real HTTPS reconstructs with the narrow Electron request interface',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t);
    const server = createServer(defaultCertificate, (request, response) => {
      assert.equal(request.headers['accept-encoding'], 'identity');
      assert.equal(request.headers.range, 'bytes=4-7');
      response.writeHead(206, { 'content-range': 'bytes 4-7/12', 'content-length': '4' });
      response.end(newBytes.subarray(4, 8));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = new URL(`https://127.0.0.1:${server.address().port}/installer.exe`);
    await load().runDifferential({
      ...f.opts,
      newUrl: url,
      createRequest: ({ url, headers }) => {
        const native = httpsRequest(url, {
          headers,
          ca: defaultCertificate.cert,
          servername: 'default.example.test',
        });
        const wrapper = new EventEmitter();
        for (const event of ['response', 'error', 'close', 'abort'])
          native.on(event, (...args) => wrapper.emit(event, ...args));
        wrapper.end = () => native.end();
        wrapper.abort = () => native.destroy();
        return wrapper;
      },
    });
    assert.deepEqual(await readFile(f.opts.newFile), newBytes);
  },
);
