import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../src/config.ts';
import { createUpdateServer } from '../src/http.ts';
import { PasswordAuth } from '../src/password-auth.ts';
import { UpdateStore } from '../src/store.ts';

test('monitor coexists with password login and moderation without external model requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-monitor-integration-'));
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const admin = 'synthetic_admin_123456789012345678901234';
  const node = 'synthetic_monitor_1234567890123456789012';
  const reviewer = 'synthetic_reviewer_123456789012345678901'.padEnd(43, '0');
  const origin = 'https://fixture.example.invalid';
  const config = validateConfig({
    origin,
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: hash(admin),
    trustedKeys: {
      fixture: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }),
    },
    monitorNodes: { fixture: hash(node) },
  });
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const auth = new PasswordAuth(join(root, 'private'));
  const setupToken = await auth.issueSetup();
  await writeFile(
    join(root, 'private/moderation-nodes.json'),
    JSON.stringify({ reviewer: hash(reviewer) }),
  );
  const server = await createUpdateServer(store, config);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const api = '/cc-updates/admin/api';
  const request = (path: string, token = admin, method = 'GET', data?: unknown, browser = true) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(browser ? { origin } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const session = await (
    await request(api + '/auth/setup', '', 'POST', { setupToken, password: 'synthetic password' })
  ).json();
  assert.equal(typeof session.sessionToken, 'string');
  const login = await request(api + '/auth/login', '', 'POST', { password: 'synthetic password' });
  assert.equal(login.status, 200);
  const token = (await login.json()).sessionToken;
  const before = await (await request(api + '/moderation/config', token)).json();
  const observedAt = new Date().toISOString();
  const report = {
    schema: 2,
    nodeId: 'fixture',
    observedAt,
    account: {
      id: hash('synthetic@example.invalid'),
      email: 'synthetic@example.invalid',
      subscriptionType: 'max',
      organization: null,
      authMethod: null,
      apiProvider: null,
    },
    identity: { state: 'identified', measuredAt: observedAt },
    quotaStatus: { state: 'unknown', measuredAt: null },
    rateLimits: null,
    usage: null,
  };
  assert.equal((await request(api + '/monitor/report', node, 'POST', report, false)).status, 204);
  assert.equal((await request(api + '/monitor', token)).status, 200);
  assert.equal(
    (
      await request(api + '/monitor/accounts/' + report.account.id + '/note', token, 'PUT', {
        note: 'fixture note',
      })
    ).status,
    204,
  );
  assert.equal(
    (await (await request(api + '/monitor', token)).json()).accounts[0].note,
    'fixture note',
  );
  for (const path of ['/monitor', '/moderation/config', '/status'])
    assert.equal((await request(api + path, node)).status, 401);
  assert.equal(
    (await request(api + '/monitor/report', reviewer, 'POST', report, false)).status,
    401,
  );
  assert.equal(
    (await request('/cc-updates/v1/moderation/check', node, 'POST', {}, false)).status,
    401,
  );
  assert.equal(
    (await request('/cc-updates/v1/moderation/check', reviewer, 'POST', {}, false)).status,
    400,
  );
  assert.deepEqual(await (await request(api + '/moderation/config', token)).json(), before);
  for (const asset of ['moderation.js', 'password-login.js', 'app.js'])
    assert.equal((await fetch(base + '/cc-updates/admin/' + asset)).status, 200);
  assert.equal((await request(api + '/auth/logout', token, 'POST')).status, 204);
  assert.equal((await request(api + '/monitor', token)).status, 401);
});
