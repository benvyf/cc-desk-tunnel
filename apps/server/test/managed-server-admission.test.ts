import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createProxyServer } from '../src/server.ts';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { ManagedBackend } from '../src/managed-server-http.ts';

test('business HTTP and websocket admission close atomically while management and health remain reachable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-admission-'));
  const token = 'managed-admission-offline-token-123';
  let activated = false;
  const backend = {
    check: async () => ({ compatible: true }),
    status: async () => ({ phase: 'idle' }),
    prepare: async () => {},
    activate: () => {
      activated = true;
    },
  } as unknown as ManagedBackend;
  const server = createProxyServer({
    token,
    dataDir: dir,
    managed: { backend, initialMaintenance: true },
  });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = await server.listen(0);
  assert.equal((await fetch(url + '/')).status, 503);
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal(
    (
      await fetch(url + '/cc-managed/server/v1/status', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
  assert.ok(server.managedMaintenance);
  server.managedMaintenance.release();
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
  await new Promise<void>((resolve) => ws.once('open', resolve));
  const auth = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  ws.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: 'offline',
    }),
  );
  await auth;
  const install = () =>
    fetch(url + '/cc-managed/server/v1/install', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmed: true,
        build: 2,
        sha256: 'a'.repeat(64),
        clientProtocol: PROTOCOL_VERSION,
      }),
    });
  assert.equal((await install()).status, 409);
  assert.equal(activated, false);
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
  ws.close();
  await closed;
  assert.equal((await install()).status, 202);
  assert.equal(activated, true);
  assert.equal((await fetch(url + '/api/session', { method: 'POST', body: '{}' })).status, 503);
  const blocked = new WebSocket(url.replace('http', 'ws') + '/ws');
  const status = await new Promise<number>((resolve) => {
    blocked.once('unexpected-response', (_r, response) => {
      response.resume();
      resolve(response.statusCode!);
      blocked.terminate();
    });
    blocked.on('error', () => {});
  });
  assert.equal(status, 503);
});
