import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { createDesktopAccess } = createRequire(import.meta.url)('../electron/desktop-access.cjs');

test('an unreadable upgrade response remains uncertain, while missing routes and expired sessions are actionable', async () => {
  let response;
  let expired = 0;
  const access = createDesktopAccess({
    read: () => null,
    write() {},
    storage: { isEncryptionAvailable: () => false },
    onExpired: () => expired++,
    request: async (url) =>
      url.endsWith('/login')
        ? Response.json({ email: 'owner@example.com', token: 'private-session', workspaces: [] })
        : response,
  });
  await access.login({ email: 'owner@example.com', password: 'test-password' });
  for (const body of ['{', 'null']) {
    response = new Response(body, { status: 200 });
    await assert.rejects(
      access.serverRequest('node', '/cc-managed/server/v1/install', {}),
      /网络请求失败/,
    );
    assert.equal(expired, 0);
  }
  response = new Response('Not found.', { status: 404 });
  await assert.rejects(
    access.serverRequest('node', '/cc-managed/server/v1/check', {}),
    /管理中心尚未启用/,
  );
  response = new Response('{', { status: 401 });
  await assert.rejects(access.serverRequest('node', '/cc-managed/server/v1/status', {}));
  assert.equal(expired, 1, 'even an unreadable 401 must expire the email session');
  await assert.rejects(access.serverRequest('node', '/cc-managed/server/v1/status', {}), /先登录/);
});

test('server management uses the private email session, bounded routes and rejects stale results after logout', async () => {
  const calls = [];
  let finish;
  const access = createDesktopAccess({
    read: () => null,
    write() {},
    storage: { isEncryptionAvailable: () => false },
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/login'))
        return Response.json({
          email: 'owner@example.com',
          token: 'private-session',
          workspaces: [],
        });
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await access.login({ email: 'owner@example.com', password: 'test-password' });
  await assert.rejects(access.serverRequest('node', '/arbitrary', {}), /无效/);
  const pending = access.serverRequest('node', '/cc-managed/server/v1/check', {
    clientProtocol: 22,
  });
  assert.equal(calls.at(-1).url, 'https://api.ghostapi.org/cc-access/v1/server/check');
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer private-session');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { nodeId: 'node', clientProtocol: 22 });
  const rejected = assert.rejects(pending, /失效/);
  await access.logout();
  finish(Response.json({ schema: 1 }));
  await rejected;
  await assert.rejects(access.serverRequest('node', '/cc-managed/server/v1/status'), /先登录/);
});
test('main process stores encrypted session only, restores and renews tickets, logs out', async () => {
  let saved,
    calls = [];
  const access = createDesktopAccess({
    read: () => saved,
    write: (value) => {
      saved = value;
    },
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from('encrypted:' + text),
      decryptString: (bytes) => bytes.toString().slice(10),
    },
    request: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/login'))
        return Response.json({
          email: 'me@example.com',
          token: 'session-secret',
          workspaces: [{ id: 'ubuntu-cc', name: 'Ubuntu' }],
        });
      if (url.endsWith('/workspaces'))
        return Response.json({ workspaces: [{ id: 'ubuntu-cc', name: 'Ubuntu' }] });
      if (url.endsWith('/connect'))
        return Response.json({
          url: 'wss://node.example/ws',
          fingerprint: '',
          token: 'ccs_' + 'x'.repeat(43),
        });
      return new Response(null, { status: 204 });
    },
  });
  const result = await access.login({
    email: 'me@example.com',
    password: 'password-not-stored',
    remember: true,
    autoLogin: true,
  });
  assert.ok(!JSON.stringify(result).includes('session-secret'));
  assert.ok(!JSON.stringify(saved).includes('password-not-stored'));
  assert.equal(saved.token, Buffer.from('encrypted:session-secret').toString('base64'));
  assert.equal(access.load().autoLogin, true);
  await access.login({ email: 'me@example.com', password: '', remember: true, autoLogin: true });
  assert.ok(calls.some((x) => x.url.endsWith('/workspaces')));
  assert.ok((await access.ticket('ubuntu-cc')).token.startsWith('ccs_'));
  await access.logout();
  assert.equal(saved, null);
  await assert.rejects(access.ticket('ubuntu-cc'), /先登录/);
  assert.equal(calls.at(-1).options.headers.authorization, 'Bearer session-secret');
});
test('untrusted connection metadata and network errors are rejected', async () => {
  let bad = false;
  const access = createDesktopAccess({
    read: () => null,
    write() {},
    storage: { isEncryptionAvailable: () => false },
    request: async (url) => {
      if (bad) throw new Error('network');
      if (url.endsWith('/login'))
        return Response.json({ email: 'me@example.com', token: 'session', workspaces: [] });
      return Response.json({
        url: 'http://untrusted.example',
        token: 'ccs_' + 'x'.repeat(43),
        fingerprint: '',
      });
    },
  });
  await access.login({ email: 'me@example.com', password: 'password', remember: false });
  await assert.rejects(access.ticket('node'), /配置无效/);
  bad = true;
  await assert.rejects(access.ticket('node'), /无法连接/);
});

test('expired remembered authorization is cleared; temporary failures keep it and remain retryable', async () => {
  let saved = null;
  let status = 200;
  const access = createDesktopAccess({
    read: () => saved,
    write: (value) => {
      saved = value;
    },
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString(),
    },
    request: async () =>
      status === 200
        ? Response.json({ email: 'me@example.com', token: 'session', workspaces: [] })
        : status === 502
          ? new Response('<html>Bad gateway</html>', { status })
          : Response.json({ error: '登录已失效，请重新登录。' }, { status }),
  });
  await access.login({ email: 'me@example.com', password: 'password', remember: true });
  status = 502;
  await assert.rejects(access.ticket('node'), (error) => error.retryable === true);
  assert.ok(saved, 'transient gateway failure preserves remembered session');
  status = 401;
  await assert.rejects(access.ticket('node'), /登录已失效/);
  assert.equal(saved, null);
  assert.equal(access.load(), null);
  await assert.rejects(access.ticket('node'), /先登录/);
});

test('late login, ticket and expired-session responses cannot undo logout or a newer login', async () => {
  let saved = null;
  let defer = '';
  let respond;
  const connection = {
    url: 'wss://node.example/ws',
    fingerprint: '',
    token: 'ccs_' + 'x'.repeat(43),
  };
  const access = createDesktopAccess({
    read: () => saved,
    write: (value) => {
      saved = value;
    },
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString(),
    },
    request: async (url, options) => {
      if (defer && url.endsWith('/' + defer))
        return new Promise((resolve) => {
          respond = resolve;
        });
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      if (url.endsWith('/connect')) return Response.json(connection);
      const input = JSON.parse(options.body);
      return Response.json({ email: input.email, token: input.email, workspaces: [] });
    },
  });
  const input = (email) => ({ email, password: 'password', remember: true });
  await access.login(input('first@example.com'));
  defer = 'connect';
  const oldTicket = access.ticket('node');
  const oldRejected = assert.rejects(oldTicket, /失效/);
  await access.login(input('second@example.com'));
  respond(Response.json({ error: '登录已失效' }, { status: 401 }));
  await oldRejected;
  assert.equal(saved.email, 'second@example.com');
  defer = '';
  assert.equal((await access.ticket('node')).token, connection.token);

  defer = 'connect';
  const ticket = access.ticket('node');
  const ticketCancelled = assert.rejects(ticket, /取消/);
  await access.logout();
  respond(Response.json(connection));
  await ticketCancelled;
  assert.equal(saved, null);

  defer = 'login';
  const login = access.login(input('first@example.com'));
  const loginCancelled = assert.rejects(login, /取消/);
  await access.logout();
  respond(Response.json({ email: 'first@example.com', token: 'late-token', workspaces: [] }));
  await loginCancelled;
  assert.equal(saved, null);
  await assert.rejects(access.ticket('node'), /先登录/);
});

test('background authorization checks clear revoked sessions but tolerate outages and ignore stale responses', async () => {
  let saved = null;
  let status = 200;
  let defer = false;
  let finish;
  let deferLogin = false;
  let finishLogin;
  const expired = [];
  const requests = [];
  const options = {
    read: () => saved,
    write: (value) => {
      saved = value;
    },
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString(),
    },
    deviceId: () => '11111111-1111-4111-8111-111111111111',
    onExpired: (message) => expired.push(message),
    request: async (url, request) => {
      requests.push({ url, request });
      if (url.endsWith('/login') && deferLogin)
        return new Promise((resolve) => {
          finishLogin = resolve;
        });
      if (url.endsWith('/login'))
        return Response.json({ email: 'me@example.com', token: 'session', workspaces: [] });
      if (defer)
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (status === 503) throw new Error('network unavailable');
      return status === 200
        ? Response.json({ workspaces: [] })
        : Response.json({ error: '登录已失效，请重新登录。' }, { status });
    },
  };
  const access = createDesktopAccess(options);
  const login = () =>
    access.login({ email: 'me@example.com', password: 'password', remember: true });
  await login();
  assert.equal(JSON.parse(requests[0].request.body).deviceId, options.deviceId());
  const restored = createDesktopAccess(options);
  restored.load();
  await restored.check();
  assert.ok(
    requests.at(-1).url.endsWith('/workspaces'),
    'restoring a session never issues a password login',
  );
  for (status of [500, 503]) {
    await access.check();
    assert.ok(saved);
    assert.deepEqual(expired, []);
  }
  defer = true;
  const pending = access.check();
  const count = requests.length;
  await access.check();
  assert.equal(requests.length, count, 'background checks cannot overlap');
  await login();
  finish(Response.json({ error: 'old session revoked' }, { status: 401 }));
  await pending;
  assert.ok(saved);
  assert.deepEqual(expired, []);
  const earlierCheck = access.check();
  deferLogin = true;
  const newerLogin = login();
  finish(Response.json({ error: 'old session revoked' }, { status: 401 }));
  await earlierCheck;
  finishLogin(Response.json({ email: 'me@example.com', token: 'new-session', workspaces: [] }));
  await newerLogin;
  assert.ok(saved);
  assert.deepEqual(expired, [], 'an old check cannot cancel a newer login in flight');
  defer = false;
  status = 401;
  await access.check();
  assert.equal(saved, null);
  assert.deepEqual(expired, ['登录已失效，请重新登录。']);
  await access.check();
  assert.equal(expired.length, 1);
  await assert.rejects(access.ticket('node'), /先登录/);
});

test('a background check started during password login cannot cancel the new login', async () => {
  let saved;
  let delayed = false;
  let completeLogin;
  let checks = 0;
  const expired = [];
  const access = createDesktopAccess({
    read: () => saved,
    write: (value) => {
      saved = value;
    },
    storage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString(),
    },
    onExpired: (message) => expired.push(message),
    request: async (url) => {
      if (url.endsWith('/login')) {
        if (delayed)
          return new Promise((resolve) => {
            completeLogin = resolve;
          });
        return Response.json({ email: 'me@example.com', token: 'old-session', workspaces: [] });
      }
      checks++;
      return Response.json({ error: '旧登录已失效' }, { status: 401 });
    },
  });
  const input = { email: 'me@example.com', password: 'password', remember: true };
  await access.login(input);
  delayed = true;
  const pending = access.login(input);
  const result = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await access.check();
  completeLogin(Response.json({ email: input.email, token: 'new-session', workspaces: [] }));
  assert.ok('value' in (await result), 'the new login must succeed');
  assert.equal(checks, 0, 'do not check the old session while a newer login is pending');
  assert.deepEqual(expired, []);
  assert.equal(Buffer.from(saved.token, 'base64').toString(), 'new-session');
  await access.check();
  assert.equal(checks, 1, 'checks resume after login');
  assert.equal(saved, null);
});

test('overlapping login failures cannot resume checks while a newer login is pending', async () => {
  let delayed = false;
  const completions = [];
  let checks = 0;
  const access = createDesktopAccess({
    read: () => null,
    write() {},
    storage: { isEncryptionAvailable: () => false },
    request: async (url) => {
      if (url.endsWith('/login')) {
        if (delayed) return new Promise((resolve) => completions.push(resolve));
        return Response.json({ email: 'me@example.com', token: 'old-session', workspaces: [] });
      }
      checks++;
      return Response.json({ error: '登录已失效' }, { status: 401 });
    },
  });
  const input = { email: 'me@example.com', password: 'password' };
  await access.login(input);
  delayed = true;
  const first = access.login(input);
  const rejected = assert.rejects(first, /密码错误/);
  const second = access.login(input);
  completions[0](Response.json({ error: '密码错误' }, { status: 401 }));
  await rejected;
  await access.check();
  assert.equal(checks, 0);
  completions[1](Response.json({ email: input.email, token: 'new-session', workspaces: [] }));
  await second;
  await access.check();
  assert.equal(checks, 1, 'the last login completion restores checks');
  await assert.rejects(access.ticket('node'), /先登录/);
});
