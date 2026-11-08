import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@cc-desk-tunnel/protocol';
import { clearServiceVariables, environmentConfig } from '../src/config.ts';
import { createProxyServer } from '../src/server.ts';

test('monitor and current node moderation configuration coexist without leaking service credentials', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-monitor-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const moderation = {
    endpoint: 'https://review.example.invalid/cc-updates/v1/moderation/check',
    nodeId: 'ubuntu-cc',
    token: 'r'.repeat(43),
  };
  const config = join(directory, 'moderation-node.json');
  writeFileSync(config, JSON.stringify(moderation));
  const env = {
    PROXY_MONITOR_URL: 'https://monitor.example.invalid/cc-updates/admin/api/monitor/report',
    PROXY_MONITOR_NODE_ID: 'ubuntu-cc',
    PROXY_MONITOR_TOKEN: 'm'.repeat(43),
    PROXY_MODERATION_CONFIG: config,
  };
  const { options } = environmentConfig(env, directory);
  assert.equal(options.accountMonitor?.nodeId, 'ubuntu-cc');
  assert.deepEqual(options.moderation, moderation);
  clearServiceVariables(env);
  assert.deepEqual(env, {});
});

async function fixture(t: TestContext, allowed: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-monitor-review-'));
  const reports: unknown[] = [];
  const decisions: unknown[] = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    reports.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  assert.ok(address && typeof address !== 'string');
  const token = 'offline-connection-' + randomUUID();
  const proxy = createProxyServer({
    token,
    dataDir: directory,
    stepMs: 2,
    accountMonitor: {
      url: `http://127.0.0.1:${address.port}/report`,
      nodeId: 'ubuntu-cc',
      token: 'm'.repeat(43),
    },
    moderation: {
      endpoint: 'https://review.example.invalid/cc-updates/v1/moderation/check',
      nodeId: 'ubuntu-cc',
      token: 'r'.repeat(43),
      fetcher: async (_url, init) => {
        decisions.push(JSON.parse(String(init?.body)));
        return Response.json({ id: randomUUID(), allowed });
      },
    },
  });
  const url = await proxy.listen(0);
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  const messages: ServerMessage[] = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  t.after(async () => {
    socket.terminate();
    await proxy.close();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index !== -1) return messages.splice(index, 1)[0];
      await delay(5);
    }
    throw new Error('Offline proxy response timed out');
  }
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: 'offline',
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  await wait((message) => message.type === 'ready');
  async function request(command: object) {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    const response = await wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    );
    assert.equal(response.type, 'response');
    return response as Extract<ServerMessage, { type: 'response' }>;
  }
  const session = await request({
    type: 'session.create',
    title: 'offline fixture',
    projectPath: 'D:\\fixture',
  });
  assert.ok(session.ok && session.sessionId);
  return { proxy, request, wait, decisions, reports, sessionId: session.sessionId };
}

test('review rejection still blocks a run when passive monitoring is configured', async (t) => {
  const f = await fixture(t, false);
  const response = await f.request({
    type: 'message.send',
    sessionId: f.sessionId,
    text: 'offline fixture',
  });
  assert.equal(response.ok, false);
  assert.equal(f.decisions.length, 1);
  assert.equal(f.proxy.store.list()[0].activeRun, null);
  assert.equal(
    f.proxy.store.get(f.sessionId).events.some((event) => event.payload.type === 'message.user'),
    false,
  );
  assert.equal(f.reports.length, 0, 'no identity or quota collection is created for review');
});

test('allowed input keeps simulation working without inventing an account report', async (t) => {
  const f = await fixture(t, true);
  const response = await f.request({
    type: 'message.send',
    sessionId: f.sessionId,
    text: 'offline fixture',
  });
  assert.equal(response.ok, true);
  assert.equal(f.decisions.length, 1);
  await f.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'completed',
  );
  assert.equal(f.reports.length, 0, 'unknown identity must not generate a fabricated account');
});
