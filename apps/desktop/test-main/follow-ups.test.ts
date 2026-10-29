import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FollowUps } from '../src/followUps.ts';
import type { ClientState, ProxyClient } from '../src/client.ts';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const id = randomUUID();
  const initialRun = randomUUID();
  const state = {
    status: 'connected',
    sessions: [{ id, activeRun: { id: initialRun, status: 'running' } }],
    events: { [id]: [] as SessionEvent[] },
    history: {},
  } as unknown as ClientState;
  const listeners = new Set<() => void>();
  const calls: { text: string; requestId: string }[] = [];
  let fail = false;
  const update = () => {
    for (const listener of listeners) listener();
  };
  const client = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request: async (command: { text: string }, requestId: string) => {
      calls.push({ text: command.text, requestId });
      const runId = randomUUID();
      state.sessions[0].activeRun = { id: runId, status: 'running', connectionId: randomUUID() };
      state.events[id].push({
        sessionId: id,
        runId,
        sequence: state.events[id].length + 1,
        createdAt: new Date().toISOString(),
        payload: {
          type: 'message.user',
          messageId: requestId,
          text: command.text,
          scenario: 'chat',
        },
      });
      update();
      if (fail) throw new Error('response lost');
      return { ok: true, requestId, type: 'response' };
    },
  } as unknown as Pick<ProxyClient, 'request' | 'getSnapshot' | 'subscribe'>;
  const queue = new FollowUps(client);
  const close = queue.start();
  const end = (status: 'completed' | 'cancelled' | 'failed') => {
    const runId = state.sessions[0].activeRun!.id;
    state.sessions[0].activeRun = null;
    state.events[id].push({
      sessionId: id,
      runId,
      sequence: state.events[id].length + 1,
      createdAt: new Date().toISOString(),
      payload: { type: 'run.status', status, connectionId: randomUUID() },
    });
    update();
  };
  return {
    id,
    state,
    calls,
    queue,
    client,
    close,
    end,
    update,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

test('follow-ups wait for completion and send once per run in FIFO order, even off the selected session', async () => {
  const { id, state, calls, queue, end, update } = fixture();
  queue.enqueue(id, 'first', 'chat');
  queue.enqueue(id, 'second', 'chat');
  state.selectedId = randomUUID();
  update();
  assert.equal(calls.length, 0);
  end('completed');
  await tick();
  update();
  assert.deepEqual(
    calls.map((call) => call.text),
    ['first'],
  );
  assert.equal(queue.getSnapshot().items[id].length, 1);
  end('completed');
  await tick();
  assert.deepEqual(
    calls.map((call) => call.text),
    ['first', 'second'],
  );
  assert.equal(queue.getSnapshot().items[id].length, 0);
});

test('stopping, failure and reconnect require explicit queue confirmation', async () => {
  for (const reason of ['cancelled', 'failed', 'disconnect'] as const) {
    const { id, state, calls, queue, end, update } = fixture();
    queue.enqueue(id, 'keep this', 'chat');
    if (reason === 'disconnect') {
      state.status = 'reconnecting';
      update();
      state.status = 'connected';
      update();
      end('completed');
    } else end(reason);
    await tick();
    assert.equal(calls.length, 0);
    assert.ok(queue.getSnapshot().paused[id]);
    queue.resume(id);
    await tick();
    assert.equal(calls.length, 1);
  }
});

test('a lost response keeps the message paused and manual retry reuses its request ID', async () => {
  const { id, calls, queue, end, setFail } = fixture();
  queue.enqueue(id, 'uncertain', 'chat');
  setFail(true);
  end('completed');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(queue.getSnapshot().items[id].length, 1);
  assert.equal(queue.getSnapshot().paused[id], 'response lost');
  queue.edit(id, queue.getSnapshot().items[id][0].id, 'different content');
  assert.equal(queue.getSnapshot().items[id][0].text, 'uncertain');
  setFail(false);
  await queue.sendNow(id, queue.getSnapshot().items[id][0].id);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(queue.getSnapshot().items[id].length, 0);
});

test('queued edits and removals preserve the order and explicit steering does not drain the rest', async () => {
  const { id, calls, queue } = fixture();
  queue.enqueue(id, 'first', 'chat');
  queue.enqueue(id, 'remove', 'chat');
  queue.enqueue(id, 'last', 'chat');
  const items = queue.getSnapshot().items[id];
  queue.pause(id);
  queue.edit(id, items[0].id, 'edited first');
  queue.remove(id, items[1].id);
  await queue.sendNow(id, items[2].id);
  assert.deepEqual(
    calls.map((call) => call.text),
    ['last'],
  );
  assert.deepEqual(
    queue.getSnapshot().items[id].map((item) => item.text),
    ['edited first'],
  );
  assert.ok(queue.getSnapshot().paused[id]);
  queue.remove(id, queue.getSnapshot().items[id][0].id);
  queue.enqueue(id, 'fresh queue', 'chat');
  assert.equal(queue.getSnapshot().paused[id], '');
});

test('refresh restores unsent messages with stable IDs and waits for confirmation', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
  const { id, client, close, queue, calls, end } = fixture();
  queue.enqueue(id, 'survive refresh', 'chat');
  const messageId = queue.getSnapshot().items[id][0].id;
  close();
  const restored = new FollowUps(client);
  restored.start();
  end('completed');
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(restored.getSnapshot().items[id][0].id, messageId);
  restored.resume(id);
  await tick();
  assert.deepEqual(calls, [{ text: 'survive refresh', requestId: messageId }]);
});
