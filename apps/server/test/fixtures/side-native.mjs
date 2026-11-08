import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { WebSocket } from 'ws';

// Exercise the actual server -> NativeInput -> runClaude -> query path without a CLI or model request.
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const calls = [],
  prompts = [],
  contexts = new Map(),
  histories = new Map();
let nextFailure = 'before-input';
mock.module('@anthropic-ai/claude-agent-sdk', {
  exports: {
    ...sdk,
    getSessionInfo: async (id) => contexts.get(id),
    getSessionMessages: async (id, options) => (histories.get(id) ?? []).slice(0, options?.limit),
    query(args) {
      calls.push(args.options);
      const failure = nextFailure;
      nextFailure = undefined;
      return {
        initializationResult: async () => ({ account: {}, models: [], commands: [] }),
        close() {},
        async *[Symbol.asyncIterator]() {
          const id = args.options.sessionId ?? args.options.resume;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: id,
            model: 'fake',
            claude_code_version: 'fake',
          };
          if (failure === 'before-input')
            throw new Error('Initialization failed before taking input');
          if (failure === 'before-input-persisted') {
            contexts.set(id, { lastModified: Date.now() });
            throw new Error('Initialization persisted an empty session before taking input');
          }
          const message = (await args.prompt.next()).value;
          prompts.push(message.message.content);
          contexts.set(id, { lastModified: Date.now() });
          histories.set(id, [...(histories.get(id) ?? []), message]);
          if (failure === 'after-input')
            throw new Error('Failed after persisting input, before receipt');
          yield {
            type: 'assistant',
            user_message_uuid: message.uuid,
            message: { content: [{ type: 'text', text: 'Fake answer' }] },
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            user_message_uuid: message.uuid,
            result: 'Fake answer',
            modelUsage: {},
            usage: {},
            num_turns: 1,
          };
        },
      };
    },
  },
});
Object.defineProperty(process, 'platform', { value: 'linux' });
const { createProxyServer } = await import('../../src/server.ts');
const { PROTOCOL_VERSION } = await import('@cc-desk-tunnel/protocol');
const directory = mkdtempSync(join(tmpdir(), 'cc-side-native-'));
const token = 'fake-native-' + randomUUID();
const server = createProxyServer({
  token,
  dataDir: directory,
  claude: { executable: 'never-executed' },
  tunnel: {},
  reverseProxy: true,
});
const socket = new WebSocket((await server.listen(0)).replace('http', 'ws') + '/ws');
const messages = [];
socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
async function wait(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for fake native server: ' + JSON.stringify(messages));
}
async function request(command) {
  const requestId = randomUUID();
  socket.send(JSON.stringify({ ...command, requestId }));
  const response = await wait((m) => m.type === 'response' && m.requestId === requestId);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response;
}
try {
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token,
      deviceName: 'Fake device',
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  await wait((m) => m.type === 'ready');
  const parent = await request({ type: 'server.session.create', title: 'Main' });
  server.store.append(parent.sessionId, randomUUID(), {
    type: 'text.delta',
    messageId: randomUUID(),
    text: 'Immutable inherited answer',
  });
  const original = server.store.snapshot(parent.sessionId);
  const child = await request({
    type: 'session.side.create',
    sessionId: parent.sessionId,
    title: 'Side',
  });
  assert.equal(calls.length, 0, 'opening side must never query');
  await request({ type: 'session.subscribe', sessionId: child.sessionId, retain: true });
  assert.equal(calls.length, 0, 'subscribing must never query');
  await request({ type: 'message.send', sessionId: child.sessionId, text: 'First question' });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === child.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'failed',
  );
  assert.ok(server.store.sidePrompt(child.sessionId), 'failed init retains background');
  await request({ type: 'message.send', sessionId: child.sessionId, text: 'Retry question' });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === child.sessionId &&
      m.event.payload.type === 'run.status' &&
      ['completed', 'failed'].includes(m.event.payload.status),
  );
  assert.equal(calls.length, 2, 'a failed initialization with no native context can retry');
  assert.equal(calls[1].sessionId, child.sessionId);
  assert.match(prompts[0], /Immutable inherited answer/);
  assert.ok(prompts[0].endsWith('Retry question'));
  await request({ type: 'message.send', sessionId: child.sessionId, text: 'Later question' });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === child.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.equal(calls[2].resume, child.sessionId);
  assert.equal(prompts[1], 'Later question');
  assert.deepEqual(server.store.snapshot(parent.sessionId), original);
  const displayed = server.store
    .snapshot(child.sessionId)
    .events.filter((e) => e.payload.type === 'message.user')
    .map((e) => e.payload.text);
  assert.deepEqual(displayed, ['First question', 'Retry question', 'Later question']);
  const failedAfterInput = await request({
    type: 'session.side.create',
    sessionId: parent.sessionId,
    title: 'Consumed input',
  });
  histories.set(
    failedAfterInput.sessionId,
    Array.from({ length: 40 }, (_, index) => ({
      type: 'user',
      message: { content: `Previous terminal input ${index}` },
    })),
  );
  nextFailure = 'after-input';
  await request({
    type: 'message.send',
    sessionId: failedAfterInput.sessionId,
    text: 'Consumed question',
  });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === failedAfterInput.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'failed',
  );
  assert.match(prompts[2], /Immutable inherited answer/);
  assert.ok(contexts.has(failedAfterInput.sessionId));
  await request({
    type: 'message.send',
    sessionId: failedAfterInput.sessionId,
    text: 'Retry consumed question',
  });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === failedAfterInput.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.equal(calls[4].resume, failedAfterInput.sessionId);
  assert.equal(
    prompts[3],
    'Retry consumed question',
    'resuming a persisted seeded input must not duplicate frozen background',
  );
  const emptyNative = await request({
    type: 'session.side.create',
    sessionId: parent.sessionId,
    title: 'Empty persisted initialization',
  });
  nextFailure = 'before-input-persisted';
  await request({
    type: 'message.send',
    sessionId: emptyNative.sessionId,
    text: 'Never consumed question',
  });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === emptyNative.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'failed',
  );
  assert.ok(contexts.has(emptyNative.sessionId));
  assert.equal(histories.get(emptyNative.sessionId), undefined);
  await request({
    type: 'message.send',
    sessionId: emptyNative.sessionId,
    text: 'Retry empty native question',
  });
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === emptyNative.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.equal(calls[6].resume, emptyNative.sessionId);
  assert.match(prompts[4], /Immutable inherited answer/);
  assert.ok(prompts[4].endsWith('Retry empty native question'));
} finally {
  socket.terminate();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
}
