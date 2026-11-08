import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';

test('Shell preference commands affect only the authenticated device and reject unavailable targets', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-device-shell-'));
  const token = 'shell-scope-' + randomUUID();
  const server = createProxyServer({ token, dataDir: directory });
  const url = (await server.listen(0)).replace('http:', 'ws:') + '/ws';
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function connect(linux = false) {
    const id = randomUUID(),
      socket = new WebSocket(url),
      messages: any[] = [];
    sockets.push(socket);
    socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    const send = (value: object) => socket.send(JSON.stringify(value));
    async function wait(predicate: (message: any) => boolean) {
      for (let i = 0; i < 200; i++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(10);
      }
      throw new Error('Shell preference response timed out');
    }
    async function request(shell: string | null) {
      const requestId = randomUUID();
      send({ type: 'device.shell', requestId, shell });
      return wait((message) => message.type === 'response' && message.requestId === requestId);
    }
    await once(socket, 'open');
    send({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName: 'fixture' });
    send({ type: 'device', id, ...(linux ? { platform: 'linux', viaSsh: true } : {}) });
    const ready = await wait((message) => message.type === 'ready');
    assert.equal(ready.deviceShells?.version, 1);
    return { id, send, wait, request };
  }
  const first = await connect(),
    second = await connect(),
    linux = await connect(true);
  assert.equal((await first.request('pwsh')).ok, true);
  assert.equal(server.store.preferredShell(first.id), 'pwsh');
  assert.equal(server.store.preferredShell(second.id), undefined);
  first.send({ type: 'device.shell', requestId: randomUUID(), shell: 'pwsh', deviceId: second.id });
  await first.wait(
    (message) => message.type === 'connection.error' && message.code === 'invalid_command',
  );
  assert.equal(server.store.preferredShell(second.id), undefined);
  assert.equal((await first.request('bash')).code, 'shell_unavailable');
  assert.equal((await linux.request('pwsh')).code, 'shell_unavailable');
  assert.equal((await second.request('pwsh')).ok, true);
  assert.equal((await first.request(null)).ok, true);
  assert.equal(server.store.preferredShell(first.id), undefined);
  assert.equal(server.store.preferredShell(second.id), 'pwsh');
});
