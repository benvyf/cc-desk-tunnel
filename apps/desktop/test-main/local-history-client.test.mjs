import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProxyClient } from '../src/client.ts';
const settle = () => new Promise((r) => setTimeout(r, 15));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture(t, read) {
  const oldSocket = globalThis.WebSocket,
    oldWindow = globalThis.window;
  const calls = [];
  const api = Object.fromEntries(
    ['open', 'append', 'replace', 'remove', 'retain', 'clear', 'protect', 'log'].map((name) => [
      name,
      async (...args) => {
        calls.push([name, ...args]);
      },
    ]),
  );
  api.read = async (id) => {
    calls.push(['read', id]);
    return typeof read === 'function' ? read(id) : read;
  };
  globalThis.window = { desktop: { historyCache: api } };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() {
      Socket.current = this;
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.onclose?.({ code: 1000 });
    }
    message(value) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  globalThis.WebSocket = Socket;
  const client = new ProxyClient();
  const sessions = Array.from({ length: 2 }, (_, i) => ({
    id: randomUUID(),
    title: `session ${i}`,
    autoTitle: false,
    projectPath: 'D:/test',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRun: null,
  }));
  const event = (sequence, id = sessions[0].id) => ({
    sessionId: id,
    sequence,
    runId: sessions[0].id,
    createdAt: sessions[0].createdAt,
    payload: { type: 'text.delta', messageId: sessions[0].id, text: `event ${sequence}` },
  });
  const ready = () =>
    Socket.current.message({
      type: 'ready',
      protocolVersion: 24,
      version: '0.3.10',
      connectionId: randomUUID(),
      adapter: 'simulation',
      sessions,
      sideConversations: true,
    });
  const connect = async (owner = 'email|user@example.org|one') => {
    client.connect(
      'ws://127.0.0.1/ws',
      'test-token-with-enough-characters',
      { id: 'pc', name: 'pc' },
      true,
      undefined,
      owner,
    );
    await settle();
    ready();
    await settle();
    return Socket.current;
  };
  const snapshot = (socket, events, mode = 'append') => {
    const request = socket.sent.findLast((f) => f.type === 'session.subscribe');
    socket.message({
      type: 'session.snapshot',
      session: sessions[0],
      requestId: request.requestId,
      mode,
      events,
      firstSequence: events[0]?.sequence ?? 0,
      lastSequence: events.at(-1)?.sequence ?? 2,
      hasEarlier: false,
    });
    socket.message({ type: 'response', requestId: request.requestId, ok: true });
  };
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = oldSocket;
    globalThis.window = oldWindow;
  });
  return { client, sessions, calls, api, event, connect, snapshot, ready, Socket };
}
test('hydrates before subscribing with cached cursor; delta equals uncached authoritative history', async (t) => {
  const f = fixture(t);
  f.api.read = async () => ({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(socket.sent.at(-1).afterSequence, 1);
  assert.equal(f.client.state.history[f.sessions[0].id].loading, true);
  assert.deepEqual(f.client.state.events[f.sessions[0].id], [f.event(1)]);
  f.snapshot(socket, [f.event(2)]);
  await settle();
  assert.deepEqual(f.client.state.events[f.sessions[0].id], [f.event(1), f.event(2)]);
  assert.equal(f.calls.filter((c) => c[0] === 'append').length, 1);
});
test('authoritative replace discards cached contents', async (t) => {
  const f = fixture(t);
  f.api.read = async () => ({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  f.snapshot(socket, [f.event(9)], 'replace');
  await settle();
  assert.deepEqual(f.client.state.events[f.sessions[0].id], [f.event(9)]);
  assert.equal(f.calls.filter((c) => c[0] === 'replace').length, 1);
});
for (const race of ['selection', 'socket', 'history'])
  test(`discards delayed hydration after ${race} changes`, async (t) => {
    const pending = deferred();
    const f = fixture(t, () => pending.promise);
    await f.connect();
    f.client.select(f.sessions[0].id);
    if (race === 'selection') f.client.select(f.sessions[1].id);
    if (race === 'socket') f.client.socket = null;
    if (race === 'history')
      f.client.update({
        history: {
          [f.sessions[0].id]: {
            loaded: true,
            firstSequence: 7,
            lastSequence: 7,
            hasEarlier: false,
            loading: false,
            loadingEarlier: false,
          },
        },
        events: { [f.sessions[0].id]: [f.event(7)] },
      });
    pending.resolve({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
    await settle();
    assert.notEqual(f.client.state.events[f.sessions[0].id]?.[0]?.sequence, 1);
  });
test('merges concurrent disk reads; reconnecting select hydrates without subscribing', async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  const socket = await f.connect();
  socket.close();
  f.client.select(f.sessions[0].id);
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(f.calls.filter((c) => c[0] === 'read').length, 1);
  pending.resolve({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  await settle();
  assert.equal(f.client.state.events[f.sessions[0].id].length, 1);
  assert.equal(socket.sent.filter((f) => f.type === 'session.subscribe').length, 0);
});
test('unsynced streams and a snapshot rejected after timeout never write disk', async (t) => {
  const f = fixture(t, null);
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  const request = socket.sent.at(-1);
  const pending = f.client.pending.get(request.requestId);
  clearTimeout(pending.timer);
  f.client.pending.delete(request.requestId);
  pending.reject(new Error('timeout'));
  await settle();
  f.snapshot(socket, [f.event(1)], 'replace');
  socket.message({ type: 'session.event', event: f.event(7) });
  f.client.select(f.sessions[0].id);
  await settle();
  f.client.flushHistoryCache();
  await settle();
  assert.equal(f.calls.filter((c) => ['append', 'replace'].includes(c[0])).length, 0);
});
test('invalid_cursor removes the copy and silently retries from zero exactly once', async (t) => {
  const f = fixture(t);
  f.api.read = async () => ({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  socket.message({
    type: 'response',
    requestId: socket.sent.at(-1).requestId,
    ok: false,
    code: 'invalid_cursor',
    message: 'bad cursor',
  });
  await settle();
  assert.equal(socket.sent.at(-1).afterSequence, 0);
  assert.equal(f.client.state.error, null);
  assert.ok(f.calls.some((c) => c[0] === 'remove'));
  socket.message({
    type: 'response',
    requestId: socket.sent.at(-1).requestId,
    ok: false,
    code: 'invalid_cursor',
    message: 'bad cursor',
  });
  await settle();
  assert.equal(socket.sent.filter((f) => f.type === 'session.subscribe').length, 2);
});
test('ready reconciles and deleted sessions remove copies', async (t) => {
  const f = fixture(t, null);
  const socket = await f.connect();
  assert.ok(f.calls.some((c) => c[0] === 'retain' && c[1].includes(f.sessions[0].id)));
  socket.message({ type: 'session.deleted', sessionId: f.sessions[0].id });
  await settle();
  assert.ok(f.calls.some((c) => c[0] === 'remove' && c[1] === f.sessions[0].id));
});
test('missing owner and browser connections never read or write cache', async (t) => {
  const f = fixture(t, null);
  const socket = await f.connect(null);
  f.client.select(f.sessions[0].id);
  await settle();
  // Explicitly reconnect without a reliable owner (the helper's default is deliberately bypassed).
  f.calls.length = 0;
  f.client.connect('ws://127.0.0.1/ws', 'test-token-with-enough-characters', {
    id: 'pc',
    name: 'pc',
  });
  await settle();
  f.ready();
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(f.calls.length, 0);
  globalThis.location = { protocol: 'http:', host: '127.0.0.1' };
  t.after(() => delete globalThis.location);
  f.client.connectBrowser('ws://127.0.0.1/ws', () => {});
  f.ready();
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.ok(socket);
});

test('synced streaming writes are batched, omit fragments and flush before disconnect', async (t) => {
  const f = fixture(t, null),
    socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  f.snapshot(socket, [f.event(1)], 'replace');
  await settle();
  f.calls.length = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  socket.message({
    type: 'session.fragment',
    sessionId: f.sessions[0].id,
    runId: f.sessions[0].id,
    payload: { type: 'text.delta', messageId: f.sessions[0].id, text: 'unfinished' },
  });
  socket.message({
    type: 'session.fragment',
    sessionId: f.sessions[0].id,
    runId: f.sessions[0].id,
    payload: { type: 'native.progress', taskId: 'task', text: 'progress' },
  });
  socket.message({ type: 'session.event', event: f.event(2) });
  t.mock.timers.tick(32);
  assert.equal(f.calls.filter((c) => c[0] === 'append').length, 0);
  t.mock.timers.tick(999);
  assert.equal(f.calls.filter((c) => c[0] === 'append').length, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(f.calls.filter((c) => c[0] === 'append')[0]?.[2], [f.event(2)]);
  socket.message({ type: 'session.event', event: f.event(3) });
  t.mock.timers.tick(32);
  await Promise.resolve();
  f.client.disconnect();
  assert.ok(f.calls.some((c) => c[0] === 'replace' && c[2].events.some((e) => e.sequence === 3)));
});
test('close invalidates synced before buffered streams can persist and disabling rejects a pending read', async (t) => {
  const f = fixture(t, null),
    socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  f.snapshot(socket, [f.event(1)], 'replace');
  await settle();
  f.calls.length = 0;
  socket.message({ type: 'session.event', event: f.event(2) });
  socket.close();
  f.client.flushHistoryCache();
  await settle();
  assert.equal(f.calls.filter((c) => ['append', 'replace'].includes(c[0])).length, 0);
  const pending = deferred();
  f.api.read = () => pending.promise;
  f.client.select(f.sessions[1].id);
  await f.client.setHistoryCacheEnabled(false);
  pending.resolve({ firstSequence: 1, hasEarlier: false, events: [f.event(1, f.sessions[1].id)] });
  await settle();
  assert.equal(f.client.state.events[f.sessions[1].id], undefined);
  assert.ok(f.calls.some((c) => c[0] === 'clear'));
});
test('sampled schema failure removes the copy and subscribes from zero; cache open failure falls back', async (t) => {
  const f = fixture(t, { firstSequence: 1, hasEarlier: false, events: [{ sequence: 1 }] });
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(socket.sent.at(-1).afterSequence, 0);
  assert.ok(f.calls.some((c) => c[0] === 'remove'));
  f.api.open = async () => {
    throw Error('disk unavailable');
  };
  await f.connect();
  f.client.select(f.sessions[0].id);
  assert.equal(f.Socket.current.sent.at(-1).afterSequence, 0);
  assert.equal(f.client.state.error, null);
});

test('not_found removes the copy and prepend rewrites the complete proven window', async (t) => {
  const f = fixture(t, null),
    socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  f.snapshot(socket, [f.event(7)], 'replace');
  await settle();
  f.client.update({
    history: {
      [f.sessions[0].id]: { ...f.client.state.history[f.sessions[0].id], hasEarlier: true },
    },
  });
  const earlier = f.client.loadEarlier(f.sessions[0].id);
  const request = socket.sent.at(-1);
  socket.message({
    type: 'session.snapshot',
    requestId: request.requestId,
    session: f.sessions[0],
    mode: 'prepend',
    firstSequence: 1,
    lastSequence: 1,
    hasEarlier: false,
    events: [f.event(1)],
  });
  socket.message({ type: 'response', requestId: request.requestId, ok: true });
  await earlier;
  await settle();
  assert.deepEqual(f.calls.filter((c) => c[0] === 'replace').at(-1)[2].events, [
    f.event(1),
    f.event(7),
  ]);
  f.client.select(f.sessions[0].id);
  await settle();
  socket.message({
    type: 'response',
    requestId: socket.sent.at(-1).requestId,
    ok: false,
    code: 'not_found',
    message: 'missing',
  });
  await settle();
  assert.ok(f.calls.some((c) => c[0] === 'remove'));
});
test('observed sessions hydrate before their retained subscription and closing the pane discards pending hydration', async (t) => {
  const f = fixture(t);
  f.api.read = async (id) => ({ firstSequence: 1, hasEarlier: false, events: [f.event(1, id)] });
  const socket = await f.connect();
  const stop = f.client.observeSession(f.sessions[1].id);
  await settle();
  assert.equal(socket.sent.at(-1).afterSequence, 1);
  assert.equal(socket.sent.at(-1).retain, true);
  stop();
});
test('a retry after a timed-out snapshot never advances past the known disk cursor', async (t) => {
  const f = fixture(t, null),
    socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  const request = socket.sent.at(-1),
    pending = f.client.pending.get(request.requestId);
  clearTimeout(pending.timer);
  f.client.pending.delete(request.requestId);
  pending.reject(Error('timeout'));
  await settle();
  socket.message({ type: 'session.event', event: f.event(7) });
  await new Promise((r) => setTimeout(r, 40));
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(socket.sent.at(-1).afterSequence, 0);
});

test('eviction followed by a missing disk copy must subscribe from zero, never a stale persisted cursor', async (t) => {
  const f = fixture(t);
  f.api.read = async (id) => ({ firstSequence: 1, hasEarlier: false, events: [f.event(1, id)] });
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  await settle();
  f.snapshot(socket, [f.event(2)]);
  await settle();
  for (let i = 0; i < 4; i++) f.sessions.push({ ...f.sessions[0], id: randomUUID() });
  f.client.update({ sessions: f.sessions });
  for (const session of f.sessions.slice(1, 5)) {
    f.client.select(session.id);
    await settle();
  }
  assert.equal(f.client.state.history[f.sessions[0].id], undefined);
  f.api.read = async () => null;
  f.client.select(f.sessions[0].id);
  await settle();
  assert.equal(socket.sent.at(-1).afterSequence, 0);
});
test('disabling cache while open is pending still allows the network connection to start', async (t) => {
  const f = fixture(t),
    pending = deferred();
  f.api.open = () => pending.promise;
  f.client.connect(
    'ws://127.0.0.1/ws',
    'test-token-with-enough-characters',
    { id: 'pc', name: 'pc' },
    true,
    undefined,
    'local|one',
  );
  await f.client.setHistoryCacheEnabled(false);
  pending.resolve();
  await settle();
  assert.ok(f.Socket.current);
  assert.equal(f.client.historyCacheReady, false);
});

test('ready replaces an in-flight reconnecting hydration and always subscribes on the new socket', async (t) => {
  const pending = deferred(),
    f = fixture(t, () => pending.promise);
  const old = await f.connect();
  old.close();
  f.client.select(f.sessions[0].id);
  await settle();
  f.client.retryNow();
  f.ready();
  pending.resolve({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  await settle();
  assert.ok(f.Socket.current.sent.some((frame) => frame.type === 'session.subscribe'));
});

test('hydration derives retain from the current selected/observed role after awaiting disk', async (t) => {
  const pending = deferred(),
    f = fixture(t);
  f.api.read = async (id) => (id === f.sessions[0].id ? pending.promise : null);
  const socket = await f.connect();
  f.client.select(f.sessions[0].id);
  f.client.select(f.sessions[1].id);
  f.client.observeSession(f.sessions[0].id);
  await settle();
  pending.resolve({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  await settle();
  const subscription = socket.sent.findLast(
    (frame) => frame.type === 'session.subscribe' && frame.sessionId === f.sessions[0].id,
  );
  assert.equal(subscription.retain, true);
});

test('a global stream frame during disk hydration cannot suppress the authoritative subscription', async (t) => {
  const pending = deferred(),
    f = fixture(t, () => pending.promise),
    socket = await f.connect();
  f.client.select(f.sessions[0].id);
  socket.message({ type: 'session.event', event: f.event(7) });
  await new Promise((r) => setTimeout(r, 40));
  pending.resolve({ firstSequence: 1, hasEarlier: false, events: [f.event(1)] });
  await settle();
  assert.equal(
    socket.sent.findLast((frame) => frame.type === 'session.subscribe')?.afterSequence,
    0,
  );
});
