import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { terminalHistoryPath, terminalHistoryContext } from '../src/terminal-history.ts';

test('official IDs persist and explicit continuation checks files, scope, locks and request identity without provider calls', async () => {
  const args: string[][] = [];
  const key = Symbol.for('cc-history-fixture');
  Reflect.set(globalThis, key, args);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'node-pty') return { url: 'test:history-pty', shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === 'test:history-pty')
        return {
          format: 'module',
          shortCircuit: true,
          source: `
        export function spawn(_file, args) {
          const calls = globalThis[Symbol.for('cc-history-fixture')]; calls.push(args); let exit;
          if (calls.failOnce) { calls.failOnce = false; throw new Error('Fixture spawn failed'); }
          return {pid:2147483647,onData(){return {dispose(){}}},onExit(fn){exit=fn;return {dispose(){}}},
            write(){throw new Error('No input replay allowed')},resize(){},pause(){},resume(){},
            kill(){queueMicrotask(()=>exit({exitCode:0}))}};
        }`,
        };
      if (url.endsWith('/native-onboarding.ts'))
        return {
          format: 'module',
          shortCircuit: true,
          source: `export function completeOnboarding(){throw new Error('No credential reads allowed')}`,
        };
      return next(url, context);
    },
  });
  const { createProxyServer } = await import('../src/server.ts');
  const directory = mkdtempSync(join(tmpdir(), 'cc-history-'));
  const config = join(directory, 'cli-config');
  assert.equal(
    terminalHistoryContext({ executable: 'fixture' }, { CLAUDE_CONFIG_DIR: 'profile' }, directory)
      .config,
    join(directory, 'profile'),
  );
  const options = {
    token: randomUUID(),
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    maxRuns: 4,
    claude: { executable: 'never-launch-provider', environment: { CLAUDE_CONFIG_DIR: config } },
  };
  let server = createProxyServer(options);
  let socket: WebSocket | undefined;
  async function connect() {
    const url = await server.listen(0);
    socket = new WebSocket(url.replace('http', 'ws') + '/ws');
    const messages: any[] = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => socket!.once('open', resolve));
    const send = (value: object) => socket!.send(JSON.stringify(value));
    async function wait(predicate: (value: any) => boolean) {
      for (let i = 0; i < 500; i++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(5);
      }
      throw new Error('History fixture response timeout');
    }
    send({
      type: 'auth',
      token: options.token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: 'fixture',
    });
    send({ type: 'device', id: randomUUID() });
    const ready = await wait((value) => value.type === 'ready');
    assert.equal(ready.terminalHistory.version, 1);
    async function request(command: object, requestId = randomUUID()) {
      send({ ...command, requestId });
      return wait((value) => value.type === 'response' && value.requestId === requestId);
    }
    async function histories(sessionId: string) {
      const requestId = randomUUID();
      const response = await request({ type: 'terminal.history.list', sessionId }, requestId);
      assert.equal(response.ok, true);
      return (
        await wait((value) => value.type === 'terminal.histories' && value.requestId === requestId)
      ).items;
    }
    return { request, histories, wait };
  }
  try {
    let client = await connect();
    const original = (await client.request({ type: 'server.session.create', title: 'original' }))
      .sessionId;
    assert.deepEqual(await client.histories(original), []); // Old/unassociated session: no scan/guess.
    Reflect.set(args, 'failOnce', true);
    assert.equal(
      (await client.request({ type: 'terminal.open', sessionId: original, cols: 80, rows: 24 }))
        .code,
      'terminal_failed',
    );
    const failedId = server.store.terminalHistory(original)!.nativeId;
    assert.equal(
      (await client.request({ type: 'terminal.open', sessionId: original, cols: 80, rows: 24 })).ok,
      true,
    );
    const first = server.store.terminalHistory(original)!;
    assert.notEqual(first.nativeId, original);
    assert.equal(first.nativeId, failedId);
    assert.deepEqual(args[0], args[1]);
    assert.equal(args[0][args[0].indexOf('--session-id') + 1], first.nativeId);
    const opened = await client.wait((value) => value.type === 'terminal.opened');
    assert.equal((await client.histories(original))[0].available, false); // Managed active lock.
    assert.equal(
      (
        await client.request({
          type: 'terminal.close',
          sessionId: original,
          terminalId: opened.terminalId,
        })
      ).ok,
      true,
    );
    assert.equal((await client.histories(original))[0].available, false); // Empty native session.
    const command = {
      type: 'terminal.history.continue',
      sessionId: original,
      historySessionId: original,
      confirmed: true,
    };
    assert.equal((await client.request(command)).code, 'history_missing');
    const file = terminalHistoryPath(config, join(directory, 'native', first.root), first.nativeId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        type: 'user',
        sessionId: first.nativeId,
        message: { role: 'user', content: '中文历史任务' },
      }) + '\n',
    );
    const readyHistory = (await client.histories(original))[0];
    assert.equal(readyHistory.available, true, readyHistory.reason);
    assert.equal(readyHistory.title, '中文历史任务');
    const foreign = (
      await client.request({ type: 'server.session.create', title: 'another-project' })
    ).sessionId;
    assert.equal(
      (await client.request({ ...command, sessionId: foreign })).code,
      'history_unassociated',
    );
    const continueId = randomUUID();
    const resumed = await client.request(command, continueId);
    assert.equal(resumed.ok, true);
    assert.notEqual(resumed.sessionId, original);
    assert.equal(server.store.get(original).session.title, 'original');
    assert.equal(server.store.terminalHistory(resumed.sessionId)?.nativeId, first.nativeId);
    assert.equal((await client.request(command, continueId)).sessionId, resumed.sessionId);
    assert.equal(
      (
        await client.request({
          type: 'terminal.open',
          sessionId: resumed.sessionId,
          cols: 80,
          rows: 24,
        })
      ).ok,
      true,
    );
    assert.equal(args.at(-1)![args.at(-1)!.indexOf('--resume') + 1], first.nativeId);
    assert.equal(args.at(-1)!.includes('--session-id'), false);
    assert.equal((await client.request(command)).code, 'history_busy');
    socket!.terminate();
    await server.close();
    server = createProxyServer(options);
    client = await connect();
    assert.equal(server.store.terminalHistory(original)?.nativeId, first.nativeId);
    assert.equal((await client.request(command, continueId)).sessionId, resumed.sessionId); // Durable lost-response recovery.
    assert.equal((await client.histories(original))[0].available, true);
    const count = server.store.list().length;
    server.store.database.exec(
      "CREATE TRIGGER fail_history BEFORE INSERT ON terminal_history BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    assert.equal((await client.request(command)).ok, false);
    assert.equal(server.store.list().length, count); // Binding + business session + receipt are atomic.
    server.store.database.exec('DROP TRIGGER fail_history');
    // Same mapped project, but a different selected CLI directory.
    options.claude.environment.CLAUDE_CONFIG_DIR = join(directory, 'different-config');
    assert.equal((await client.histories(original))[0].available, false);
    assert.equal((await client.request(command)).code, 'history_environment_changed');
    options.claude.environment.CLAUDE_CONFIG_DIR = config;
    rmSync(file);
    assert.equal(
      (
        await client.request({
          type: 'terminal.open',
          sessionId: resumed.sessionId,
          cols: 80,
          rows: 24,
        })
      ).code,
      'history_missing',
    );
    assert.equal(args.length, 3); // One failed spawn, two successful PTYs; no silent new CLI or prompt replay.
  } finally {
    socket?.terminate();
    await server.close();
    hooks.deregister();
    Reflect.deleteProperty(globalThis, key);
    rmSync(directory, { recursive: true, force: true });
  }
});
