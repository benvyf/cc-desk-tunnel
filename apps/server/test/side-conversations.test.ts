import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { commandSchema, PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { EventPayload, ServerMessage } from '@cc-desk-tunnel/protocol';
import { SessionStore } from '../src/store.ts';
import { NativeInput } from '../src/native-input.ts';
import { createProxyServer } from '../src/server.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-side-'));
  const f = { directory, store: new SessionStore(directory) };
  t.after(() => {
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const parent = f.store.create(randomUUID(), 'Main', 'D:\\project', {
    id: randomUUID(),
    name: 'PC',
  });
  f.store.configure(parent.id, 'plan', 'test-model', 'high');
  return { f, parent: f.store.get(parent.id).session };
}

test('side creation freezes busy text and tool records without mutating or copying active state', (t) => {
  const { f, parent } = fixture(t);
  const runId = randomUUID();
  f.store.append(parent.id, runId, {
    type: 'message.user',
    messageId: randomUUID(),
    text: 'Original task',
    scenario: 'chat',
  });
  f.store.append(parent.id, runId, {
    type: 'run.status',
    status: 'running',
    connectionId: randomUUID(),
  });
  f.store.append(parent.id, runId, {
    type: 'tool.requested',
    toolId: 'tool',
    name: 'Bash',
    input: 'Do not execute',
    target: 'Windows',
  });
  f.store.append(parent.id, runId, {
    type: 'approval.requested',
    approvalId: randomUUID(),
    toolId: 'tool',
  });
  const before = f.store.snapshot(parent.id);
  const requestId = randomUUID();
  const child = f.store.createSide(requestId, parent.id, 'Side', {
    type: 'text.delta',
    messageId: randomUUID(),
    text: 'Visible unfinished answer',
  });
  assert.notEqual(child.id, parent.id);
  assert.deepEqual(f.store.snapshot(parent.id), before);
  assert.equal(child.activeRun, null);
  assert.equal(child.permissionMode, parent.permissionMode);
  assert.equal(child.model, parent.model);
  assert.equal(child.effort, parent.effort);
  assert.deepEqual(child.device, parent.device);
  assert.equal(child.projectPath, parent.projectPath);
  assert.equal(child.sideConversation?.throughSequence, before.events.at(-1)!.sequence);
  assert.equal(f.store.snapshot(child.id).events.length, 0);
  assert.equal(f.store.hasNativeContext(child.id), false);
  const prompt = f.store.sideContext(child.id);
  assert.match(prompt, /Original task/);
  assert.match(prompt, /Visible unfinished answer/);
  assert.match(prompt, /Do not execute/);
  assert.ok(!prompt.includes('approval.requested'));
  f.store.append(parent.id, runId, {
    type: 'text.delta',
    messageId: randomUUID(),
    text: 'Later answer',
  });
  assert.equal(f.store.sideContext(child.id), prompt);
  assert.equal(f.store.createSide(requestId, parent.id, 'Side').id, child.id);
  assert.throws(() => f.store.createSide(requestId, parent.id, 'Other'), {
    code: 'request_conflict',
  });
  assert.throws(() => f.store.create(requestId, 'Side', parent.projectPath, parent.device!), {
    code: 'request_conflict',
  });
  f.store.configure(child.id, 'default', 'child-model', 'low');
  assert.equal(f.store.get(parent.id).session.model, 'test-model');
  f.store.close();
  f.store = new SessionStore(f.directory);
  assert.equal(f.store.sideContext(child.id), prompt);
  f.store.delete(parent.id);
  assert.equal(
    f.store.sideContext(child.id),
    prompt,
    'parent deletion does not delete independent background',
  );
  assert.ok(!JSON.stringify(f.store.list()).includes('Visible unfinished answer'));
  f.store.delete(child.id);
  assert.equal(f.store.sideContext(child.id), '');
});

test('oversize snapshots reject atomically instead of truncating', (t) => {
  const { f, parent } = fixture(t);
  f.store.append(parent.id, randomUUID(), {
    type: 'text.delta',
    messageId: randomUUID(),
    text: 'a'.repeat(256001),
  });
  const before = f.store.list();
  const requestId = randomUUID();
  assert.throws(() => f.store.createSide(requestId, parent.id, 'Side'), {
    code: 'side_context_too_large',
  });
  assert.deepEqual(f.store.list(), before);
  assert.equal(f.store.created(requestId), undefined);
});

test('unused side forks retain their frozen background across restart', (t) => {
  const { f, parent } = fixture(t);
  f.store.append(parent.id, randomUUID(), {
    type: 'text.delta',
    messageId: randomUUID(),
    text: 'Inherited fork background',
  });
  const side = f.store.createSide(randomUUID(), parent.id, 'Side');
  const fork = f.store.fork(randomUUID(), side.id, randomUUID(), 'Side fork', false, {
    device: parent.device!,
  });
  assert.equal(f.store.sideContext(fork.id), f.store.sideContext(side.id));
  assert.match(f.store.sidePrompt(fork.id), /Inherited fork background/);
  f.store.close();
  f.store = new SessionStore(f.directory);
  assert.match(f.store.sidePrompt(fork.id), /Inherited fork background/);
});

test('closing a terminal cannot consume a side conversation background before its first explicit question', (t) => {
  const { f, parent } = fixture(t);
  const side = f.store.createSide(randomUUID(), parent.id, 'Side');
  const before = f.store.sidePrompt(side.id);
  f.store.append(side.id, randomUUID(), {
    type: 'run.status',
    status: 'completed',
    surface: 'terminal',
    connectionId: randomUUID(),
  });
  assert.equal(f.store.sidePrompt(side.id), before);
});

test('frozen background reaches native input only on explicit first send and survives failed first attempts', async (t) => {
  const { f, parent } = fixture(t);
  f.store.append(parent.id, randomUUID(), {
    type: 'text.delta',
    messageId: randomUUID(),
    text: 'Frozen background',
  });
  const child = f.store.createSide(randomUUID(), parent.id, 'Side');
  assert.equal(f.store.snapshot(child.id).events.length, 0);
  const question = 'What does that mean?';
  const messageId = randomUUID();
  const runId = randomUUID();
  f.store.append(child.id, runId, {
    type: 'message.user',
    messageId,
    text: question,
    scenario: 'chat',
  });
  const events: EventPayload[] = [];
  const input = new NativeInput(child.id, (event) => events.push(event));
  input.submit(messageId, question);
  const stream = input.stream(f.store.sidePrompt(child.id));
  const sent = (await stream.next()).value!;
  assert.match(String(sent.message.content), /Frozen background/);
  assert.match(String(sent.message.content), /background only/i);
  assert.match(String(sent.message.content), /Do not continue/i);
  assert.ok(String(sent.message.content).endsWith(question));
  input.close();
  assert.equal(f.store.snapshot(child.id).events[0]!.payload.type, 'message.user');
  assert.equal((f.store.snapshot(child.id).events[0]!.payload as { text: string }).text, question);
  assert.ok(
    f.store.sidePrompt(child.id),
    'failure before receipt must retain inherited background',
  );
  f.store.append(child.id, runId, { type: 'message.delivery', messageId, status: 'received' });
  assert.equal(f.store.sidePrompt(child.id), '', 'later turns use their own native context');
});

test('side protocol additions remain optional and subscription retain defaults off', () => {
  const requestId = randomUUID(),
    sessionId = randomUUID();
  assert.equal(
    commandSchema.safeParse({ type: 'session.side.create', requestId, sessionId, title: 'Side' })
      .success,
    true,
  );
  const subscribe = commandSchema.parse({ type: 'session.subscribe', requestId, sessionId });
  assert.ok(subscribe.type === 'session.subscribe' && subscribe.retain === undefined);
  assert.equal(
    commandSchema.safeParse({ type: 'session.unsubscribe', requestId, sessionId }).success,
    true,
  );
  assert.equal(
    commandSchema.safeParse({
      type: 'session.side.create',
      requestId,
      sessionId,
      title: 'Side',
      snapshot: 'client supplied',
    }).success,
    false,
  );
});

test('fake SDK receives inherited background only through the real explicit-send path, including initialization retry', async () => {
  await promisify(execFile)(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      fileURLToPath(new URL('./fixtures/side-native.mjs', import.meta.url)),
    ],
    { timeout: 15000 },
  );
});

class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url.replace('http', 'ws') + '/ws');
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(String(raw)))),
    );
  }
  async wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for server');
  }
  async request(command: object) {
    const requestId = randomUUID();
    this.socket.send(JSON.stringify({ ...command, requestId }));
    const response = await this.wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    );
    assert.ok(response.type === 'response');
    return response;
  }
}

test('WebSocket side creation never submits and retained subscriptions receive both sessions until unsubscribe', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-side-ws-'));
  const token = 'test-token-' + randomUUID();
  const server = createProxyServer({ token, dataDir: directory, stepMs: 15 });
  const url = await server.listen(0);
  const client = new Client(url),
    actor = new Client(url);
  t.after(async () => {
    client.socket.terminate();
    actor.socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const computer = randomUUID();
  async function open(current: Client) {
    if (current.socket.readyState !== WebSocket.OPEN)
      await new Promise<void>((resolve) => current.socket.once('open', resolve));
    current.socket.send(
      JSON.stringify({ type: 'auth', token, protocolVersion: PROTOCOL_VERSION, deviceName: 'PC' }),
    );
    current.socket.send(JSON.stringify({ type: 'device', id: computer }));
    return current.wait((message) => message.type === 'ready');
  }
  const ready = await open(client);
  await open(actor);
  assert.ok(ready.type === 'ready' && ready.sideConversations === true);
  const main = await client.request({
    type: 'session.create',
    title: 'Main',
    projectPath: 'D:\\project',
  });
  assert.ok(main.ok && main.sessionId);
  const side = await client.request({
    type: 'session.side.create',
    sessionId: main.sessionId,
    title: 'Side',
  });
  assert.ok(side.ok && side.sessionId);
  assert.equal(client.messages.filter((m) => m.type === 'session.event').length, 0);
  assert.ok(
    (await client.request({ type: 'session.subscribe', sessionId: side.sessionId, retain: true }))
      .ok,
  );
  assert.ok(
    (
      await client.request({
        type: 'message.send',
        sessionId: main.sessionId,
        text: 'Main question',
      })
    ).ok,
  );
  assert.ok(
    (
      await client.request({
        type: 'message.send',
        sessionId: side.sessionId,
        text: 'Side question',
      })
    ).ok,
  );
  for (const sessionId of [main.sessionId, side.sessionId]) {
    await client.wait(
      (m) =>
        m.type === 'session.event' &&
        m.event.sessionId === sessionId &&
        m.event.payload.type === 'run.status' &&
        m.event.payload.status === 'completed',
    );
  }
  await client.request({ type: 'session.unsubscribe', sessionId: main.sessionId });
  client.messages = [];
  await actor.request({
    type: 'message.send',
    sessionId: main.sessionId,
    text: 'After unsubscribe',
  });
  await actor.wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.ok(
    !client.messages.some(
      (m) => m.type === 'session.event' && m.event.sessionId === main.sessionId,
    ),
  );
  await actor.request({
    type: 'message.send',
    sessionId: side.sessionId,
    text: 'Still observing side',
  });
  await client.wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === side.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  await client.request({ type: 'session.subscribe', sessionId: main.sessionId });
  client.messages = [];
  await actor.request({
    type: 'message.send',
    sessionId: side.sessionId,
    text: 'Default subscribe replaced side',
  });
  await actor.wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === side.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.ok(
    !client.messages.some(
      (m) => m.type === 'session.event' && m.event.sessionId === side.sessionId,
    ),
  );
  // Capture an actual live fragment without settling the source's open output.
  await actor.request({ type: 'message.send', sessionId: main.sessionId, text: 'Running parent' });
  const fragment = await client.wait(
    (m) =>
      m.type === 'session.fragment' &&
      m.sessionId === main.sessionId &&
      m.payload.type === 'text.delta',
  );
  assert.ok(fragment.type === 'session.fragment' && fragment.payload.type === 'text.delta');
  const before = server.store.snapshot(main.sessionId);
  const liveChild = await client.request({
    type: 'session.side.create',
    sessionId: main.sessionId,
    title: 'Live snapshot',
  });
  assert.ok(liveChild.ok && liveChild.sessionId);
  assert.ok(server.store.sideContext(liveChild.sessionId).includes(fragment.payload.text));
  assert.equal(
    server.store.get(main.sessionId).session.activeRun?.id,
    before.session.activeRun?.id,
  );
  assert.equal(server.store.snapshot(liveChild.sessionId).events.length, 0);
  await actor.wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === main.sessionId &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  await client.request({ type: 'session.subscribe', sessionId: main.sessionId });
  for (let i = 1; i < 32; i++) {
    const extra = server.store.createSide(randomUUID(), main.sessionId, `Extra ${i}`);
    assert.ok(
      (await client.request({ type: 'session.subscribe', sessionId: extra.id, retain: true })).ok,
    );
  }
  const overflow = server.store.createSide(randomUUID(), main.sessionId, 'Overflow');
  const denied = await client.request({
    type: 'session.subscribe',
    sessionId: overflow.id,
    retain: true,
  });
  assert.equal(denied.code, 'subscription_limit');
  const deniedSend = await client.request({
    type: 'message.send',
    sessionId: overflow.id,
    text: 'Must not bypass bound',
  });
  assert.equal(deniedSend.code, 'subscription_limit');
  assert.equal(server.store.snapshot(overflow.id).events.length, 0);
  await client.request({ type: 'session.unsubscribe', sessionId: main.sessionId });
  assert.ok(
    (await client.request({ type: 'session.subscribe', sessionId: overflow.id, retain: true })).ok,
  );
});
