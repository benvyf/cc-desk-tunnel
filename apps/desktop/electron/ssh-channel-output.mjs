import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('ssh2/package.json');
if (version !== '1.17.0')
  throw new Error('SSH channel output adapter requires review for ssh2 upgrades.');

const discarded = new WeakSet();
export function discardChannel(channel) {
  if (!channel || discarded.has(channel)) return;
  discarded.add(channel);
  channel.on('error', () => {});
  channel.stderr?.on('error', () => {});
  // ssh2 delays Channel.close until unread stdout/stderr have drained, and its
  // destroy() does not set Node's destroyed flag. Discard both outputs so an
  // abandoned channel can finish its close handshake and release its lease.
  channel.resume?.();
  channel.stderr?.resume?.();
  channel.destroy();
}

export function openChannelRequest(client, open, callback) {
  const manager = client._chanMgr;
  if (!manager) return open(callback);
  const add = manager.add;
  let id;
  // exec/subsys can reject after CHANNEL_OPEN_CONFIRMATION without returning
  // or closing that Channel in ssh2 1.17. Capture this synchronous allocation
  // only; concurrent requests retain separate IDs and unrelated work stays live.
  manager.add = function (...args) {
    id = add.apply(this, args);
    return id;
  };
  try {
    return open((error, channel) => {
      const failed = error && id !== undefined ? manager.get(id) : null;
      callback(error, channel, failed && typeof failed === 'object' ? failed : null);
    });
  } finally {
    manager.add = add;
  }
}

// ssh2 1.17.0 shares one send window between stdout and stderr, but keeps stale
// pending-write fields after completion and resumes only one stream per window
// adjustment. An old stdout callback can therefore starve stderr indefinitely.
// Keep this version-specific integration here; callers still use public streams.
// Source: https://github.com/mscdex/ssh2/blob/v1.17.0/lib/Channel.js
export function repairChannelOutput(channel) {
  const pending = new Set();
  const wrapped = new WeakSet();
  let closed = false;
  const outputs = [
    { stream: channel, chunk: '_chunk', callback: '_chunkcb' },
    { stream: channel.stderr, chunk: '_chunkErr', callback: '_chunkcbErr' },
  ];

  for (const [index, output] of outputs.entries()) {
    const write = output.stream._write;
    const other = outputs[1 - index];
    output.stream._write = function (data, encoding, callback) {
      // Window adjustments invoke _write again with the same completion callback.
      // Do not wrap that continuation a second time.
      if (wrapped.has(callback)) return write.call(this, data, encoding, callback);
      let completed = false;
      const done = (error) => {
        if (completed) return;
        completed = true;
        pending.delete(done);
        channel[output.chunk] = undefined;
        channel[output.callback] = undefined;
        callback(error);
        if (closed || channel.outgoing.state !== 'open' || !channel[other.chunk]) return;
        // A resumed write may leave window space without another window-adjust
        // packet. Give the other blocked stream that remaining space immediately.
        if (channel.outgoing.window > 0)
          other.stream._write(channel[other.chunk], null, channel[other.callback]);
        else channel._waitWindow = true;
      };
      wrapped.add(done);
      pending.add(done);
      if (closed) return done(new Error('SSH output channel closed'));
      return write.call(this, data, encoding, done);
    };
  }

  channel.once('close', () => {
    closed = true;
    // The library abandons blocked write callbacks when a channel closes. Settle
    // them once so pipes can release their buffers and error handlers can stop work.
    for (const done of pending) done(new Error('SSH output channel closed'));
    channel._waitWindow = false;
  });
}
