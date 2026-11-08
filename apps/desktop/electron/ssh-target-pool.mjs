import { EventEmitter } from 'node:events';
import { discardChannel, openChannelRequest } from './ssh-channel-output.mjs';

const unavailable = () =>
  Object.assign(new Error('目标 SSH 连接已断开；在途命令结果可能未知。'), {
    code: 'SSH_TARGET_CLOSED',
  });
const canceled = () =>
  Object.assign(new Error('SSH 请求已取消，未重新执行。'), { code: 'ABORT_ERR' });
const busy = () =>
  Object.assign(new Error('目标 SSH 通道繁忙，请等待已有任务释放通道后再试。'), {
    code: 'SSH_TARGET_BUSY',
  });

// Two authenticated transports support 16 held commands. Each transport retains
// one metadata slot and one cancellation slot below OpenSSH's default limit10.
export function createSshTargetPool(
  first,
  connect,
  signal,
  { connections = 2, work = 8, metadata = 1, control = 1, pending = 64, waitMs = 15000 } = {},
) {
  const pool = new EventEmitter();
  pool.on('error', () => {});
  const members = [];
  const queue = [];
  const controller = new AbortController();
  const limits = { work, metadata, control };
  let closed = false;
  let opening = false;
  let dial = connect;
  const finish = (entry, error, channel) => {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.callback(error, channel);
  };
  function add(client) {
    const member = { client, work: 0, metadata: 0, control: 0 };
    members.push(member);
    client.on('error', (error) => pool.emit('error', error));
    client.once('close', () => {
      const index = members.indexOf(member);
      if (index !== -1) members.splice(index, 1);
      if (!closed && !members.length && !opening) pool.destroy();
      else drain();
    });
  }
  function grow() {
    if (closed || opening || members.length >= connections || !queue.length) return;
    opening = true;
    Promise.resolve()
      .then(() => dial(controller.signal))
      .then(
        (client) => {
          opening = false;
          if (closed) return client.destroy();
          add(client);
          drain();
        },
        (error) => {
          opening = false;
          if (closed) return;
          pool.emit('error', error);
          // None of these entries reached a target. Report the opening failure;
          // never redistribute a command already dispatched to a failed member.
          for (const entry of queue.splice(0)) finish(entry, error);
          if (!members.length || ['HOST_KEY_CHANGED', 'HOST_NOT_TRUSTED'].includes(error.code))
            pool.destroy();
        },
      );
  }
  function drain() {
    if (closed) return;
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      const member = members
        .filter((item) => item[entry.kind] < limits[entry.kind])
        .sort((a, b) => a.work + a.metadata + a.control - b.work - b.metadata - b.control)[0];
      if (!member) {
        index++;
        continue;
      }
      queue.splice(index, 1);
      clearTimeout(entry.timer);
      entry.started = true;
      member[entry.kind]++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        member[entry.kind]--;
        drain();
      };
      try {
        openChannelRequest(
          member.client,
          (done) => entry.open(member.client, done),
          (error, channel, failed) => {
            if (error) {
              if (failed && failed.incoming.state !== 'closed') {
                failed.once('close', release);
                discardChannel(failed);
              } else release();
              return finish(entry, error);
            }
            entry.channel = channel;
            channel.once('close', release);
            if (channel.incoming?.state === 'closed') release();
            if (entry.cancelled || closed) {
              if (entry.onCanceledChannel && !closed) entry.onCanceledChannel(channel);
              else discardChannel(channel);
              finish(entry, canceled());
            } else finish(entry, null, channel);
          },
        );
      } catch (error) {
        release();
        finish(entry, error);
      }
    }
    grow();
  }
  function request(kind, open, callback, options = {}) {
    // Work must not exhaust admission for the reserved metadata/control slots.
    // Each kind keeps the same finite waiting limit and deadline.
    if (
      closed ||
      options.signal?.aborted ||
      queue.filter((entry) => entry.kind === kind).length >= pending
    ) {
      queueMicrotask(() =>
        callback(closed ? unavailable() : options.signal?.aborted ? canceled() : busy()),
      );
      return;
    }
    const entry = {
      kind,
      open,
      callback,
      signal: options.signal,
      onCanceledChannel: options.onCanceledChannel,
      started: false,
      done: false,
    };
    entry.abort = () => {
      entry.cancelled = true;
      if (!entry.started) {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
      } else discardChannel(entry.channel);
      finish(entry, canceled());
      drain();
    };
    entry.signal?.addEventListener('abort', entry.abort, { once: true });
    entry.timer = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index !== -1) queue.splice(index, 1);
      finish(entry, busy());
      drain();
    }, waitMs);
    queue.push(entry);
    drain();
  }
  pool.exec = (command, callback, options) =>
    request('work', (client, done) => client.exec(command, done), callback, options);
  pool.subsys = (name, callback, options) =>
    request('work', (client, done) => client.subsys(name, done), callback, options);
  pool.sftp = (callback) => request('metadata', (client, done) => client.sftp(done), callback);
  pool.execMetadata = (command, callback) =>
    request('metadata', (client, done) => client.exec(command, done), callback);
  pool.execControl = (command, callback) =>
    request('control', (client, done) => client.exec(command, done), callback);
  pool.destroy = () => {
    if (closed) return pool;
    closed = true;
    signal?.removeEventListener('abort', abort);
    controller.abort();
    dial = undefined;
    for (const entry of queue.splice(0)) finish(entry, unavailable());
    for (const { client } of members.splice(0)) client.destroy();
    pool.emit('close');
    return pool;
  };
  const abort = () => pool.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  add(first);
  if (signal?.aborted) pool.destroy();
  return pool;
}
