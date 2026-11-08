// Runs only in a disposable image with --network none, no production mounts or credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createProxyServer } from '/app/apps/server/src/server.ts';
import { reviewInput } from '/app/apps/server/src/moderation.ts';
const { WebSocket } = createRequire('/app/apps/server/package.json')('ws');
const root = await mkdtemp(join(tmpdir(), 'moderation-pilot-'));
const token = randomUUID();
const seen = [];
const moderation = {
  endpoint: 'https://offline.invalid/cc-updates/v1/moderation/check',
  nodeId: 'offline-pilot',
  token: 'x'.repeat(43),
  fetcher: async (_url, init) => {
    const input = JSON.parse(init.body);
    seen.push(input);
    return Response.json({ id: randomUUID(), allowed: !input.text.includes('BLOCK') });
  },
};
const server = createProxyServer({ token, dataDir: root, stepMs: 1, moderation });
let socket;
try {
  const url = await server.listen(0);
  socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  async function wait(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Offline fixture timed out.');
  }
  async function request(command) {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    return wait((m) => m.type === 'response' && m.requestId === requestId);
  }
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ type: 'auth', token, protocolVersion: 20, deviceName: 'offline' }));
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  await wait((m) => m.type === 'ready');
  const { sessionId } = await request({
    type: 'session.create',
    title: 'offline',
    projectPath: '/tmp/offline',
  });
  assert.ok(sessionId);
  const message = { type: 'message.send', sessionId, scenario: 'chat' };
  assert.equal(
    (await request({ ...message, text: 'BLOCK offline fixture' })).code,
    'operation_failed',
  );
  assert.equal(server.store.get(sessionId).events.length, 0);
  assert.equal((await request({ ...message, text: 'Normal offline fixture' })).ok, true);
  await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === 'completed',
  );
  assert.equal((await request({ type: 'run.continue', sessionId })).ok, true);
  assert.ok(seen.at(-1).text.includes('Normal offline fixture'));
  assert.equal(
    (await request({ type: 'terminal.open', sessionId, cols: 80, rows: 24 })).code,
    'moderation_terminal_disabled',
  );
  await assert.rejects(
    reviewInput(
      {
        ...moderation,
        fetcher: async (_url, init) => {
          await new Promise((_, reject) =>
            init.signal.addEventListener('abort', () => reject(new Error('offline timeout')), {
              once: true,
            }),
          );
          throw new Error('unreachable');
        },
      },
      {
        requestId: randomUUID(),
        sessionId,
        deviceId: randomUUID(),
        kind: 'message.send',
        text: 'offline timeout',
      },
      20,
    ),
    { code: 'operation_failed' },
  );
  console.log(
    'PILOT_RESULT ' +
      JSON.stringify({
        blockedBeforePersistence: true,
        simulatedAllow: true,
        continueHistoryReviewed: true,
        terminalDisabled: true,
        timeoutClosed: true,
        modelRequests: 0,
      }),
  );
} finally {
  socket?.terminate();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
