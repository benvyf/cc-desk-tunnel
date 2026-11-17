import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { managedServerHandler, type ManagedBackend } from '../src/managed-server-http.ts';
import { createProxyServer } from '../src/server.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const token = 'relay-service-credential-1234567890';

test('disconnected relay recovery preserves persistent approvals while owning maintenance against installs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relay-waiting-'));
  const server = createProxyServer({
    token,
    dataDir: root,
    managed: { backend: {} as ManagedBackend },
  });
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const session = server.store.create(randomUUID(), 'waiting', root, {
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
  const base = await server.listen(0);
  const post = (route: string, headers: Record<string, string> = {}) =>
    fetch(base + '/cc-managed/server/v1/' + route, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, ...headers },
    });
  assert.equal((await post('relay-enter')).status, 409);
  const response = await post('relay-enter', { 'x-cc-relay-recovery': 'disconnected' });
  assert.equal(response.status, 200);
  const { lease } = (await response.json()) as { lease: string };
  assert.equal(server.managedMaintenance!.serving(), false);
  assert.equal((await post('install')).status, 409);
  assert.equal((await post('relay-leave', { 'x-cc-relay-lease': lease })).status, 200);
  assert.equal(server.managedMaintenance!.serving(), true);
  assert.equal(
    server.managedMaintenance!.enter(true),
    false,
    'approval remains, normal maintenance still refuses',
  );
});
test('relay lease requires local service identity, gates installs, rejects wrong owner and expires', async (t) => {
  let entered = 0,
    left = 0,
    busy = false;
  const handler = managedServerHandler({
    token,
    admission: {
      enter: () => {
        if (busy) return false;
        entered++;
        return true;
      },
      leave: () => {
        left++;
      },
    },
    backend: {
      status: async () => ({}),
      prepare: async () => {},
      activate: () => {},
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
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/cc-managed/server/v1/`;
  const post = (route: string, lease?: string) =>
    fetch(base + route, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(lease ? { 'x-cc-relay-lease': lease } : {}),
      },
    });
  busy = true;
  assert.equal((await post('relay-enter')).status, 409);
  busy = false;
  const response = await post('relay-enter');
  assert.equal(response.status, 200);
  const { lease } = (await response.json()) as { lease: string };
  assert.ok(lease);
  assert.equal(entered, 1);
  assert.equal((await post('relay-enter')).status, 409);
  assert.equal((await post('relay-leave', 'wrong')).status, 409);
  assert.equal(left, 0);
  assert.equal((await post('install')).status, 409);
  assert.equal((await post('relay-leave', lease)).status, 200);
  assert.equal(left, 1);
  const next = (await (await post('relay-enter')).json()) as { lease: string };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(120001);
  assert.equal((await post('relay-leave', next.lease)).status, 409);
  assert.equal(left, 2);
});

test('relay admission refuses forwarded public effective addresses even with the service token', async (t) => {
  let entered = false;
  const handler = managedServerHandler({
    token,
    address: () => '8.8.8.8',
    admission: {
      enter: () => {
        entered = true;
        return true;
      },
      leave: () => {},
    },
    backend: {} as ManagedBackend,
  });
  const server = createServer((req, res) => {
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/cc-managed/server/v1/relay-enter`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 403);
  assert.equal(entered, false);
});
