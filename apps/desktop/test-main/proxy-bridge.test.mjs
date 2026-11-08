import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  certificateMatches,
  connectionWaits,
  controlTlsOptions,
  openProxyBridge,
} from '../electron/proxy-bridge.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';

test('transient bridge closure preserves offline grace while explicit closure sends leave', async (t) => {
  for (const intentional of [false, true]) {
    await t.test(intentional ? 'explicit disconnect' : 'transient disconnect', async () => {
      const server = createServer({ key: defaultCertificate.key, cert: defaultCertificate.cert });
      const wss = new WebSocketServer({ server });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const messages = [];
      let peer;
      const authenticated = new Promise((resolve) =>
        wss.once('connection', (socket) => {
          peer = socket;
          socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            messages.push(message.type);
            if (message.type === 'auth') resolve();
          });
        }),
      );
      const bridge = await openProxyBridge(
        {
          url: `wss://127.0.0.1:${server.address().port}/ws`,
          fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
        },
        {},
      );
      const client = new WebSocket(bridge.url);
      client.on('error', () => {});
      try {
        await once(client, 'open');
        client.send(JSON.stringify({ type: 'auth', token: 'test-only-token-for-bridge' }));
        await authenticated;
        const closed = once(peer, 'close');
        await bridge.close(false, intentional);
        await closed;
        assert.equal(messages.includes('leave'), intentional);
      } finally {
        client.terminate();
        await bridge.close();
        for (const socket of wss.clients) socket.terminate();
        await new Promise((resolve) => wss.close(resolve));
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
});

test('WSS pin comparison rejects empty, malformed and mismatched fingerprints', () => {
  const pin = Array(32).fill('AB').join(':');
  assert.equal(certificateMatches(pin, pin.toLowerCase().replaceAll(':', '')), true);
  assert.equal(certificateMatches(pin, 'invalid'), false);
  assert.equal(certificateMatches(undefined, pin), false);
  assert.equal(certificateMatches('CD'.repeat(32), pin), false);
  assert.equal(certificateMatches(':'.repeat(64), ':'.repeat(64)), false);
});
test('native desktop refuses plaintext control connections', async () => {
  await assert.rejects(
    openProxyBridge({ url: 'ws://example.com/ws', fingerprint: 'AB'.repeat(32) }, {}),
    /WSS/,
  );
});
test('empty certificate pin enables strict CA verification; malformed pins never disable verification', () => {
  assert.deepEqual(controlTlsOptions({ fingerprint: '' }), { rejectUnauthorized: true });
  assert.deepEqual(controlTlsOptions({}), { rejectUnauthorized: true });
  assert.deepEqual(controlTlsOptions({ fingerprint: 'AB'.repeat(32) }), {
    rejectUnauthorized: false,
  });
  assert.throws(() => controlTlsOptions({ fingerprint: 'invalid' }), /SHA256/);
});
test('local browser test bridge only accepts its explicitly configured origin', async () => {
  const bridge = await openProxyBridge(
    { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
    {},
    () => {},
    ['http://127.0.0.1:15873'],
  );
  try {
    const socket = new WebSocket(bridge.url, { origin: 'http://untrusted.example' });
    await assert.rejects(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
      /403/,
    );
  } finally {
    await bridge.close();
  }
});

test('connection waits take the defaults unless given sensible seconds, and the whole outlasts SSH', () => {
  assert.deepEqual(connectionWaits(undefined), { connect: 15000, ssh: 10000, ready: 45000 });
  assert.deepEqual(connectionWaits({ connect: 4, ssh: '30', ready: 601 }), {
    connect: 15000,
    ssh: 10000,
    ready: 45000,
  });
  assert.deepEqual(connectionWaits({ connect: 30, ssh: 40, ready: 50 }), {
    connect: 30000,
    ssh: 40000,
    ready: 75000,
  });
});
