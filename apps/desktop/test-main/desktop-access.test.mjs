import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { createDesktopAccess } = createRequire(import.meta.url)('../electron/desktop-access.cjs');
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
