import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { defaultCertificate } from '../apps/server/test/fixtures/web-certificates.ts';
import { startEgressLab } from './browser-egress-lab.mjs';

const token = 'a'.repeat(64);
function get(address, pathname, authorization) {
  return new Promise((resolve, reject) => {
    const req = request(
      address + pathname,
      {
        ca: defaultCertificate.cert,
        servername: 'default.example.test',
        headers: authorization ? { Authorization: authorization } : {},
      },
      async (response) => {
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, body });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('isolated egress lab authenticates the actual v2 proxy and exposes only lab health', async (t) => {
  const lab = await startEgressLab({ ...defaultCertificate, token, lifetimeMs: 10000 });
  t.after(() => lab.close());
  assert.equal((await get(lab.address, '/health')).status, 200);
  assert.equal(JSON.parse((await get(lab.address, '/health')).body).status, 'synthetic-egress-lab');
  assert.equal((await get(lab.address, '/cc-browser/v2/status')).status, 401);
  const status = await get(lab.address, '/cc-browser/v2/status', 'Bearer ' + token);
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), { schema: 2, enabled: true, reason: 'available' });
  assert.equal((await get(lab.address, '/data')).status, 404);
  assert.equal((await get(lab.address, '/ws')).status, 404);
  assert.equal((await get(lab.address, '/health')).body.includes(token), false);
});

test('lab expiry closes listeners and an open TLS connection', { timeout: 2000 }, async () => {
  const lab = await startEgressLab({ ...defaultCertificate, token, lifetimeMs: 200 });
  const socket = connect({
    host: '127.0.0.1',
    port: Number(new URL(lab.address).port),
    ca: defaultCertificate.cert,
    servername: 'default.example.test',
  });
  socket.on('error', () => {});
  await once(socket, 'secureConnect');
  const disconnected = once(socket, 'close');
  await lab.closed;
  await disconnected;
  await assert.rejects(get(lab.address, '/health'));
  await lab.close();
});

test('authenticated lab rejects a target outside the fixed owned host', async (t) => {
  const lab = await startEgressLab({ ...defaultCertificate, token, lifetimeMs: 10000 });
  t.after(() => lab.close());
  const ws = new WebSocket(lab.address.replace('https:', 'wss:') + '/cc-browser/v2/connect', {
    ca: defaultCertificate.cert,
    servername: 'default.example.test',
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'connect', token, host: 'not-owned.example.invalid', port: 443 }));
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
});

test('lab refuses weak credentials or unbounded lifetime', async () => {
  await assert.rejects(startEgressLab({ ...defaultCertificate, token: 'short' }), /token/);
  await assert.rejects(
    startEgressLab({ ...defaultCertificate, token, lifetimeMs: 3600000 }),
    /lifetime/,
  );
});
