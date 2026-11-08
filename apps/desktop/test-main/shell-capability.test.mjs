import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:https';
import { X509Certificate, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, tunnelCredentialsSchema } from '@cc-desk-tunnel/protocol';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';

for (const modern of [false, true])
  for (const target of [false, true]) {
    test(
      `Shell credentials are negotiated before sending (${modern ? 'new' : 'old'} service, ${target ? 'SSH target' : 'local device'})`,
      { timeout: 10000 },
      async (t) => {
        const https = createServer(defaultCertificate);
        const wss = new WebSocketServer({ server: https });
        const id = randomUUID();
        let credentials, identity;
        wss.on('connection', (socket) =>
          socket.on('message', (raw) => {
            const message = JSON.parse(String(raw));
            if (message.type === 'auth') {
              socket.send(
                JSON.stringify({
                  type: 'ready',
                  protocolVersion: PROTOCOL_VERSION,
                  version: '0.3.10',
                  connectionId: id,
                  adapter: 'claude-code',
                  sessions: [],
                  ...(modern ? { deviceShells: { version: 1 } } : {}),
                }),
              );
              socket.send(
                JSON.stringify({ type: 'tunnel.offer', connectionId: id, secret: 'A'.repeat(43) }),
              );
            } else if (message.type === 'device') identity = message;
            else if (message.type === 'tunnel.credentials') {
              credentials = message;
              socket.send(JSON.stringify({ type: 'tunnel.ready', connectionId: id }));
            }
          }),
        );
        await new Promise((resolve) => https.listen(0, '127.0.0.1', resolve));
        let closed = false;
        const bridge = await openProxyBridge(
          {
            url: `wss://127.0.0.1:${https.address().port}/ws`,
            fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
          },
          {
            ...(target ? { device: { id: randomUUID(), platform: 'linux', viaSsh: true } } : {}),
            startSsh: async () => ({
              port: 9,
              credentials: {
                type: 'tunnel.credentials',
                connectionId: id,
                username: 'fixture',
                privateKey: 'test-only-placeholder',
                hostPublicKey: 'ssh-ed25519 AAAATEST',
                shells: target ? ['bash'] : ['pwsh', 'bash'],
              },
              close: async () => {
                closed = true;
              },
            }),
          },
        );
        const local = new WebSocket(bridge.url);
        t.after(async () => {
          local.terminate();
          await bridge.close();
          for (const socket of wss.clients) socket.terminate();
          await new Promise((resolve) => wss.close(resolve));
          await new Promise((resolve) => https.close(resolve));
          assert.equal(closed, true);
        });
        await once(local, 'open');
        const ready = once(local, 'message');
        local.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: PROTOCOL_VERSION,
            token: 'fixture-token',
            deviceName: 'fixture',
          }),
        );
        local.send(
          JSON.stringify({
            type: 'device',
            id: randomUUID(),
            platform: 'darwin',
            shells: ['zsh'],
            shell: 'zsh',
            viaSsh: true,
          }),
        );
        await ready;
        if (modern) assert.deepEqual(credentials.shells, target ? ['bash'] : ['pwsh', 'bash']);
        else {
          assert.equal(Object.hasOwn(credentials, 'shells'), false);
          assert.equal(
            tunnelCredentialsSchema.omit({ shells: true }).safeParse(credentials).success,
            true,
          );
        }
        assert.equal(Object.hasOwn(identity, 'shells'), false);
        assert.equal(Object.hasOwn(identity, 'shell'), false);
        assert.equal(
          identity.platform,
          target ? 'linux' : process.platform === 'win32' ? undefined : process.platform,
        );
        assert.equal(identity.viaSsh, target ? true : undefined);
      },
    );
  }
