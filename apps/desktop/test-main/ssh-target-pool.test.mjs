import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSshTargetPool } from '../electron/ssh-target-pool.mjs';

class Channel extends EventEmitter {
  destroy() {
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close'));
    }
  }
}
class Target extends EventEmitter {
  calls = [];
  channels = [];
  exec(command, callback) {
    this.calls.push(command);
    const channel = new Channel();
    this.channels.push(channel);
    queueMicrotask(() => callback(null, channel));
  }
  sftp(callback) {
    this.exec('metadata', callback);
  }
  subsys(name, callback) {
    this.exec(name, callback);
  }
  destroy() {
    for (const channel of this.channels) channel.destroy();
    this.emit('close');
  }
}
const open = (pool, command, options) =>
  new Promise((resolve, reject) =>
    pool.exec(command, (error, channel) => (error ? reject(error) : resolve(channel)), options),
  );

test('metadata and cancellation slots remain available while work is held', async (t) => {
  const target = new Target();
  const pool = createSshTargetPool(target, () => assert.fail(), null, { connections: 1, work: 1 });
  t.after(() => pool.destroy());
  await open(pool, 'held');
  const metadata = await new Promise((resolve, reject) =>
    pool.sftp((error, value) => (error ? reject(error) : resolve(value))),
  );
  const control = await new Promise((resolve, reject) =>
    pool.execControl('cancel', (error, value) => (error ? reject(error) : resolve(value))),
  );
  assert.ok(metadata && control);
  assert.deepEqual(target.calls, ['held', 'metadata', 'cancel']);
});

test('pending work has a finite queue and deadline and the transport remains usable', async (t) => {
  const target = new Target();
  const pool = createSshTargetPool(target, () => assert.fail(), null, {
    connections: 1,
    work: 1,
    pending: 1,
    waitMs: 20,
  });
  t.after(() => pool.destroy());
  const held = await open(pool, 'held');
  const waiting = assert.rejects(open(pool, 'wait'), (error) => error.code === 'SSH_TARGET_BUSY');
  await assert.rejects(open(pool, 'overflow'), (error) => error.code === 'SSH_TARGET_BUSY');
  await waiting;
  assert.deepEqual(target.calls, ['held']);
  const closed = once(held, 'close');
  held.destroy();
  await closed;
  await open(pool, 'after');
  assert.deepEqual(target.calls, ['held', 'after']);
});

test('canceling queued input never dispatches it after a slot is released', async (t) => {
  const target = new Target();
  const pool = createSshTargetPool(target, () => assert.fail(), null, { connections: 1, work: 1 });
  t.after(() => pool.destroy());
  const held = await open(pool, 'held');
  const controller = new AbortController();
  const stopped = assert.rejects(
    open(pool, 'never', { signal: controller.signal }),
    (error) => error.code === 'ABORT_ERR',
  );
  controller.abort();
  await stopped;
  const closed = once(held, 'close');
  held.destroy();
  await closed;
  await open(pool, 'next');
  assert.deepEqual(target.calls, ['held', 'next']);
});

test('canceled openings keep their slot until the late remote channel closes', async (t) => {
  const target = new Target();
  let acknowledge;
  target.exec = (command, callback) => {
    target.calls.push(command);
    acknowledge = callback;
  };
  const pool = createSshTargetPool(target, () => assert.fail(), null, { connections: 1, work: 1 });
  t.after(() => pool.destroy());
  const controller = new AbortController();
  const canceled = assert.rejects(
    open(pool, 'opening', { signal: controller.signal }),
    (error) => error.code === 'ABORT_ERR',
  );
  controller.abort();
  await canceled;
  const next = open(pool, 'next');
  assert.deepEqual(target.calls, ['opening']);
  const late = new Channel();
  acknowledge(null, late);
  assert.equal(late.closed, true);
  assert.deepEqual(
    target.calls,
    ['opening'],
    'cancel must not release capacity before actual close',
  );
  await delay(0);
  assert.deepEqual(target.calls, ['opening', 'next']);
  acknowledge(null, new Channel());
  await next;
});

test('a lost member never replays dispatched work onto a surviving member', async (t) => {
  const first = new Target(),
    second = new Target();
  const pool = createSshTargetPool(first, async () => second, null, { work: 1 });
  t.after(() => pool.destroy());
  await open(pool, 'first-command');
  const other = await open(pool, 'second-command');
  first.destroy();
  const closed = once(other, 'close');
  other.destroy();
  await closed;
  await open(pool, 'new-command');
  assert.deepEqual(first.calls, ['first-command']);
  assert.deepEqual(second.calls, ['second-command', 'new-command']);
});

test('destroying a pool cancels queued authentication and work without starting another login', async () => {
  const first = new Target();
  let logins = 0;
  const pool = createSshTargetPool(
    first,
    async () => {
      logins++;
      return new Target();
    },
    null,
    { work: 1 },
  );
  await open(pool, 'held');
  const pending = assert.rejects(
    open(pool, 'never'),
    (error) => error.code === 'SSH_TARGET_CLOSED',
  );
  pool.destroy();
  await pending;
  await delay(0);
  assert.equal(logins, 0);
});
