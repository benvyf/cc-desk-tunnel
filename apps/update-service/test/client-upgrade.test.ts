import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateStore } from '../src/store.ts';
import { DesktopAccess } from '../src/desktop-access.ts';
import { HostUpdates } from '../src/host-updates.ts';
import { createUpdateServer } from '../src/http.ts';
import { validateConfig } from '../src/config.ts';
import type {
  ServerRelease,
  SignedServerIndex,
} from '../../../packages/managed-server/src/index.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'client-upgrade-gate-'));
  const config = validateConfig({
    origin: 'https://fixture.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: 'a'.repeat(64),
    trustedKeys: {
      fixture: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
    },
    monitorNodes: { 'ubuntu-cc': 'b'.repeat(64), other: 'c'.repeat(64) },
  });
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const access = new DesktopAccess(root),
    hosts = new HostUpdates(root, () => ['ubuntu-cc', 'other']);
  for (const id of ['ubuntu-cc', 'other'])
    access.saveNode(id, { name: id, url: 'wss://example.invalid/ws', credential: '' }, [
      'ubuntu-cc',
      'other',
    ]);
  const input = {
    email: 'owner@example.com',
    password: 'fixture-password',
    enabled: true,
    nodes: ['ubuntu-cc'],
  };
  await access.saveUser(undefined, input, ['ubuntu-cc', 'other']);
  const session = await access.login(input, 'fixture');
  const grant = hosts.issue('ubuntu-cc');
  const host = hosts.enroll({ nodeId: 'ubuntu-cc', code: grant.code });
  const heartbeat = (protocol: number, phase = 'idle', now = Date.now()) =>
    hosts.poll(host.token, { nodeId: 'ubuntu-cc', current: { build: 9, protocol, phase } }, now);
  heartbeat(23);
  const server = await createUpdateServer(store, config);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const post = (body: unknown, token = session.token) =>
    fetch(`http://127.0.0.1:${addr.port}/cc-access/v1/connect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    hosts.close();
    access.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { access, hosts, host, session, post, heartbeat };
}

test('deployed legacy request is rejected before replacing a connection ticket with clear upgrade text', async (t) => {
  const f = await fixture(t),
    previous = f.access.connect(f.session.token, 'ubuntu-cc');
  const response = await f.post({ nodeId: 'ubuntu-cc' });
  assert.equal(response.status, 426);
  const body = await response.json();
  assert.equal(body.code, 'client_upgrade_required');
  assert.equal(body.requiredProtocol, 23);
  assert.match(body.error, /升级客户端/);
  assert.ok(f.access.validate(previous.token, 'ubuntu-cc', false));
  assert.equal(f.access.workspaces(f.session.token).length, 1);
});

test('target actual protocol controls the gate: compatible older builds pass and newer clients get server guidance', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post({ nodeId: 'ubuntu-cc', client: { build: 25, protocol: 23 } })).status,
    200,
  );
  const newer = await f.post({ nodeId: 'ubuntu-cc', client: { build: 26, protocol: 24 } });
  assert.equal(newer.status, 426);
  const body = await newer.json();
  assert.equal(body.code, 'server_upgrade_required');
  assert.match(body.error, /服务端/);
  f.heartbeat(22);
  assert.equal((await f.post({ nodeId: 'ubuntu-cc' })).status, 200);
  assert.equal(
    (await f.post({ nodeId: 'ubuntu-cc', client: { build: 1, protocol: 22 } })).status,
    200,
  );
});

test('version checks do not leak unauthorized workspaces and malformed metadata does not masquerade as legacy', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ nodeId: 'ubuntu-cc' }, 'wrong-session')).status, 401);
  assert.equal((await f.post({ nodeId: 'other' })).status, 403);
  for (const client of [
    null,
    { build: 25, protocol: '23' },
    { build: 0, protocol: 23 },
    { build: 25, protocol: 23, url: 'https://untrusted.invalid' },
  ])
    assert.equal((await f.post({ nodeId: 'ubuntu-cc', client })).status, 400);
});

test('stale, unsettled or currently upgrading host observations leave validation to the handshake', async (t) => {
  const f = await fixture(t);
  f.heartbeat(23, 'idle', Date.now() - 100000);
  assert.equal((await f.post({ nodeId: 'ubuntu-cc' })).status, 200);
  f.heartbeat(23, 'stopping');
  assert.equal((await f.post({ nodeId: 'ubuntu-cc' })).status, 200);
  f.heartbeat(23);
  f.hosts.enqueue(
    'ubuntu-cc',
    { confirmed: true, build: 10, sha256: 'd'.repeat(64) },
    { build: 10, protocol: 23, sha256: 'd'.repeat(64) } as ServerRelease,
    {} as SignedServerIndex,
  );
  assert.equal((await f.post({ nodeId: 'ubuntu-cc' })).status, 200);
});
