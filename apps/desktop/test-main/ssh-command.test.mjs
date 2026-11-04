import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { supervisedCommand } from '../electron/ssh-command.mjs';

function channel() {
  const remote = new PassThrough();
  remote.stderr = new PassThrough();
  remote.incoming = { state: 'open' };
  remote._exit = {};
  return remote;
}

test('supervised command strips only its bounded startup prelude and preserves byte output', async () => {
  const task = supervisedCommand("printf '%s' '$literal; 中文'", {});
  const remote = channel();
  const output = [];
  task.attach(remote, (stream) => stream.on('data', (chunk) => output.push(chunk)));
  remote.write(task.prelude.slice(0, 8));
  remote.write(Buffer.concat([Buffer.from(task.prelude.slice(8)), Buffer.from([0, 255, 13, 10])]));
  await new Promise(setImmediate);
  assert.deepEqual(Buffer.concat(output), Buffer.from([0, 255, 13, 10]));
  remote.emit('exit', 0);
  task.cancel();
  remote.destroy();
});

test('cancel before late acknowledgement waits for identity and signals only once on reserved capacity', () => {
  const commands = [];
  const task = supervisedCommand('sleep 600', { execControl: (command) => commands.push(command) });
  task.cancel();
  const remote = channel();
  task.attach(remote, () => assert.fail('canceled output must not be forwarded'));
  remote.write(task.prelude);
  task.cancel();
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes(task.token));
  remote.destroy();
});

test('normal exit and stdin EOF do not cancel successfully launched background services', () => {
  const task = supervisedCommand('nohup service &', {
    execControl: () => assert.fail('unexpected cancel'),
  });
  const remote = channel();
  task.attach(remote, () => {});
  remote.write(task.prelude);
  remote.emit('exit', 0);
  task.cancel();
  remote.destroy();
});

test('cancel before an already completed acknowledgement drains late output without signaling', async () => {
  const task = supervisedCommand('completed &', {
    execControl: () => assert.fail('completed command must survive'),
  });
  task.cancel();
  const remote = channel();
  remote._exit = { code: 0 };
  task.attach(remote, () => assert.fail('closed caller must not receive output'));
  remote.stderr.write('buffered stderr');
  remote.write(task.prelude + 'buffered stdout');
  await new Promise(setImmediate);
  assert.equal(remote.destroyed, true);
});
