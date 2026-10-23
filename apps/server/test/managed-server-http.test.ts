import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { managedServerHandler, type ManagedBackend } from '../src/managed-server-http.ts';

const token = 'offline-managed-token-123456789';
test('management is independent of business protocol; exact confirmation, Origin, strict JSON and token throttle', async (t) => {
  let busy = false,
    maintenance = false,
    installs = 0;
  const backend = {
    check: async (clientProtocol: number) => ({ clientProtocol }),
    status: async () => ({ phase: 'idle' }),
    prepare: async () => {
      installs++;
    },
    activate: () => {},
  } as unknown as ManagedBackend;
  const handler = managedServerHandler({
    token,
    backend,
    admission: {
      enter: () => {
        if (busy || maintenance) return false;
        maintenance = true;
        return !busy;
      },
      leave: () => {
        maintenance = false;
      },
    },
  });
  const server = createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/cc-managed/server/v1/`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await post('check', { clientProtocol: 999 })).status, 200);
  assert.equal((await post('check', { clientProtocol: 999, url: 'https://evil' })).status, 400);
  assert.equal((await post('check', { clientProtocol: 999 }, { origin: 'null' })).status, 403);
  assert.equal(
    (
      await post('install', {
        clientProtocol: 999,
        build: 2,
        sha256: 'a'.repeat(64),
        confirmed: false,
      })
    ).status,
    400,
  );
  busy = true;
  const request = { clientProtocol: 999, build: 2, sha256: 'a'.repeat(64), confirmed: true };
  assert.equal((await post('install', request)).status, 409);
  assert.equal(installs, 0);
  busy = false;
  assert.equal((await post('install', request)).status, 202);
  assert.equal(installs, 1);
  assert.equal(maintenance, true);
  for (let i = 0; i < 6; i++)
    assert.equal(
      (await post('check', { clientProtocol: 1 }, { authorization: 'Bearer bad' })).status,
      401,
    );
  assert.equal((await post('check', { clientProtocol: 1 })).status, 429);
});
test('invalid token disables construction', () => {
  assert.throws(() =>
    managedServerHandler({
      token: 'short',
      backend: {} as ManagedBackend,
      admission: { enter: () => true, leave: () => {} },
    }),
  );
});
test(
  'client disconnect during staging still activates explicitly confirmed upgrade after preparation',
  { timeout: 5000 },
  async (t) => {
    let prepared!: () => void, release!: () => void, activated!: () => void;
    const entered = new Promise<void>((r) => {
      prepared = r;
    });
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const activation = new Promise<void>((r) => {
      activated = r;
    });
    const backend = {
      check: async () => ({}),
      status: async () => ({}),
      prepare: async () => {
        prepared();
        await pending;
      },
      activate: () => {
        activated();
      },
    } as unknown as ManagedBackend;
    const handler = managedServerHandler({
      token,
      backend,
      admission: { enter: () => true, leave: () => {} },
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
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/cc-managed/server/v1/install`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientProtocol: 20,
        confirmed: true,
        build: 2,
        sha256: 'a'.repeat(64),
      }),
    }).catch(() => null);
    await entered;
    controller.abort();
    await request;
    release();
    await activation;
  },
);
