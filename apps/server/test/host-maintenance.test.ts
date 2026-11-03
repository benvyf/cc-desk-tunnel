import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createProxyServer } from '../src/server.ts';
import { managedServerHandler, type ManagedBackend } from '../src/managed-server-http.ts';
import { createServer } from 'node:http';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { randomUUID } from 'node:crypto';

const token = 'host-maintenance-service-token-123456';
const confirmation = {
  confirmed: true,
  build: 2,
  sha256: 'a'.repeat(64),
  clientProtocol: PROTOCOL_VERSION,
};

test('updated child under legacy supervisor cannot advertise host maintenance and exposes live serving', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'host-legacy-'));
  let prepared = false;
  const server = createProxyServer({
    token,
    dataDir: dir,
    managed: {
      initialMaintenance: true,
      backend: {
        status: async () => ({ phase: 'committed' }),
        prepare: async () => {
          prepared = true;
        },
        cancel: async () => {},
        activate: () => assert.fail('legacy activation'),
      } as unknown as ManagedBackend,
    },
  });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = await server.listen(0),
    headers = { authorization: `Bearer ${token}` };
  let status = await (await fetch(url + '/cc-managed/server/v1/status', { headers })).json();
  assert.equal(status.hostMaintenance, false);
  assert.equal(status.serving, false);
  server.managedMaintenance!.release();
  status = await (await fetch(url + '/cc-managed/server/v1/status', { headers })).json();
  assert.equal(status.serving, true);
  const result = await fetch(url + '/cc-managed/server/v1/host-install', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(confirmation),
  });
  assert.equal(result.status, 409);
  assert.equal(prepared, false);
});

test('host update stages with clients connected, then closes idle clients and prevents reconnect', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'host-maintenance-'));
  let finish!: () => void, staged!: () => void;
  const preparing = new Promise<void>((r) => {
    staged = r;
  });
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  let activated = false;
  const server = createProxyServer({
    token,
    dataDir: dir,
    managed: {
      backend: {
        status: async () => ({ phase: 'idle', hostMaintenance: true }),
        check: async () => ({}),
        prepare: async () => {
          staged();
          await gate;
        },
        cancel: async () => {},
        activate: () => {
          activated = true;
        },
      } as unknown as ManagedBackend,
    },
  });
  t.after(async () => {
    finish();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const url = await server.listen(0);
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
  t.after(() => ws.terminate());
  await new Promise<void>((r) => ws.once('open', r));
  const auth = new Promise<void>((r) => ws.once('message', () => r()));
  ws.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: 'idle-host-test',
    }),
  );
  await auth;
  const installed = fetch(url + '/cc-managed/server/v1/host-install', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(confirmation),
  });
  await Promise.race([
    preparing,
    installed.then((r) => assert.fail(`staging never started: HTTP ${r.status}`)),
  ]);
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal((await fetch(url + '/')).status === 503, false);
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  finish();
  assert.equal((await installed).status, 202);
  assert.equal(await closed, 1012);
  assert.equal(activated, true);
  assert.equal((await fetch(url + '/')).status, 503);
});

test('host maintenance rejects desktop tickets, and a busy final check cancels staged work without closing admission', async (t) => {
  let prepared = 0,
    cancelled = 0,
    entered = 0;
  const handler = managedServerHandler({
    token,
    authorizeDesktopTicket: async () => ({}),
    admission: {
      enter: () => {
        entered++;
        return false;
      },
      leave: () => assert.fail('did not acquire maintenance'),
    },
    backend: {
      status: async () => ({ phase: 'idle', hostMaintenance: true }),
      check: async () => ({}),
      prepare: async () => {
        prepared++;
      },
      cancel: async () => {
        cancelled++;
      },
      activate: () => assert.fail('busy target activated'),
    } as unknown as ManagedBackend,
  });
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const post = (credential: string) =>
    fetch(`http://127.0.0.1:${address.port}/cc-managed/server/v1/host-install`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(confirmation),
    });
  assert.equal((await post('ccs_' + 'x'.repeat(43))).status, 403);
  assert.equal(prepared, 0);
  assert.equal((await post(token)).status, 409);
  assert.equal(prepared, 1);
  assert.equal(cancelled, 1);
  assert.equal(entered, 1);
});

test('persistent waiting runs block host maintenance without disconnecting clients', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'host-waiting-'));
  const server = createProxyServer({
    token,
    dataDir: dir,
    managed: { backend: {} as ManagedBackend },
  });
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = server.store.create(randomUUID(), 'waiting', dir, {
    id: randomUUID(),
    name: 'fixture',
    platform: 'linux',
  });
  server.store.append(session.id, randomUUID(), {
    type: 'run.status',
    connectionId: randomUUID(),
    status: 'awaiting_approval',
    waiting: 'question',
  });
  assert.equal(server.managedMaintenance!.enter(true), false);
  const url = await server.listen(0);
  assert.notEqual((await fetch(url + '/')).status, 503);
});
