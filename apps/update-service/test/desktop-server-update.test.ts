import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopAccess } from '../src/desktop-access.ts';
import { createUpdateServer } from '../src/http.ts';
import { validateConfig } from '../src/config.ts';
import { UpdateStore } from '../src/store.ts';
import { managedServerHandler, type ManagedBackend } from '../../server/src/managed-server-http.ts';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { validateDesktopTicket } from '../../server/src/desktop-access.ts';
import { serviceJson } from '../../desktop/electron/secure-service.mjs';
import { DatabaseSync } from 'node:sqlite';

test('email upgrade proxy enforces grants, confirmation, TLS pinning and revocation without exposing credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-email-server-update-'));
  const serviceToken = 'fixture-permanent-service-token-123456';
  let calls = 0;
  let installed = 0;
  let centerUrl = '';
  const nodeToken = 'fixture-node-authentication-token-12345678';
  const maintenanceTickets: string[] = [];
  let authorizationUnavailable = false;
  const current = { appVersion: '0.3.7', build: 5, protocol: 22, sha256: null };
  const handler = managedServerHandler({
    token: serviceToken,
    authorizeDesktopTicket: (ticket) => {
      maintenanceTickets.push(ticket);
      if (authorizationUnavailable) throw new Error('simulated authorization network outage');
      return validateDesktopTicket(
        { url: centerUrl, nodeId: 'ubuntu', token: nodeToken, allowLegacy: false },
        ticket,
      );
    },
    backend: {
      check: async () => ({
        schema: 1,
        current,
        candidate: null,
        index: null,
        compatible: true,
        reason: 'current',
      }),
      status: async () => ({ schema: 1, phase: 'idle', current, target: null }),
      prepare: async () => {
        installed++;
      },
      activate() {},
    } as ManagedBackend,
    admission: { enter: () => true, leave() {} },
  });
  const remote = createServer(defaultCertificate, (request, response) => {
    calls++;
    assert.match(request.headers.authorization!, /^Bearer ccs_[A-Za-z0-9_-]{43}$/);
    if (!handler(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  assert.ok(address && typeof address !== 'string');
  const node = {
    name: 'Ubuntu',
    url: `wss://127.0.0.1:${address.port}/ws`,
    fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
    credential: '',
  };
  const config = validateConfig({
    origin: 'https://fixture.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: createHash('sha256').update('fixture-admin').digest('hex'),
    monitorNodes: { ubuntu: createHash('sha256').update(nodeToken).digest('hex') },
    trustedKeys: {
      fixture: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }),
    },
  });
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const access = new DesktopAccess(root);
  access.saveNode('ubuntu', { ...node, credential: '' }, ['ubuntu']);
  const user = {
    email: 'owner@example.com',
    password: 'fixture-password',
    enabled: true,
    nodes: ['ubuntu'],
  };
  const id = await access.saveUser(undefined, user, ['ubuntu']);
  const session = await access.login(user, 'fixture');
  const ticket = access.connect(session.token, 'ubuntu');
  const center = await createUpdateServer(store, config);
  await new Promise<void>((resolve) => center.listen(0, '127.0.0.1', resolve));
  const centerAddress = center.address();
  assert.ok(centerAddress && typeof centerAddress !== 'string');
  centerUrl = `http://127.0.0.1:${centerAddress.port}`;
  t.after(async () => {
    center.closeAllConnections();
    remote.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => center.close(() => resolve())),
      new Promise<void>((resolve) => remote.close(() => resolve())),
    ]);
    access.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = async (action: string, input: unknown, token = session.token) => {
    const response = await fetch(
      `http://127.0.0.1:${centerAddress.port}/cc-access/v1/server/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const check = { nodeId: 'ubuntu', clientProtocol: 22 };
  assert.equal((await request('check', check, ticket.token)).status, 401);
  assert.equal((await request('check', { ...check, nodeId: 'other' })).status, 403);
  assert.equal(
    (await request('check', { ...check, url: 'https://untrusted.invalid' })).status,
    400,
  );
  assert.equal(calls, 0);
  const result = await request('check', check);
  assert.equal(result.status, 200);
  assert.equal(result.body.reason, 'current');
  assert.ok(!JSON.stringify(result.body).includes(serviceToken));
  assert.equal(access.status(['ubuntu']).nodes[0]!.credentialSaved, false);
  assert.ok(access.validate(ticket.token, 'ubuntu', false));
  assert.throws(() => access.validate(maintenanceTickets[0]!, 'ubuntu', false), /失效/);
  await assert.rejects(
    serviceJson({ ...node, token: maintenanceTickets[0]! }, 'GET', '/cc-managed/server/v1/status'),
    { status: 401 },
  );
  const install = { ...check, confirmed: true, build: 6, sha256: 'a'.repeat(64) };
  assert.equal((await request('install', { ...install, confirmed: false })).status, 400);
  assert.equal(installed, 0);
  assert.equal((await request('install', install)).status, 200);
  assert.equal(installed, 1);
  assert.equal((await request('status', { nodeId: 'ubuntu' })).status, 200);
  assert.equal(new Set(maintenanceTickets).size, 3);
  for (const value of maintenanceTickets)
    assert.throws(() => access.validate(value, 'ubuntu', false), /失效/);
  authorizationUnavailable = true;
  for (let i = 0; i < 7; i++) {
    const unavailable = await request('status', { nodeId: 'ubuntu' });
    assert.equal(unavailable.status, 502);
    assert.match(JSON.stringify(unavailable.body), /网络请求失败/);
  }
  authorizationUnavailable = false;
  assert.equal((await request('status', { nodeId: 'ubuntu' })).status, 200);
  access.saveNode('ubuntu', { ...node, fingerprint: '0'.repeat(64) }, ['ubuntu']);
  const before = calls;
  assert.equal((await request('check', check)).status, 502);
  assert.equal(calls, before);
  const db = new DatabaseSync(join(root, 'private', 'desktop-access.sqlite'));
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM tickets').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM server_tickets').get()!.n, 0);
  } finally {
    db.close();
  }
  assert.ok(access.validate(ticket.token, 'ubuntu', false));
  access.saveNode('ubuntu', node, ['ubuntu']);
  await access.saveUser(id, { ...user, enabled: false }, ['ubuntu']);
  assert.equal((await request('status', { nodeId: 'ubuntu' })).status, 401);
  assert.equal(calls, before);
  await assert.rejects(
    serviceJson({ ...node, token: ticket.token }, 'GET', '/cc-managed/server/v1/status'),
    { status: 401 },
  );
});
