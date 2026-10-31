import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { PROTOCOL_VERSION, type Session, type SessionEvent } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';

type Frame = { type: string; sessionId?: string; requestId?: string; retain?: boolean };
class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 1;
  sent: Frame[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor(_url: string) {
    Socket.sockets.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
function fixture(t: TestContext, capable = true) {
  const original = globalThis.WebSocket;
  Socket.sockets = [];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const client = new ProxyClient();
  const device = { id: randomUUID(), name: 'test computer' };
  const connect = () =>
    client.connect('ws://127.0.0.1/ws', 'test-token-with-enough-characters', device);
  connect();
  const now = new Date().toISOString();
  const sessions: Session[] = Array.from({ length: 10 }, (_, index) => ({
    id: randomUUID(),
    title: `session-${index}`,
    autoTitle: false,
    projectPath: 'D:\\project',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  }));
  const ready = (socket: Socket, sideConversations = capable, listed = sessions) =>
    socket.message({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      version: '0.0.1',
      connectionId: randomUUID(),
      adapter: 'simulation',
      sessions: listed,
      ...(sideConversations ? { sideConversations: true } : {}),
    });
  const socket = Socket.sockets.at(-1)!;
  ready(socket);
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = original;
  });
  function snapshot(socket: Socket, session: Session) {
    const request = socket.sent.findLast(
      (frame) => frame.type === 'session.subscribe' && frame.sessionId === session.id,
    )!;
    socket.message({
      type: 'session.snapshot',
      requestId: request.requestId,
      session,
      events: [event(session.id, 1)],
      mode: 'replace',
      firstSequence: 1,
      lastSequence: 1,
      hasEarlier: false,
    });
    socket.message({ type: 'response', requestId: request.requestId, ok: true });
  }
  return { client, socket, sessions, ready, snapshot, connect };
}
function event(sessionId: string, sequence: number): SessionEvent {
  return {
    sessionId,
    sequence,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    payload: { type: 'text.delta', messageId: randomUUID(), text: `event ${sequence}` },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 45));
const subscriptions = (socket: Socket) =>
  socket.sent.filter((frame) => frame.type === 'session.subscribe');

test('main and two observed sessions receive independent histories, events and fragments without selecting side chats', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  client.select(sessions[0].id);
  const cleanA = client.observeSession(sessions[1].id);
  const cleanB = client.observeSession(sessions[2].id);
  assert.equal(client.state.sideConversations, true);
  assert.equal(client.state.selectedId, sessions[0].id);
  assert.deepEqual(
    subscriptions(socket).map(({ sessionId, retain }) => [sessionId, retain]),
    [
      [sessions[0].id, undefined],
      [sessions[1].id, true],
      [sessions[2].id, true],
    ],
  );
  for (const session of sessions.slice(0, 3)) {
    snapshot(socket, session);
    const recorded = event(session.id, 2);
    socket.message({ type: 'session.event', event: recorded });
    socket.message({
      type: 'session.fragment',
      sessionId: session.id,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: 'live' },
    });
  }
  await settle();
  for (const session of sessions.slice(0, 3)) {
    assert.deepEqual(
      client.state.events[session.id].map((item) => item.sequence),
      [1, 2],
    );
    assert.equal(client.state.live[session.id].payload.type, 'text.delta');
  }
  assert.equal(client.state.selectedId, sessions[0].id);
  cleanA();
  cleanB();
});

test('main selection restores retained streams in order and observer cleanup is reference counted', (t) => {
  const { client, socket, sessions } = fixture(t);
  client.select(sessions[0].id);
  const first = client.observeSession(sessions[1].id);
  const second = client.observeSession(sessions[1].id);
  const selected = client.observeSession(sessions[0].id);
  assert.equal(subscriptions(socket).length, 2);
  client.select(sessions[2].id);
  assert.deepEqual(
    subscriptions(socket)
      .slice(-3)
      .map(({ sessionId, retain }) => [sessionId, retain]),
    [
      [sessions[2].id, undefined],
      [sessions[1].id, true],
      [sessions[0].id, true],
    ],
  );
  first();
  first();
  assert.equal(socket.sent.filter((frame) => frame.type === 'session.unsubscribe').length, 0);
  second();
  assert.deepEqual(socket.sent.at(-1), {
    type: 'session.unsubscribe',
    sessionId: sessions[1].id,
    requestId: socket.sent.at(-1)!.requestId,
  });
  client.select(sessions[0].id);
  const count = socket.sent.length;
  selected();
  assert.equal(socket.sent.length, count, 'selected main stream stays subscribed');
});

test('reconnect restores selected and observed histories; old nodes receive no retained commands', async (t) => {
  const { client, socket, sessions, ready, snapshot } = fixture(t);
  client.select(sessions[0].id);
  const clean = client.observeSession(sessions[1].id);
  snapshot(socket, sessions[0]);
  snapshot(socket, sessions[1]);
  socket.close();
  assert.equal(client.state.sideConversations, false);
  client.retryNow();
  const next = Socket.sockets.at(-1)!;
  ready(next);
  assert.deepEqual(
    subscriptions(next).map(({ sessionId, retain }) => [sessionId, retain]),
    [
      [sessions[0].id, undefined],
      [sessions[1].id, true],
    ],
  );
  assert.equal(client.state.selectedId, sessions[0].id);
  next.close();
  client.retryNow();
  const legacy = Socket.sockets.at(-1)!;
  ready(legacy, false);
  const unsupported = client.observeSession(sessions[2].id);
  clean();
  unsupported();
  assert.equal(client.state.sideConversations, false);
  assert.deepEqual(
    subscriptions(legacy).map(({ sessionId, retain }) => [sessionId, retain]),
    [[sessions[0].id, undefined]],
  );
  assert.equal(
    legacy.sent.some((frame) => frame.type === 'session.unsubscribe'),
    false,
  );
  await settle();
  assert.equal(client.state.error, null, 'interrupted reads cannot overwrite the new connection');
});

test('deletion and explicit reconnect invalidate observer cleanup and pending reads from the previous workspace', async (t) => {
  const { client, socket, sessions, ready, connect } = fixture(t);
  const staleDeleted = client.observeSession(sessions[1].id);
  socket.message({ type: 'session.deleted', sessionId: sessions[1].id });
  socket.message({ type: 'session.updated', session: sessions[1] });
  const replacement = client.observeSession(sessions[1].id);
  const before = socket.sent.length;
  staleDeleted();
  assert.equal(socket.sent.length, before);
  replacement();
  assert.equal(socket.sent.at(-1)!.type, 'session.unsubscribe');
  const staleWorkspace = client.observeSession(sessions[2].id);
  connect();
  assert.equal(client.state.sideConversations, false);
  const next = Socket.sockets.at(-1)!;
  ready(next);
  const current = client.observeSession(sessions[2].id);
  const count = next.sent.length;
  staleWorkspace();
  assert.equal(next.sent.length, count);
  await settle();
  assert.equal(client.state.error, null);
  current();
});

test('observed history survives main cache eviction, and side creation never selects its result', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  const clean = client.observeSession(sessions[1].id);
  snapshot(socket, sessions[1]);
  for (const session of [sessions[0], ...sessions.slice(2)]) client.select(session.id);
  assert.equal(client.state.events[sessions[1].id].length, 1);
  assert.equal(client.state.history[sessions[1].id].loaded, false);
  assert.ok(client.cacheOrder.includes(sessions[1].id));
  const selected = client.state.selectedId;
  const creation = client.request({
    type: 'session.side.create',
    sessionId: sessions[0].id,
    title: 'side',
  });
  const request = socket.sent.at(-1)!;
  const side = {
    ...sessions[1],
    sideConversation: {
      parentSessionId: sessions[0].id,
      throughSequence: 1,
      createdAt: new Date().toISOString(),
    },
  };
  socket.message({ type: 'session.updated', session: side });
  socket.message({ type: 'response', requestId: request.requestId, ok: true, sessionId: side.id });
  assert.equal((await creation).sessionId, side.id);
  assert.equal(client.state.selectedId, selected);
  clean();
});

test('reconnect without a main selection restores only existing observers and keeps the server subscription bound', (t) => {
  const { client, socket, sessions, ready } = fixture(t);
  const many = Array.from({ length: 40 }, (_, index) => ({
    ...sessions[0],
    id: randomUUID(),
    title: `observed-${index}`,
  }));
  ready(socket, true, many);
  const cleanup = many.map((session) => client.observeSession(session.id));
  assert.equal(subscriptions(socket).length, 31);
  assert.equal(client.state.selectedId, null);
  socket.close();
  client.retryNow();
  const next = Socket.sockets.at(-1)!;
  ready(next, true, many.slice(1));
  assert.equal(
    subscriptions(next).length,
    30,
    'missing observer is removed by the refreshed directory',
  );
  assert.ok(subscriptions(next).every((frame) => frame.retain === true));
  client.select(many.at(-1)!.id);
  assert.equal(
    client.cacheOrder.length,
    31,
    'every active observer and the selected main cache survives',
  );
  const count = next.sent.length;
  cleanup[0]();
  assert.equal(
    next.sent.length,
    count,
    'cleanup for a removed observer cannot issue a new request',
  );
  cleanup.slice(1).forEach((close) => close());
});

test('closing many side histories bounds the cache without changing main or active observers', async (t) => {
  const { client, socket, sessions, ready, snapshot } = fixture(t);
  const many = Array.from({ length: 40 }, (_, index) => ({
    ...sessions[0],
    id: randomUUID(),
    title: `closed-${index}`,
  }));
  ready(socket, true, [...sessions, ...many]);
  client.select(sessions[0].id);
  snapshot(socket, sessions[0]);
  const active = client.observeSession(sessions[1].id);
  snapshot(socket, sessions[1]);
  for (const session of many) {
    const close = client.observeSession(session.id);
    snapshot(socket, session);
    socket.message({
      type: 'session.fragment',
      sessionId: session.id,
      runId: randomUUID(),
      payload: { type: 'text.delta', messageId: randomUUID(), text: 'buffered before close' },
    });
    socket.message({
      type: 'session.fragment',
      sessionId: session.id,
      runId: randomUUID(),
      payload: { type: 'native.progress', taskId: 'task', summary: 'closed chat task progress' },
    });
    close();
  }
  await settle();
  assert.equal(client.state.selectedId, sessions[0].id);
  assert.equal(client.cacheOrder.length, 4);
  assert.equal(Object.keys(client.state.events).length, 4);
  assert.ok(client.state.events[sessions[0].id]);
  assert.ok(client.state.events[sessions[1].id]);
  assert.equal(
    Object.keys(client.state.live).some((id) => !client.cacheOrder.includes(id)),
    false,
    'buffered fragments cannot restore evicted histories',
  );
  assert.equal(
    Object.keys(client.state.progress).some((id) => !client.cacheOrder.includes(id)),
    false,
    'eviction also releases transient task progress',
  );
  active();
});

test('late side history replies cannot restore an evicted cache', (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  client.select(sessions[0].id);
  snapshot(socket, sessions[0]);
  for (const session of sessions.slice(1)) client.observeSession(session.id)();
  const discarded = sessions[1];
  assert.equal(client.cacheOrder.includes(discarded.id), false);
  snapshot(socket, discarded);
  assert.equal(client.state.events[discarded.id], undefined);
  assert.equal(client.state.history[discarded.id], undefined);
});

test('deleting a side conversation releases its task progress and buffered updates', async (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  client.select(sessions[0].id);
  snapshot(socket, sessions[0]);
  const close = client.observeSession(sessions[1].id);
  snapshot(socket, sessions[1]);
  const progress = {
    type: 'session.fragment',
    sessionId: sessions[1].id,
    runId: randomUUID(),
    payload: { type: 'native.progress', taskId: 'task', summary: 'deleted chat progress' },
  };
  socket.message(progress);
  await settle();
  assert.ok(client.state.progress[sessions[1].id]);
  socket.message({
    ...progress,
    payload: { ...progress.payload, summary: 'pending just before delete' },
  });
  socket.message({ type: 'session.deleted', sessionId: sessions[1].id });
  close();
  await settle();
  assert.equal(client.state.progress[sessions[1].id], undefined);
  assert.equal(client.state.events[sessions[1].id], undefined);
  assert.equal(client.state.history[sessions[1].id], undefined);
  assert.equal(client.state.selectedId, sessions[0].id);
});

test('reopening an evicted side chat loads a complete fresh history and preserves other observers', (t) => {
  const { client, socket, sessions, snapshot } = fixture(t);
  client.select(sessions[0].id);
  snapshot(socket, sessions[0]);
  const active = client.observeSession(sessions[1].id);
  snapshot(socket, sessions[1]);
  for (const session of sessions.slice(2)) {
    const close = client.observeSession(session.id);
    snapshot(socket, session);
    close();
  }
  const evicted = sessions[2];
  assert.equal(client.state.history[evicted.id], undefined);
  const close = client.observeSession(evicted.id),
    request = socket.sent.at(-1)!;
  assert.equal((request as any).afterSequence, 0);
  snapshot(socket, evicted);
  assert.equal(client.state.history[evicted.id].loaded, true);
  assert.ok(client.state.events[evicted.id]);
  assert.ok(client.state.events[sessions[1].id]);
  assert.ok(client.state.events[sessions[0].id]);
  close();
  active();
});
