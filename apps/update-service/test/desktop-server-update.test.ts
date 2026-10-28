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

test('email upgrade proxy enforces grants, confirmation, TLS pinning and revocation without exposing credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-email-server-update-'));
  const serviceToken = 'fixture-permanent-service-token-123456';
  let calls = 0;
  let installed = 0;
  const current = { appVersion: '0.3.7', build: 5, protocol: 22, sha256: null };
  const handler = managedServerHandler({
    token: serviceToken,
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
    assert.equal(request.headers.authorization, `Bearer ${serviceToken}`);
    if (!handler(request, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  assert.ok(address && typeof address !== 'string');
  const node = {
    name: 'Ubuntu',
    url: `wss://127.0.0.1:${address.port}/ws`,
    fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
    credential: serviceToken,
  };
  const config = validateConfig({
    origin: 'https://fixture.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: createHash('sha256').update('fixture-admin').digest('hex'),
    monitorNodes: { ubuntu: createHash('sha256').update('fixture-node').digest('hex') },
    trustedKeys: {
      fixture: generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }),
    },
  });
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const access = new DesktopAccess(root);
  access.saveNode('ubuntu', node, ['ubuntu']);
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
  const install = { ...check, confirmed: true, build: 6, sha256: 'a'.repeat(64) };
  assert.equal((await request('install', { ...install, confirmed: false })).status, 400);
  assert.equal(installed, 0);
  assert.equal((await request('install', install)).status, 200);
  assert.equal(installed, 1);
  assert.equal((await request('status', { nodeId: 'ubuntu' })).status, 200);
  access.saveNode('ubuntu', { ...node, fingerprint: '0'.repeat(64) }, ['ubuntu']);
  const before = calls;
  assert.equal((await request('check', check)).status, 502);
  assert.equal(calls, before);
  access.saveNode('ubuntu', node, ['ubuntu']);
  await access.saveUser(id, { ...user, enabled: false }, ['ubuntu']);
  assert.equal((await request('status', { nodeId: 'ubuntu' })).status, 401);
  assert.equal(calls, before);
});
