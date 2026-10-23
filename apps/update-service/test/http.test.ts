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
import { PasswordAuth } from '../src/password-auth.ts';

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

test('password setup/login require same-origin requests, sessions authorize admin API and logout revokes them', async (t) => {
  const f = await fixture(t);
  const password = '管理员密码测试_2026_secure';
  const auth = new PasswordAuth(join(f.root, 'private'));
  const code = await auth.issueSetup();
  const post = (path: string, data: unknown, origin = f.config.origin) =>
    f.request(api + '/auth/' + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
  assert.equal(
    (await post('setup', { setupToken: code, password }, 'https://wrong.invalid')).status,
    403,
  );
  assert.equal((await post('setup', { setupToken: code, password, extra: true })).status, 400);
  const setup = await post('setup', { setupToken: code, password });
  assert.equal(setup.status, 200);
  const { sessionToken } = await setup.json();
  const sessionHeaders = { authorization: `Bearer ${sessionToken}`, origin: f.config.origin };
  assert.equal((await f.request(api + '/status', { headers: sessionHeaders })).status, 200);
  assert.equal((await post('setup', { setupToken: code, password })).status, 401);
  assert.equal((await post('login', { password: 'wrong_password_2026' })).status, 401);
  const logged = await post('login', { password });
  assert.equal(logged.status, 200);
  assert.ok((await logged.json()).sessionToken);
  assert.equal(
    (await f.request(api + '/auth/logout', { method: 'POST', headers: sessionHeaders })).status,
    204,
  );
  assert.equal((await f.request(api + '/status', { headers: sessionHeaders })).status, 401);
  assert.equal((await f.request(api + '/status', { headers: f.headers })).status, 200);
});

test('password login attempts share rate limiting and bound JSON body size', async (t) => {
  const f = await fixture(t);
  const password = 'local_password_fixture_2026';
  const auth = new PasswordAuth(join(f.root, 'private'));
  await auth.setup(await auth.issueSetup(), password);
  const login = (value: string) =>
    f.request(api + '/auth/login', {
      method: 'POST',
      headers: { origin: f.config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ password: value }),
    });
  assert.equal((await login('x'.repeat(2049))).status, 413);
  for (let attempt = 0; attempt < 30; attempt++) assert.equal((await login('short')).status, 401);
  assert.equal((await login(password)).status, 429);
  assert.equal((await f.request(api + '/status', { headers: f.headers })).status, 200);
});

test('password change requires admin authentication, same origin and correct current password', async (t) => {
  const f = await fixture(t);
  const auth = new PasswordAuth(join(f.root, 'private'));
  await auth.setup(await auth.issueSetup(), 'oldpwd12');
  const login = await f.request(api + '/auth/login', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ password: 'oldpwd12' }),
  });
  const { sessionToken } = await login.json();
  const headers = { ...f.headers, authorization: `Bearer ${sessionToken}` };
  const change = (data: unknown, custom = headers) =>
    f.request(api + '/auth/password', {
      method: 'POST',
      headers: custom,
      body: JSON.stringify(data),
    });
  const input = { currentPassword: 'oldpwd12', newPassword: 'newpwd34' };
  assert.equal((await change(input, { ...headers, authorization: '' })).status, 401);
  assert.equal((await change(input, { ...headers, origin: 'https://wrong.invalid' })).status, 403);
  assert.equal((await change({ ...input, newPassword: '1234567' })).status, 400);
  const wrong = await change({ ...input, currentPassword: 'incorrect' });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /当前密码不正确/);
  assert.equal((await f.request(api + '/status', { headers })).status, 200);
  const changed = await change(input);
  assert.equal(changed.status, 200);
  const replacement = (await changed.json()).sessionToken;
  assert.equal((await f.request(api + '/status', { headers })).status, 401);
  assert.equal(
    (
      await f.request(api + '/status', {
        headers: { ...headers, authorization: `Bearer ${replacement}` },
      })
    ).status,
    200,
  );
  assert.equal((await f.request(api + '/status', { headers: f.headers })).status, 200);
});

test('moderation shares administrator auth, keeps credentials private and records fail-closed previews', async (t) => {
  const f = await fixture(t);
  const path = `${api}/moderation`;
  for (const suffix of ['/config', '/events', '/usage'])
    assert.equal((await f.request(path + suffix)).status, 401);
  const read = async () => (await f.request(path + '/config', { headers: f.headers })).json();
  const config = await read();
  assert.equal(config.mode, 'keyword_and_api');
  assert.equal(config.enforcement, 'not-connected');
  assert.equal(config.apiKey, undefined);
  const usage = await (await f.request(path + '/usage', { headers: f.headers })).json();
  assert.equal(usage.requests, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.remainingTokens, null);
  assert.equal(usage.remainingBalance, null);
  const { apiKeyConfigured, enforcement, rulesVersion, ...editable } = config;
  const input = { ...editable, keywords: ['block'], apiKey: 'http_fixture_secret_key' };
  const put = (data: unknown, headers = f.headers) =>
    f.request(path + '/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify(data),
    });
  assert.equal((await put(input, { ...f.headers, origin: 'https://wrong.invalid' })).status, 403);
  const saved = await put(input);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).apiKeyConfigured, true);
  assert.ok(!JSON.stringify(await read()).includes(input.apiKey));
  assert.equal((await put(input)).status, 409);
  const preview = await f.request(path + '/preview', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ text: 'BLOCK me' }),
  });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).action, 'keyword_block');
  const {
    apiKeyConfigured: configured,
    enforcement: connected,
    rulesVersion: rules,
    ...latest
  } = await read();
  assert.equal((await put({ ...latest, apiKey: '' })).status, 200);
  const failure = await f.request(path + '/preview', {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({ text: 'not matched' }),
  });
  const failed = await failure.json();
  assert.equal(failed.allowed, false);
  assert.equal(failed.error, 'jev_key_missing');
  const events = await (await f.request(path + '/events', { headers: f.headers })).json();
  assert.ok(events.some((event: { id: string }) => event.id === failed.id));
  assert.ok(!JSON.stringify(events).includes(input.apiKey));
  assert.ok(!JSON.stringify(events).includes('not matched'));
  assert.equal(
    (
      await f.request(path + '/preview', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify({ text: 'ok', apiKey: 'bad' }),
      })
    ).status,
    400,
  );
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
