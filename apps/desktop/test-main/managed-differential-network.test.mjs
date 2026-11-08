import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import network from '../electron/managed-network.cjs';
import contract from '../electron/managed-differential-contract.cjs';

const origin = 'https://example.com';
const coords = { build: 34, appVersion: '1.2.3', filename: 'CC-Space-Setup-1.2.3-x64.exe' };
function response(chunks = [], options = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      if (!options.stall) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    status: options.status ?? 200,
    headers: new Headers(options.headers),
    body,
    get cancelled() {
      return cancelled;
    },
  };
}

test('fetches exact signed-coordinate metadata paths with identity encoding', async () => {
  const calls = [];
  const client = network.createNetwork(async (url, options) => {
    calls.push({ url, options });
    return response(['a', 'bc'], { headers: { 'content-length': '3' } });
  }, origin);
  assert.deepEqual(await client.descriptor(coords), Buffer.from('abc'));
  assert.deepEqual(await client.blockmap(coords), Buffer.from('abc'));
  assert.deepEqual(
    calls.map((c) => c.url),
    [origin + contract.descriptorPath(coords), origin + contract.blockmapPath(coords)],
  );
  for (const call of calls) {
    assert.equal(call.options.headers['Accept-Encoding'], 'identity');
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.credentials, 'omit');
  }
});

test('only descriptor 404 is optional', async () => {
  const client = network.createNetwork(async () => response([], { status: 404 }), origin);
  assert.equal(await client.descriptor(coords), null);
  await assert.rejects(client.blockmap(coords));
});

for (const kind of ['descriptor', 'blockmap']) {
  const limit = kind === 'descriptor' ? 16 * 1024 : 4 * 1024 * 1024;
  for (const [name, options, chunks] of [
    ['401', { status: 401 }, []],
    ['redirect', { status: 302, headers: { location: '/elsewhere' } }, []],
    ['partial', { status: 206 }, []],
    ['compression', { headers: { 'content-encoding': 'gzip' } }, ['a']],
    ['invalid length', { headers: { 'content-length': '1e2' } }, ['a']],
    ['excess declared length', { headers: { 'content-length': String(limit + 1) } }, []],
    ['short declared length', { headers: { 'content-length': '4' } }, ['abc']],
    ['long declared length', { headers: { 'content-length': '2' } }, ['abc']],
    ['stream overflow', { stall: true }, [Buffer.alloc(limit), Buffer.alloc(1)]],
  ])
    test(`${kind} rejects ${name}`, async () => {
      const result = response(chunks, options);
      let calls = 0;
      const client = network.createNetwork(async () => {
        calls++;
        return result;
      }, origin);
      await assert.rejects(client[kind](coords));
      assert.equal(calls, 1);
      if (options.stall) assert.equal(result.cancelled, true);
    });

  test(`${kind} accepts exact byte cap`, async () => {
    const client = network.createNetwork(
      async () => response([Buffer.alloc(limit)], { headers: { 'content-length': String(limit) } }),
      origin,
    );
    assert.equal((await client[kind](coords)).length, limit);
  });

  test(`${kind} rejects unsafe coordinates without fetching`, async () => {
    let calls = 0;
    const client = network.createNetwork(async () => {
      calls++;
      return response();
    }, origin);
    await assert.rejects(client[kind]({ ...coords, filename: '../secret' }));
    assert.equal(calls, 0);
  });

  test(`${kind} rejects pre-aborted signal without fetching`, async () => {
    let calls = 0;
    const client = network.createNetwork(async () => {
      calls++;
      return response();
    }, origin);
    await assert.rejects(client[kind](coords, AbortSignal.abort()), { name: 'AbortError' });
    assert.equal(calls, 0);
  });

  test(`${kind} removes abort listeners after many small chunks`, async () => {
    let signal;
    const client = network.createNetwork(async (_url, options) => {
      signal = options.signal;
      return response(Array.from({ length: 1000 }, () => 'a'));
    }, origin);
    assert.equal((await client[kind](coords)).length, 1000);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  });

  test(`${kind} cancels stalled reader immediately even fetch ignores signal`, async () => {
    const abort = new AbortController();
    const result = response([], { stall: true });
    const client = network.createNetwork(async () => result, origin);
    const pending = client[kind](coords, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(result.cancelled, true);
  });

  test(`${kind} aborts ignored pending fetch and cancels late response`, async () => {
    const abort = new AbortController();
    let finish;
    const client = network.createNetwork(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      origin,
    );
    const pending = client[kind](coords, abort.signal);
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const result = response([], { stall: true });
    finish(result);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.cancelled, true);
  });
}

test('metadata deadline rejects stalled reader after 20 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = response([], { stall: true });
  const client = network.createNetwork(async () => result, origin);
  const pending = client.descriptor(coords);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20001);
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.equal(result.cancelled, true);
});

test('metadata deadline rejects fetch that ignores its signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = network.createNetwork(() => new Promise(() => {}), origin);
  const pending = client.descriptor(coords);
  t.mock.timers.tick(20001);
  await assert.rejects(pending, { name: 'TimeoutError' });
});
