import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { signIndex } from '../../../packages/managed-updates/src/index.ts';
import { UpdateStore } from '../src/store.ts';
import { createUpdateServer } from '../src/http.ts';
import { validateConfig } from '../src/config.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cc-update-http-'));
  const keys = generateKeyPairSync('ed25519');
  const token = 'temporary_test_admin_token_1234567890';
  const origin = 'https://updates.example.invalid';
  const config = validateConfig({
    origin,
    dataDir: root,
    port: 8817,
    adminName: 'test-admin',
    adminTokenSha256: createHash('sha256').update(token).digest('hex'),
    trustedKeys: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }) },
  });
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const server = await createUpdateServer(store, config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('installer HTTP fixture');
  const signed = signIndex(
    {
      schema: 1,
      product: 'cc-desk-tunnel-managed',
      channel: 'pilot',
      platform: 'win32',
      arch: 'x64',
      revision: 1,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      state: 'published',
      release: {
        build: 1,
        appVersion: '0.3.6',
        protocol: 20,
        sourceCommit: 'a'.repeat(40),
        notes: '<img src=x onerror=alert(1)>',
        filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
    'test',
    keys.privateKey,
  );
  const headers = { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' };
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, init);
  return { root, config, store, server, request, headers, bytes, signed };
}
const api = '/cc-updates/admin/api';

test('each administration feature has an exact public shell address and rejects writes', async (t) => {
  const f = await fixture(t);
  for (const page of ['accounts', 'updates', 'moderation']) {
    const path = '/cc-updates/admin/' + page;
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    assert.match(await response.text(), /aria-label="管理分区"/);
    assert.equal((await f.request(path, { method: 'HEAD' })).status, 200);
    assert.equal((await f.request(path, { method: 'POST' })).status, 405);
  }
  assert.equal((await f.request('/cc-updates/admin/navigation.js')).status, 200);
  assert.equal((await f.request('/cc-updates/admin/missing-feature')).status, 404);
  assert.equal((await f.request('/cc-updates/admin/accounts/extra')).status, 404);
});

test('HTTP provides authenticated create/upload/activate and exact public signed GET/HEAD', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/cc-updates/v1/channels/pilot/win32-x64.json')).status, 404);
  const created = await f.request(`${api}/candidates`, {
    method: 'POST',
    headers: f.headers,
    body: f.signed.toString(),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const upload = await f.request(`${api}/candidates/${id}/artifact`, {
    method: 'PUT',
    headers: { ...f.headers, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(f.bytes),
  });
  assert.equal(upload.status, 204);
  const activation = await f.request(`${api}/candidates/${id}/activate`, {
    method: 'POST',
    headers: f.headers,
    body: '{}',
  });
  assert.equal(activation.status, 200);
  const publicIndex = await f.request('/cc-updates/v1/channels/pilot/win32-x64.json');
  assert.deepEqual(Buffer.from(await publicIndex.arrayBuffer()), f.signed);
  assert.equal(publicIndex.headers.get('cache-control'), 'no-store');
  const head = await f.request('/cc-updates/v1/channels/pilot/win32-x64.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const status = await f.request(`${api}/status`, { headers: f.headers });
  assert.equal((await status.json()).channels.length, 1);
});

test('management rejects missing/wrong tokens, wrong/missing Origin and wrong content types', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(`${api}/status`)).status, 401);
  assert.equal(
    (await f.request(`${api}/status`, { headers: { authorization: 'Bearer bad' } })).status,
    401,
  );
  for (const origin of [undefined, 'null', 'https://attacker.invalid']) {
    const headers: Record<string, string> = {
      authorization: f.headers.authorization,
      'content-type': 'application/json',
    };
    if (origin) headers.origin = origin;
    assert.equal(
      (await f.request(`${api}/candidates`, { method: 'POST', headers, body: f.signed.toString() }))
        .status,
      403,
    );
  }
  assert.equal(
    (
      await f.request(`${api}/candidates`, {
        method: 'POST',
        headers: { ...f.headers, 'content-type': 'text/plain' },
        body: f.signed.toString(),
      })
    ).status,
    415,
  );
  assert.equal(
    (await f.request(`${api}/candidates`, { method: 'POST', headers: f.headers, body: '{}' }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(`${api}/candidates`, {
        method: 'POST',
        headers: f.headers,
        body: ' '.repeat(65537),
      })
    ).status,
    413,
  );
  assert.equal(f.store.status().candidates.length, 0);
});

test('page has restrictive headers and API exposes no filesystem routes or URL token fallback', async (t) => {
  const f = await fixture(t);
  const page = await f.request('/cc-updates/admin/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('set-cookie'), null);
  for (const path of [
    '/cc-updates/private/state.sqlite',
    '/cc-updates/admin/../private/state.sqlite',
    `${api}/status?token=secret`,
    '/cc-updates/admin/web/index.html',
  ]) {
    assert.notEqual((await f.request(path, { headers: f.headers })).status, 200);
  }
  assert.equal(
    (await f.request('/cc-updates/v1/channels/pilot/win32-x64.json', { method: 'POST' })).status,
    405,
  );
  const script = await (await f.request('/cc-updates/admin/app.js')).text();
  assert.doesNotMatch(script, /innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('authentication failure limiter bounds repeated token guessing', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) await f.request(`${api}/status`);
  assert.equal((await f.request(`${api}/status`)).status, 429);
  assert.equal((await f.request(`${api}/status`, { headers: f.headers })).status, 200);
});

test('configuration rejects unknown fields, insecure origins, unsafe paths and private keys', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const base = {
    origin: 'https://updates.example.invalid',
    dataDir: tmpdir(),
    port: 8817,
    adminName: 'admin',
    adminTokenSha256: 'a'.repeat(64),
    trustedKeys: { test: publicKey.export({ type: 'spki', format: 'pem' }) },
  };
  assert.equal(validateConfig(base).origin, base.origin);
  for (const override of [
    { extra: 1 },
    { origin: 'http://updates.example.invalid' },
    { origin: 'https://user:pass@example.invalid' },
    { origin: 'https://example.invalid/path' },
    { dataDir: '.' },
    { port: 0 },
    { adminTokenSha256: 'invalid' },
    { trustedKeys: {} },
    { trustedKeys: { test: privateKey.export({ type: 'pkcs8', format: 'pem' }) } },
  ])
    assert.throws(() => validateConfig({ ...base, ...override }));
});
