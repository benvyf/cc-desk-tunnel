import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ServerMessage } from '@cc-desk-tunnel/protocol';

// Keep the real server and NativeTerminal; replace only OS/CLI boundaries in this test process.
const state = {
  writes: [] as string[],
  sizes: [] as number[][],
  checks: 0,
  failPolicy: false,
  kills: 0,
};
const key = Symbol.for('cc-terminal-control-test');
Reflect.set(globalThis, key, state);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'node-pty') return { url: 'test:terminal-pty', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    let source: string | undefined;
    const shared = `const state = globalThis[Symbol.for('cc-terminal-control-test')];`;
    if (url === 'test:terminal-pty')
      source =
        shared +
        `
      export function spawn() {
        let exit;
        return {
          pid: 2147483647,
          onData() { return { dispose() {} }; },
          onExit(fn) { exit = fn; return { dispose() {} }; },
          write(data) { state.writes.push(data); },
          resize(cols, rows) { state.sizes.push([cols, rows]); },
          pause() {}, resume() {},
          kill() { state.kills++; queueMicrotask(() => exit({exitCode: 0})); }
        };
      }`;
    if (url.endsWith('/native-terminal-policy.ts'))
      source =
        shared +
        `
      export function assertNativeTerminalReview(file) {
        state.checks++;
        if (state.failPolicy) throw new Error('fixture: invalid review policy');
        return file;
      }`;
    if (url.endsWith('/native-onboarding.ts')) source = 'export function completeOnboarding() {}';
    return source === undefined
      ? next(url, context)
      : { format: 'module', source, shortCircuit: true };
  },
});
const { createProxyServer } = await import('../src/server.ts');

test('reviewed terminal accepts keys, rejects foreign controls, and closes on disconnect', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-terminal-control-'));
  const token = randomUUID();
  const server = createProxyServer({
    token,
    dataDir: directory,
    nativeTerminalReview: true,
    reverseProxy: true,
    tunnel: {},
    claude: { executable: 'fixture-never-launch-claude' },
    moderation: {
      endpoint: 'https://review.invalid/check',
      nodeId: 'fixture',
      token,
      fetcher: async () => {
        throw new Error('Keystrokes must not call the chat reviewer');
      },
    },
  });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await server.close();
    hooks.deregister();
    Reflect.deleteProperty(globalThis, key);
    rmSync(directory, { recursive: true, force: true });
  });
  const url = await server.listen(0);
  async function connect() {
    const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    async function wait(predicate: (message: ServerMessage) => boolean) {
      for (let i = 0; i < 400; i++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await delay(5);
      }
      throw new Error('Timed out waiting for terminal fixture message');
    }
    const send = (value: object) => socket.send(JSON.stringify(value));
    await new Promise<void>((resolve) => socket.once('open', resolve));
    send({ type: 'auth', token, protocolVersion: PROTOCOL_VERSION, deviceName: 'fixture' });
    send({ type: 'device', id: randomUUID() });
    await wait((message) => message.type === 'ready');
    async function request(command: object) {
      const requestId = randomUUID();
      send({ ...command, requestId });
      const message = await wait(
        (message) => message.type === 'response' && message.requestId === requestId,
      );
      assert.equal(message.type, 'response');
      return message;
    }
    return { socket, send, wait, request };
  }
  const owner = await connect();
  const other = await connect();
  const created = await owner.request({ type: 'server.session.create', title: 'fixture' });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const open = () => owner.request({ type: 'terminal.open', sessionId, cols: 80, rows: 24 });
  state.failPolicy = true;
  assert.equal((await open()).code, 'terminal_failed');
  state.failPolicy = false;
  assert.equal((await open()).ok, true);
  assert.equal(state.checks, 2);
  const opened = await owner.wait((message) => message.type === 'terminal.opened');
  assert.equal(opened.type, 'terminal.opened');
  const terminalId = opened.terminalId;
  for (const data of ['\x1b[B', '\r', '中文🙂', '\x03'])
    owner.send({ type: 'terminal.input', sessionId, terminalId, data });
  // A response on the same socket is a processing barrier for earlier control frames.
  assert.equal((await open()).code, 'native_busy');
  assert.deepEqual(state.writes, ['\x1b[B', '\r', '中文🙂', '\x03']);
  other.send({ type: 'terminal.input', sessionId, terminalId, data: 'foreign' });
  await other.wait(
    (message) => message.type === 'connection.error' && message.code === 'terminal_inactive',
  );
  owner.send({ type: 'terminal.input', sessionId, terminalId: randomUUID(), data: 'stale' });
  await owner.wait(
    (message) => message.type === 'connection.error' && message.code === 'terminal_inactive',
  );
  assert.equal(state.writes.length, 4);
  owner.send({ type: 'terminal.resize', sessionId, terminalId, cols: 100, rows: 35 });
  assert.equal((await owner.request({ type: 'terminal.close', sessionId, terminalId })).ok, true);
  assert.deepEqual(state.sizes, [[100, 35]]);
  assert.equal(state.kills, 1);
  assert.equal((await open()).ok, true);
  owner.socket.terminate();
  for (let i = 0; i < 400 && state.kills < 2; i++) await delay(5);
  assert.equal(state.kills, 2);
});
