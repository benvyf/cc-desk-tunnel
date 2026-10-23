import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { moderationConfig, reviewInput } from '../src/moderation.ts';
import { environmentConfig, clearServiceVariables } from '../src/config.ts';

const config = {
  endpoint: 'https://review.example.invalid/cc-updates/v1/moderation/check',
  nodeId: 'test-node',
  token: 'n'.repeat(43),
};
const decision = (allowed: boolean) => Response.json({ id: randomUUID(), allowed });
async function fixture(t: TestContext, fetcher: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'cc-gate-'));
  const token = 'local-offline-token-' + randomUUID();
  const server = createProxyServer({
    token,
    dataDir: root,
    stepMs: 2,
    moderation: { ...config, fetcher },
  });
  const url = await server.listen(0);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function connect() {
    const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(
      JSON.stringify({
        type: 'auth',
        token,
        protocolVersion: PROTOCOL_VERSION,
        deviceName: 'fixture',
      }),
    );
    socket.send(JSON.stringify({ type: 'device', id: deviceId }));
    async function wait(predicate: (m: ServerMessage) => boolean) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Timed out waiting for fixture response.');
    }
    await wait((m) => m.type === 'ready');
    async function request(value: object, requestId: string = randomUUID()) {
      socket.send(JSON.stringify({ ...value, requestId }));
      const response = await wait((m) => m.type === 'response' && m.requestId === requestId);
      assert.equal(response.type, 'response');
      return response;
    }
    return { request, wait, socket };
  }
  const deviceId = randomUUID();
  const client = await connect();
  const created = await client.request({
    type: 'session.create',
    title: 'Gate fixture',
    projectPath: 'D:\\fixture',
  });
  return { server, client, connect, sessionId: created.sessionId!, root };
}

test('review denies errors and malformed responses, enforces HTTPS, and removes node config env', async () => {
  assert.throws(() =>
    moderationConfig({ ...config, endpoint: 'http://bad.invalid/cc-updates/v1/moderation/check' }),
  );
  const input = {
    requestId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    kind: 'message.send',
    text: 'fixture',
  };
  for (const fetcher of [
    async () => new Response('', { status: 503 }),
    async () => Response.json({ allowed: true }),
    async () => {
      throw new Error('network fixture');
    },
  ]) {
    await assert.rejects(reviewInput({ ...config, fetcher }, input), {
      code: 'operation_failed',
    });
  }
  await assert.rejects(reviewInput({ ...config, fetcher: async () => decision(false) }, input), {
    code: 'operation_failed',
  });
  await assert.rejects(
    reviewInput(
      {
        ...config,
        fetcher: async () => {
          throw new Error('must not fetch');
        },
      },
      { ...input, text: 'x'.repeat(65537) },
    ),
    { code: 'operation_failed' },
  );
  const root = mkdtempSync(join(tmpdir(), 'cc-gate-config-'));
  try {
    const path = join(root, 'node.json');
    writeFileSync(path, JSON.stringify(config));
    const env = {
      PROXY_MODERATION_CONFIG: path,
      HOME: '/unchanged',
      ANTHROPIC_BASE_URL: 'https://unchanged.invalid',
    };
    assert.deepEqual(environmentConfig(env, root).options.moderation, config);
    clearServiceVariables(env);
    assert.deepEqual(env, { HOME: '/unchanged', ANTHROPIC_BASE_URL: 'https://unchanged.invalid' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blocked inputs create no user message/run; allow executes once, continue includes old input, terminals denied', async (t) => {
  const reviews: Record<string, string>[] = [];
  const f = await fixture(t, async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    reviews.push(input);
    return decision(!input.text.includes('BLOCK'));
  });
  const send = (text: string, requestId?: string) =>
    f.client.request(
      { type: 'message.send', sessionId: f.sessionId, text, scenario: 'chat' },
      requestId,
    );
  assert.equal((await send('BLOCK')).code, 'operation_failed');
  assert.equal(f.server.store.get(f.sessionId).events.length, 0);
  const id = randomUUID();
  assert.equal((await send('normal offline fixture', id)).ok, true);
  assert.equal((await send('normal offline fixture', id)).ok, true);
  assert.equal(reviews.length, 2);
  await f.client.wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.equal((await f.client.request({ type: 'run.continue', sessionId: f.sessionId })).ok, true);
  assert.ok(reviews.at(-1)!.text!.includes('normal offline fixture'));
  assert.equal(
    (await f.client.request({ type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 }))
      .code,
    'moderation_terminal_disabled',
  );
});

test('review waits before persistence, blocks mutations and serializes other connections', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  let calls = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async () => {
    calls++;
    entered();
    await gate;
    return decision(false);
  });
  const other = await f.connect();
  const message = {
    type: 'message.send',
    sessionId: f.sessionId,
    text: 'pending fixture',
    scenario: 'chat',
  };
  const first = f.client.request(message);
  await ready;
  const second = other.request(message);
  assert.equal(
    (await other.request({ type: 'session.delete', sessionId: f.sessionId })).code,
    'session_busy',
  );
  assert.equal(f.server.store.get(f.sessionId).events.length, 0);
  assert.equal(calls, 1);
  release();
  assert.equal((await first).code, 'operation_failed');
  assert.equal((await second).code, 'operation_failed');
  assert.equal(calls, 2);
});

test('question answers are reviewed before resolving and rejected answers may be corrected', async (t) => {
  const f = await fixture(t, async (_url, init) =>
    decision(!JSON.parse(String(init?.body)).text.includes('BLOCK')),
  );
  assert.equal(
    (
      await f.client.request({
        type: 'message.send',
        sessionId: f.sessionId,
        text: 'offline question',
        scenario: 'question',
      })
    ).ok,
    true,
  );
  const approval = await f.client.wait(
    (m) => m.type === 'session.event' && m.event.payload.type === 'approval.requested',
  );
  assert.ok(
    approval.type === 'session.event' && approval.event.payload.type === 'approval.requested',
  );
  const reply = {
    type: 'approval.reply',
    sessionId: f.sessionId,
    runId: approval.event.runId,
    approvalId: approval.event.payload.approvalId,
    allowed: true,
  };
  assert.equal(
    (await f.client.request({ ...reply, answers: { question: 'BLOCK' } })).code,
    'operation_failed',
  );
  assert.equal(
    (await f.client.request({ ...reply, answers: { question: 'normal offline answer' } })).ok,
    true,
  );
});

test('disconnect during review cannot start a run when the review later allows it', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async () => {
    entered();
    await gate;
    return decision(true);
  });
  // A request on a closed socket has no response, so only observe stored side effects.
  f.client.socket.send(
    JSON.stringify({
      type: 'message.send',
      requestId: randomUUID(),
      sessionId: f.sessionId,
      text: 'offline disconnect fixture',
      scenario: 'chat',
    }),
  );
  await ready;
  f.client.socket.terminate();
  await new Promise<void>((resolve) => f.client.socket.once('close', resolve));
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.server.store.get(f.sessionId).events.length, 0);
});

test('node review network deadline fails closed without a retry', async () => {
  let calls = 0;
  await assert.rejects(
    reviewInput(
      {
        ...config,
        fetcher: async (_url, init) => {
          calls++;
          await new Promise((_, reject) =>
            init!.signal!.addEventListener('abort', () => reject(new Error('offline deadline')), {
              once: true,
            }),
          );
          throw new Error('unreachable');
        },
      },
      {
        requestId: randomUUID(),
        sessionId: randomUUID(),
        deviceId: randomUUID(),
        kind: 'message.send',
        text: 'offline deadline',
      },
      15,
    ),
    { code: 'operation_failed' },
  );
  assert.equal(calls, 1);
});
