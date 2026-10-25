import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once, on } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startBrowserLab } from './claude-web-lab.ts';
import { offlineFramebuffer } from '../apps/desktop/test/fixtures/offline-rfb.ts';
import { defaultCertificate } from '../apps/server/test/fixtures/web-certificates.ts';

test(
  'isolated lab runs the full CC service and carries synthetic pixels and input over TLS',
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-browser-lab-'));
    const frame = await offlineFramebuffer({ host: '127.0.0.1', port: 0 });
    const token = 'offline-browser-lab-test-credential';
    let service: Awaited<ReturnType<typeof startBrowserLab>> | undefined;
    let ws: WebSocket | undefined;
    try {
      service = await startBrowserLab({
        directory,
        token,
        endpoint: frame.endpoint,
        host: '127.0.0.1',
        port: 0,
        cert: Buffer.from(defaultCertificate.cert),
        key: Buffer.from(defaultCertificate.key),
      });
      const status = await new Promise<string>((resolve, reject) => {
        import('node:https').then(({ get }) => {
          get(
            service!.address + '/cc-browser/v1/status',
            {
              rejectUnauthorized: false,
              headers: { authorization: `Bearer ${token}` },
            },
            (res) => {
              let body = '';
              res.on('data', (chunk) => (body += chunk));
              res.on('end', () => resolve(body));
            },
          ).on('error', reject);
        }, reject);
      });
      assert.equal(JSON.parse(status).reason, 'available');
      assert.equal(frame.connections(), 0);
      ws = new WebSocket(service.address.replace('https:', 'wss:') + '/cc-browser/v1/display', {
        rejectUnauthorized: false,
      });
      const messages = on(ws, 'message');
      const next = async () => Buffer.from((await messages.next()).value![0]);
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'authenticate', token }));
      assert.equal(JSON.parse((await next()).toString()).type, 'ready');
      assert.equal((await next()).toString(), 'RFB 003.008\n');
      ws.send(Buffer.from('RFB 003.008\n'));
      assert.deepEqual(await next(), Buffer.from([1, 1]));
      ws.send(Buffer.from([1]));
      assert.deepEqual(await next(), Buffer.alloc(4));
      ws.send(Buffer.from([1]));
      assert.equal((await next()).readUInt16BE(0), 320);
      const request = Buffer.alloc(10);
      request[0] = 3;
      request.writeUInt16BE(320, 6);
      request.writeUInt16BE(180, 8);
      ws.send(request);
      const pixels = await next();
      assert.equal(pixels.length, 16 + 320 * 180 * 4);
      assert.deepEqual([...pixels.subarray(16, 20)], [0xaa, 0x77, 0x33, 0]);
      ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 97, 5, 1, 0, 10, 0, 10]));
      for (let i = 0; i < 50 && !frame.keys.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(frame.keys, [{ down: true, symbol: 97 }]);
      assert.deepEqual(frame.pointers, [1]);
      await messages.return!();
    } finally {
      ws?.terminate();
      await service?.close();
      await frame.close();
      rmSync(directory, { force: true, recursive: true });
    }
  },
);
