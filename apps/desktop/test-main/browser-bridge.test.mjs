import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { openBrowserBridge, browserAddress } from '../electron/browser-bridge.mjs';

test('browser service URL is fixed to the configured service, rejecting plaintext or injected targets', () => {
  assert.equal(
    browserAddress('wss://127.0.0.1:8443/ws').href,
    'wss://127.0.0.1:8443/cc-browser/v1/display',
  );
  for (const value of [
    'ws://127.0.0.1/ws',
    'wss://x/ws?url=https://claude.ai',
    'https://claude.ai/',
  ])
    assert.throws(() => browserAddress(value));
});
async function fixture(t, wrongPin = false, { silent = false, heartbeatMs } = {}) {
  const server = createServer(defaultCertificate);
  const wss = new WebSocketServer({ server, autoPong: !silent });
  const received = [];
  wss.on('connection', (ws, req) => {
    assert.equal(req.url, '/cc-browser/v1/display');
    ws.once('message', (data) => {
      received.push(JSON.parse(data));
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.on('message', (bytes) => ws.send(bytes));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bridge = await openBrowserBridge(
    {
      url: `wss://127.0.0.1:${server.address().port}/ws`,
      fingerprint: wrongPin
        ? '11'.repeat(32)
        : new X509Certificate(defaultCertificate.cert).fingerprint256,
      token: 'offline-browser-token',
    },
    { heartbeatMs },
  );
  t.after(async () => {
    await bridge.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  return { bridge, received };
}
test('wrong certificate never receives credentials', async (t) => {
  const f = await fixture(t, true);
  const ws = new WebSocket(f.bridge.url, { origin: 'file://' });
  await once(ws, 'open');
  await once(ws, 'close');
  assert.deepEqual(f.received, []);
});
test('untrusted local origin is refused before any remote connection', async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(f.bridge.url, { origin: 'https://claude.ai' });
  await assert.rejects(once(ws, 'open'), /403/);
  assert.deepEqual(f.received, []);
});

test('missing Origin and a guessed local path cannot open a remote connection', async (t) => {
  const f = await fixture(t);
  for (const [url, options] of [
    [f.bridge.url, {}],
    [f.bridge.url + '-wrong', { origin: 'file://' }],
  ]) {
    const ws = new WebSocket(url, options);
    await assert.rejects(once(ws, 'open'), /403/);
  }
  assert.deepEqual(f.received, []);
});

test('browser service redirects are refused instead of following a target URL locally', async (t) => {
  let redirectedRequests = 0;
  const server = createServer(defaultCertificate);
  server.on('upgrade', (request, socket) => {
    if (request.url === '/unintended-target') redirectedRequests++;
    socket.end(
      `HTTP/1.1 302 Found\r\nLocation: wss://127.0.0.1:${server.address().port}/unintended-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bridge = await openBrowserBridge({
    url: `wss://127.0.0.1:${server.address().port}/ws`,
    fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
    token: 'offline-browser-token',
  });
  t.after(async () => {
    await bridge.close();
    await new Promise((r) => server.close(r));
  });
  const ws = new WebSocket(bridge.url, { origin: 'file://' });
  await once(ws, 'open');
  await once(ws, 'close');
  assert.equal(redirectedRequests, 0);
});
test('authentication frames stay out of the RFB stream and binary bytes round-trip', async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(f.bridge.url, { origin: 'file://' });
  await once(ws, 'open');
  // RFB clients can write immediately; the bridge buffers via a bounded stream until authentication completes.
  const response = once(ws, 'message');
  ws.send(Buffer.from([0, 1, 255, 23]));
  assert.deepEqual((await response)[0], Buffer.from([0, 1, 255, 23]));
  assert.equal(f.received[0].type, 'authenticate');
});

test('a silent browser channel closes even if the separate control channel is healthy', async (t) => {
  const f = await fixture(t, false, { silent: true, heartbeatMs: 20 });
  const ws = new WebSocket(f.bridge.url, { origin: 'file://' });
  await once(ws, 'open');
  const response = once(ws, 'message');
  ws.send(Buffer.from([7]));
  await response;
  const closed = await once(ws, 'close');
  assert.equal(closed[0], 1011);
});
