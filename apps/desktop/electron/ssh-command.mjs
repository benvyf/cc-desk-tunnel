import { randomBytes } from 'node:crypto';
import { discardChannel } from './ssh-channel-output.mjs';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const supervisor = String.raw`
dir=/tmp/cc-space-$2
mkdir -m 700 "$dir" || exit 125
mkfifo -m 600 "$dir/cancel" || { rmdir "$dir"; exit 125; }
leader=$BASHPID
cleanup() {
  kill "$watcher" 2>/dev/null || :
  wait "$watcher" 2>/dev/null || :
  rm -f "$dir/cancel"
  rmdir "$dir" 2>/dev/null || :
}
cancel() {
  trap '' USR1
  trap ':' TERM HUP
  kill -TERM -- "-$leader" 2>/dev/null || :
  sleep 1
  rm -f "$dir/cancel"
  rmdir "$dir" 2>/dev/null || :
  kill -KILL -- "-$leader"
}
trap cleanup EXIT
trap ':' HUP
trap cancel USR1
( read -r _ < "$dir/cancel" && kill -USR1 "$leader" ) &
watcher=$!
printf 'CCSPACE:%s:READY\n' "$2"
/bin/bash -c "$1" <&0 &
child=$!
wait "$child"
status=$?
exit "$status"
`;

// A private FIFO addresses a live supervisor, rather than signaling a stored PID
// that might have been reused after normal completion. Only exec is supervised.
export function supervisedCommand(original, target) {
  const token = randomBytes(16).toString('hex');
  const prelude = `CCSPACE:${token}:READY\n`;
  let remote;
  let canceled = false;
  let complete = false;
  let ready = false;
  let signaled = false;
  let discardTimer;
  const stop = () => {
    if (!remote || !canceled) return;
    if (complete) return discardChannel(remote);
    if (!ready || signaled) return;
    signaled = true;
    remote.unpipe();
    remote.stderr.unpipe();
    remote.resume();
    remote.stderr.resume();
    const command = `/bin/bash -c ${quote('test -p "$1/cancel" || exit 0; timeout 2 /bin/bash -c \'printf "stop\\n" > "$1/cancel"\' cc-space "$1"')} cc-space ${quote(`/tmp/cc-space-${token}`)}`;
    target.execControl(command, (error, control) => {
      if (error) return;
      control.on('error', () => {});
      control.resume();
      control.stderr.resume();
      control.end();
    });
    // Leave the exec transport alive through TERM/KILL. A failed control request
    // cannot prove remote termination; the target-disconnect path reports that.
    discardTimer = setTimeout(() => discardChannel(remote), 5000);
    discardTimer.unref?.();
  };
  return {
    token,
    prelude,
    command: `export CC_DESK_TUNNEL_SHELL=/bin/bash; exec setsid --wait /bin/bash -c ${quote(supervisor)} cc-space ${quote(original)} ${quote(token)}`,
    cancel() {
      canceled = true;
      if (complete) discardChannel(remote);
      else stop();
    },
    attach(channel, forward = () => {}, onError = () => {}) {
      remote = channel;
      complete = typeof remote._exit?.code === 'number' || !!remote._exit?.signal;
      remote.once('exit', () => (complete = true));
      remote.on('error', () => {});
      remote.stderr.on('error', () => {});
      remote.once('close', () => {
        clearTimeout(startupTimer);
        clearTimeout(discardTimer);
        if (!ready && !canceled) onError();
      });
      let header = Buffer.alloc(0);
      const startupTimer = setTimeout(() => {
        if (!canceled) onError();
        discardChannel(remote);
      }, 10000);
      startupTimer.unref?.();
      const data = (chunk) => {
        const needed = Buffer.byteLength(prelude) - header.length;
        header = Buffer.concat([header, chunk.subarray(0, needed)]);
        if (!Buffer.from(prelude).subarray(0, header.length).equals(header)) {
          clearTimeout(startupTimer);
          if (!canceled) onError();
          discardChannel(remote);
          return;
        }
        if (header.length < Buffer.byteLength(prelude)) return;
        clearTimeout(startupTimer);
        remote.pause();
        remote.removeListener('data', data);
        if (chunk.length > needed) remote.unshift(chunk.subarray(needed));
        ready = true;
        if (canceled) stop();
        else {
          forward(remote);
          remote.resume();
        }
      };
      remote.on('data', data);
    },
  };
}
