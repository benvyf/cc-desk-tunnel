import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createUpdateServer } from '../src/http.ts';
import { UpdateStore } from '../src/store.ts';
import { validateConfig } from '../src/config.ts';
import { createProxyServer } from '../../server/src/server.ts';
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/index.ts';

test('trusted proxy addresses isolate IP throttling while account throttling is shared', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-access-ip-'));
  const config = validateConfig({
    origin: 'https://fixture.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: createHash('sha256').update('admin').digest('hex'),
    trustedKeys: {
      test: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }),
    },
  });
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const server = await createUpdateServer(store, config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  async function attempt(ip: string, email: string) {
    const response = await fetch(`http://127.0.0.1:${port}/cc-access/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': ip },
      body: JSON.stringify({ email, password: 'incorrect' }),
    });
    await response.text();
    return response.status;
  }
  for (let i = 0; i < 10; i++) assert.equal(await attempt('192.0.2.1', 'one@example.com'), 401);
  assert.equal(await attempt('192.0.2.1', 'two@example.com'), 429);
  assert.equal(await attempt('192.0.2.2', 'one@example.com'), 429);
  assert.equal(await attempt('192.0.2.2', 'two@example.com'), 401);
});

test(
  'real management HTTP, desktop handshake and live revocation without any Claude request',
  { timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cc-access-integration-'));
    const admin = 'a'.repeat(43),
      nodeToken = 'n'.repeat(43),
      origin = 'https://fixture.invalid';
    const hash = (x: string) => createHash('sha256').update(x).digest('hex');
    const config = validateConfig({
      origin,
      dataDir: root,
      port: 8817,
      adminName: 'fixture',
      adminTokenSha256: hash(admin),
      monitorNodes: { 'ubuntu-cc': hash(nodeToken) },
      trustedKeys: {
        test: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }),
      },
    });
    const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
    const management = await createUpdateServer(store, config);
    await new Promise<void>((resolve) => management.listen(0, '127.0.0.1', resolve));
    const address = management.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (
      path: string,
      token: string,
      input?: unknown,
      method = input === undefined ? 'GET' : 'POST',
      adminRequest = false,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          ...(adminRequest ? { origin } : {}),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
    const proxy = createProxyServer({
      token: 'old-manual-token'.repeat(3),
      dataDir: join(root, 'proxy'),
      desktopAccess: {
        url: base + '/cc-updates/admin/api/monitor/report',
        nodeId: 'ubuntu-cc',
        token: nodeToken,
        allowLegacy: false,
      },
    });
    const proxyUrl = await proxy.listen(0);
    const sockets: WebSocket[] = [];
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await proxy.close();
      management.closeAllConnections();
      await new Promise<void>((r) => management.close(() => r()));
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    const api = '/cc-updates/admin/api/desktop-access';
    assert.equal((await request(api, nodeToken)).status, 401);
    assert.equal(
      (
        await request(
          api + '/nodes/ubuntu-cc',
          admin,
          { name: 'Ubuntu', url: 'wss://example.test/ws', fingerprint: '' },
          'PUT',
          true,
        )
      ).status,
      200,
    );
    const userInput = {
      email: 'me@example.com',
      password: 'test-password',
      enabled: true,
      nodes: ['ubuntu-cc'],
    };
    const saved = await request(api + '/users', admin, userInput, 'POST', true);
    assert.equal(saved.status, 200);
    const users = await saved.json();
    const loginResponse = await request('/cc-access/v1/login', '', {
      email: userInput.email,
      password: userInput.password,
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    assert.equal((await request(api, login.token)).status, 401);
    const ticketResponse = await request('/cc-access/v1/connect', login.token, {
      nodeId: 'ubuntu-cc',
    });
    const ticket = await ticketResponse.json();
    assert.ok(ticket.token.startsWith('ccs_'));
    assert.equal(
      (
        await request('/cc-access/v1/validate', 'wrong', {
          nodeId: 'ubuntu-cc',
          ticket: ticket.token,
          renewal: false,
        })
      ).status,
      401,
    );
    const socket = new WebSocket(proxyUrl.replace('http', 'ws') + '/ws');
    sockets.push(socket);
    const messages: Record<string, any>[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await once(socket, 'open');
    socket.send(
      JSON.stringify({
        type: 'auth',
        protocolVersion: PROTOCOL_VERSION,
        token: ticket.token,
        deviceName: 'test-desktop',
      }),
    );
    socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
    const wait = async (predicate: () => boolean) => {
      const until = Date.now() + 4000;
      while (!predicate() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      assert.ok(predicate());
    };
    await wait(() => messages.some((x) => x.type === 'ready'));
    await wait(() =>
      messages.some(
        (x) => x.type === 'devices' && x.devices.some((d: any) => d.name === 'test-desktop'),
      ),
    );
    assert.equal((await fetch(proxyUrl + '/')).status, 403, 'legacy web entry disabled');
    const closed = once(socket, 'close');
    assert.equal(
      (
        await request(
          api + '/users/' + users.users[0].id,
          admin,
          { ...userInput, password: '', enabled: false },
          'POST',
          true,
        )
      ).status,
      200,
    );
    assert.equal((await request('/cc-access/v1/workspaces', login.token)).status, 401);
    const [code] = await closed;
    assert.equal(code, 4001);
    assert.ok(messages.some((x) => x.type === 'connection.error' && x.code === 'unauthorized'));
  },
);
