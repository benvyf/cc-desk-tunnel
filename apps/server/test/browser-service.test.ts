import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { BrowserOptions } from '../src/browser-service.ts';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createBrowserService, browserEndpoint } from '../src/browser-service.ts';
import { Throttle } from '../src/throttle.ts';

const token = 'offline-browser-test-service-token';
async function fixture(t: TestContext, options: Partial<BrowserOptions> = {}) {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(upstream, 'listening');
  let connections = 0;
  upstream.on('connection', (ws) => {
    connections++;
    ws.on('message', (data) => ws.send(data));
  });
  const browser = createBrowserService({
    token,
    endpoint: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}/`,
    ...options,
  });
  const server = createServer((req, res) => {
    if (!browser.handle(req, res)) res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => browser.upgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    browser.close();
    for (const ws of upstream.clients) ws.terminate();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
  });
  const dial = async (credential = token) => {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/cc-browser/v1/display');
    await once(ws, 'open');
    const response = once(ws, credential === token ? 'message' : 'close');
    ws.send(JSON.stringify({ type: 'authenticate', token: credential }));
    await response;
    return ws;
  };
  return { browser, origin, dial, connections: () => connections };
}

test('browser upstream accepts only an administrator private endpoint, never target-site URLs', () => {
  for (const endpoint of [
    'https://claude.ai/',
    'ws://claude.ai/',
    'ws://127.0.0.1:6080/?url=x',
    'ws://user:pass@localhost/',
  ])
    assert.throws(() => browserEndpoint(endpoint));
  assert.equal(browserEndpoint('ws://cc-claude-web-trial:6080/'), 'ws://cc-claude-web-trial:6080/');
});

test('status requires authentication, rejects web origins, and never contacts the browser', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/cc-browser/v1/status')).status, 401);
  assert.equal(
    (
      await fetch(f.origin + '/cc-browser/v1/status', {
        headers: { authorization: `Bearer ${token}`, origin: 'null' },
      })
    ).status,
    403,
  );
  const response = await fetch(f.origin + '/cc-browser/v1/status', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await response.json()).reason, 'available');
  assert.equal(f.connections(), 0);
});

test('disabled and moderation-constrained nodes do not dial a browser', async (t) => {
  for (const options of [{ endpoint: undefined }, { blocked: () => 'moderation-required' }]) {
    const f = await fixture(t, options);
    const response = await fetch(f.origin + '/cc-browser/v1/status', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal((await response.json()).enabled, false);
    assert.equal(f.connections(), 0);
  }
});

test('wrong credentials never open an upstream; authenticated binary data over 256KiB is preserved', async (t) => {
  const f = await fixture(t);
  await f.dial('wrong');
  assert.equal(f.connections(), 0);
  const ws = await f.dial();
  const payload = Buffer.alloc(512 * 1024, 0xa7);
  const response = once(ws, 'message');
  ws.send(payload);
  assert.deepEqual((await response)[0], payload);
  assert.equal(f.browser.busy(), true);
});

test('only one authenticated controller can connect', async (t) => {
  const f = await fixture(t);
  await f.dial();
  const ws = new WebSocket(f.origin.replace('http', 'ws') + '/cc-browser/v1/display');
  await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'authenticate', token }));
  assert.equal((await closed)[0], 1013);
  assert.equal(f.connections(), 1);
});

test('malformed and non-object first frames are refused without crashing the service', async (t) => {
  for (const frame of ['null', 'true', '123', '"token"', '[]', '{broken']) {
    const f = await fixture(t);
    const ws = new WebSocket(f.origin.replace('http', 'ws') + '/cc-browser/v1/display');
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(frame);
    assert.equal((await closed)[0], 1008);
    assert.equal(f.connections(), 0);
    await f.dial();
  }
});

test('browser HTTP and display share token throttling and release pending-auth places', async (t) => {
  const throttle = new Throttle();
  const f = await fixture(t, { throttle, address: () => 'offline-client' });
  for (let i = 0; i < 6; i++) await f.dial('wrong');
  assert.ok(throttle.blocked('offline-client') > 0);
  assert.equal(
    (
      await fetch(f.origin + '/cc-browser/v1/status', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    429,
  );
  const ws = new WebSocket(f.origin.replace('http', 'ws') + '/cc-browser/v1/display');
  await assert.rejects(once(ws, 'open'), /429/);
  assert.equal(f.connections(), 0);
  throttle.succeed('offline-client');
  await f.dial();
  assert.equal(f.connections(), 1);
});
