import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
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
  args: [] as string[][],
  onboardingReads: 0,
  statusReads: [] as { sessionId: string; resume: boolean }[],
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
    if (url.endsWith('/claude.ts')) {
      const loaded = next(url, context);
      const original = String(loaded.source).replace(
        'export async function readNativeStatus(',
        'async function unusedReadNativeStatus(',
      );
      return {
        ...loaded,
        source:
          original +
          `
          export async function readNativeStatus(options, dataDir, root, sessionId, signal, status) {
            const state = globalThis[Symbol.for('cc-terminal-control-test')];
            state.statusReads.push({ sessionId, resume: status.resume });
            return [{type:'native.metrics',context:null,usage:null,rateLimits:null}];
          }`,
      };
    }
    if (url === 'test:terminal-pty')
      source =
        shared +
        `
      export function spawn(file, args) {
        state.args.push(args);
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
    if (url.endsWith('/native-onboarding.ts'))
      source =
        shared +
        'export function completeOnboarding() { state.onboardingReads++; throw new Error("Terminal must not access onboarding credentials"); }';
    return source === undefined
      ? next(url, context)
      : { format: 'module', source, shortCircuit: true };
  },
});
const { createProxyServer } = await import('../src/server.ts');

test('reviewed terminal synchronizes turns and quota, rejects foreign controls, and resumes after disconnect', async (t) => {
  const diagnostics = t.mock.method(console, 'error', () => {});
  const directory = mkdtempSync(join(tmpdir(), 'cc-terminal-control-'));
  const token = randomUUID();
  const server = createProxyServer({
    token,
    dataDir: directory,
    nativeTerminalReview: true,
    reverseProxy: true,
    tunnel: {},
    claude: {
      executable: 'fixture-never-launch-claude',
      environment: { CLAUDE_CONFIG_DIR: join(directory, 'cli') },
    },
    maxRuns: 2,
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
    const ready = await wait((message) => message.type === 'ready');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.terminalWorkspace?.version, 1);
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
  const failure = diagnostics.mock.calls.find(
    (call) => call.arguments[0] === 'Native terminal startup failed',
  );
  assert.ok(failure);
  assert.equal(failure.arguments[1].sessionId, sessionId);
  assert.equal(typeof failure.arguments[1].requestId, 'string');
  assert.equal(typeof failure.arguments[1].terminalId, 'string');
  assert.match(failure.arguments[2], /fixture: invalid review policy/);
  state.failPolicy = false;
  assert.equal((await open()).ok, true);
  assert.equal(state.checks, 2);
  const opened = await owner.wait((message) => message.type === 'terminal.opened');
  assert.equal(opened.type, 'terminal.opened');
  const terminalId = opened.terminalId;
  const separate = await other.request({ type: 'server.session.create', title: 'status only' });
  assert.equal(separate.ok, true);
  assert.equal(
    (await other.request({ type: 'session.status', sessionId: separate.sessionId })).ok,
    true,
  );
  assert.deepEqual(state.statusReads.at(-1), { sessionId: separate.sessionId, resume: true });
  assert.equal((await other.request({ type: 'session.status', sessionId })).ok, true);
  assert.deepEqual(state.statusReads.at(-1), { sessionId, resume: false });
  assert.equal(state.kills, 0, 'status reads must leave the existing terminal running');
  assert.equal(state.args.length, 1, 'status reads must not open another terminal');
  assert.ok(
    state.args.at(-1)?.includes(sessionId),
    'new terminals share the chat native session ID',
  );
  const settings = state.args.at(-1)!;
  const settingsPath = settings[settings.indexOf('--settings') + 1];
  const runtimeSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(runtimeSettings.hooks.UserPromptSubmit.length);
  const hooksPath = settingsPath.replace(/\.json$/, '.hooks');
  const statusPath = settingsPath.replace(/\.json$/, '.status');
  const binding = server.store.terminalHistory(sessionId)!;
  const nativeFile = join(
    directory,
    'cli',
    'projects',
    resolve(directory, 'native', binding.root).replace(/[^a-zA-Z0-9]/g, '-'),
    `${binding.nativeId}.jsonl`,
  );
  const questionId = randomUUID();
  const terminalMessages = [
    {
      type: 'user',
      uuid: questionId,
      parentUuid: null,
      sessionId,
      message: { content: 'terminal fixture prompt' },
      timestamp: new Date().toISOString(),
    },
    {
      type: 'assistant',
      uuid: randomUUID(),
      parentUuid: questionId,
      sessionId,
      message: { id: 'answer', content: [{ type: 'text', text: 'terminal fixture answer' }] },
      timestamp: new Date().toISOString(),
    },
  ];
  mkdirSync(dirname(nativeFile), { recursive: true });
  writeFileSync(
    nativeFile,
    terminalMessages.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  writeFileSync(
    hooksPath,
    JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }) + '\n',
  );
  await owner.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'message.user' &&
      message.event.payload.text === 'terminal fixture prompt',
  );
  await owner.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'text.delta' &&
      message.event.payload.text === 'terminal fixture answer',
  );
  await owner.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.activity === 'idle',
  );
  writeFileSync(
    statusPath,
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 17, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    }),
  );
  await other.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'native.metrics' &&
      message.event.payload.rateLimits?.windows[0]?.utilization === 17,
  );
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
  // Creating a tab preserves the existing subscription and saves strict settings before spawn.
  const createId = randomUUID();
  const createTab = {
    type: 'terminal.session.create',
    requestId: createId,
    sourceSessionId: sessionId,
    title: 'second terminal',
    permissionMode: 'default',
    model: null,
    effort: null,
  };
  owner.send(createTab);
  const second = await owner.wait(
    (message) => message.type === 'response' && message.requestId === createId,
  );
  assert.equal(second.type, 'response');
  assert.equal(second.ok, true);
  const secondId = second.sessionId!;
  owner.send(createTab);
  const repeated = await owner.wait(
    (message) => message.type === 'response' && message.requestId === createId,
  );
  assert.equal(repeated.type, 'response');
  assert.equal(repeated.sessionId, secondId);
  owner.send({ ...createTab, title: 'conflict' });
  const conflict = await owner.wait(
    (message) => message.type === 'response' && message.requestId === createId,
  );
  assert.equal(conflict.type, 'response');
  assert.equal(conflict.code, 'request_conflict');
  assert.equal(
    (await owner.request({ type: 'terminal.open', sessionId: secondId, cols: 80, rows: 24 })).ok,
    true,
  );
  assert.equal(state.args.at(-1)?.[1], 'manual');
  const secondOpened = await owner.wait(
    (message) => message.type === 'terminal.opened' && message.sessionId === secondId,
  );
  assert.equal(secondOpened.type, 'terminal.opened');
  const stateId = randomUUID();
  owner.send({ type: 'terminal.state', sessionId: secondId, requestId: stateId });
  const running = await owner.wait(
    (message) => message.type === 'terminal.state' && message.requestId === stateId,
  );
  assert.equal(running.type, 'terminal.state');
  assert.equal(running.state, 'running');
  assert.equal(running.terminalId, secondOpened.terminalId);
  const foreignStateId = randomUUID();
  other.send({ type: 'terminal.state', sessionId: secondId, requestId: foreignStateId });
  const foreignState = await other.wait(
    (message) => message.type === 'terminal.state' && message.requestId === foreignStateId,
  );
  assert.equal(foreignState.type, 'terminal.state');
  assert.equal(foreignState.state, 'unavailable');
  assert.equal(foreignState.terminalId, undefined);
  const third = await owner.request({ ...createTab, sourceSessionId: secondId });
  assert.equal(third.ok, true);
  assert.equal(
    (
      await owner.request({
        type: 'terminal.open',
        sessionId: third.sessionId!,
        cols: 80,
        rows: 24,
      })
    ).code,
    'capacity',
  );
  assert.equal(
    (
      await owner.request({
        type: 'terminal.close',
        sessionId: secondId,
        terminalId: secondOpened.terminalId,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await owner.request({
        type: 'terminal.open',
        sessionId: third.sessionId!,
        cols: 80,
        rows: 24,
      })
    ).ok,
    true,
  );
  const thirdOpened = await owner.wait(
    (message) => message.type === 'terminal.opened' && message.sessionId === third.sessionId,
  );
  assert.equal(thirdOpened.type, 'terminal.opened');
  const historyBinding = server.store.terminalHistory(third.sessionId!)!;
  const historyFile = join(
    directory,
    'cli',
    'projects',
    resolve(directory, 'native', historyBinding.root).replace(/[^a-zA-Z0-9]/g, '-'),
    `${historyBinding.nativeId}.jsonl`,
  );
  mkdirSync(dirname(historyFile), { recursive: true });
  writeFileSync(historyFile, 'history that failed to import must be preserved');
  owner.send({
    type: 'terminal.ack',
    sessionId: third.sessionId!,
    terminalId: thirdOpened.terminalId,
    bytes: 1,
  });
  const controlError = await owner.wait(
    (message) => message.type === 'connection.error' && message.code === 'terminal_control_failed',
  );
  assert.equal(controlError.type, 'connection.error');
  assert.equal(controlError.terminalId, thirdOpened.terminalId);
  const controlExit = await owner.wait(
    (message) =>
      message.type === 'terminal.closed' && message.terminalId === thirdOpened.terminalId,
  );
  assert.equal(controlExit.type, 'terminal.closed');
  assert.equal(controlExit.reason, 'control_error');
  assert.equal(
    existsSync(historyFile),
    true,
    'a failed import cannot be treated as an empty native transcript',
  );
  assert.equal(state.onboardingReads, 0);
  owner.socket.terminate();
  await new Promise<void>((resolve) => owner.socket.once('close', resolve));
  await delay(25);
  assert.equal(state.kills, 3, 'network loss keeps the terminal process alive');
  assert.equal(
    (await other.request({ type: 'terminal.open', sessionId, cols: 90, rows: 28 })).ok,
    true,
  );
  const resumed = await other.wait(
    (message) => message.type === 'terminal.opened' && message.sessionId === sessionId,
  );
  assert.equal(resumed.type, 'terminal.opened');
  assert.equal(state.args.length, 4, 'reattaching does not spawn another CLI');
  other.send({
    type: 'terminal.input',
    sessionId,
    terminalId: resumed.terminalId,
    data: 'after reconnect',
  });
  assert.equal(
    (await other.request({ type: 'terminal.close', sessionId, terminalId: resumed.terminalId })).ok,
    true,
  );
  assert.equal(state.writes.at(-1), 'after reconnect');
  assert.equal(state.kills, 4);
  const spawnCount = state.args.length;
  assert.equal(
    (
      await other.request({
        type: 'terminal.open',
        sessionId,
        terminalId: resumed.terminalId,
        cols: 90,
        rows: 28,
      })
    ).code,
    'terminal_inactive',
  );
  assert.equal(
    state.args.length,
    spawnCount,
    'expired process recovery cannot silently start a new CLI',
  );
});
