import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { posix } from 'node:path';
import ssh2 from 'ssh2';
import { connectionKeys } from './ssh-keys.mjs';
import { discardChannel, repairChannelOutput } from './ssh-channel-output.mjs';
import { createSshTargetPool } from './ssh-target-pool.mjs';
import { supervisedCommand } from './ssh-command.mjs';

export const hostFingerprint = (key) =>
  `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

// Authentication happens only here on the desktop. The upstream service receives
// a separate, temporary identity for the adapter, never the target's credentials.
export async function connectSshTarget(config, secret, confirmHost, signal) {
  const first = await connectSshClient(config, secret, confirmHost, signal);
  if (signal.aborted) {
    first.destroy();
    throw new Error('连接已取消。');
  }
  let password = secret;
  const pool = createSshTargetPool(
    first,
    (openingSignal) => connectSshClient({ ...config }, password, () => false, openingSignal),
    signal,
  );
  pool.once('close', () => (password = ''));
  return pool;
}

async function connectSshClient(config, secret, confirmHost, signal) {
  const client = new ssh2.Client();
  const cancel = () => client.destroy();
  if (signal.aborted) throw new Error('连接已取消。');
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const privateKey = config.auth === 'key' ? await readFile(config.identityFile) : undefined;
    if (signal.aborted) throw new Error('连接已取消。');
    await new Promise((resolve, reject) => {
      let trustError;
      client.on('error', (error) => reject(trustError ?? error));
      client.once('close', () => reject(new Error('SSH 连接已关闭。')));
      client.once('ready', resolve);
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        ...(config.auth === 'key'
          ? { privateKey, passphrase: secret || undefined }
          : { password: secret }),
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 2,
        hostVerifier: (key, verify) => {
          const fingerprint = hostFingerprint(key);
          if (config.fingerprint) {
            const accepted = config.fingerprint === fingerprint;
            if (!accepted)
              trustError = Object.assign(new Error('SSH 主机指纹已变化，请核实后添加新的连接。'), {
                code: 'HOST_KEY_CHANGED',
              });
            verify(accepted);
          } else {
            Promise.resolve(confirmHost(fingerprint)).then(
              (accepted) => {
                if (accepted) config.fingerprint = fingerprint;
                else
                  trustError = Object.assign(new Error('未信任该 SSH 主机。'), {
                    code: 'HOST_NOT_TRUSTED',
                  });
                verify(!!accepted && !signal.aborted);
              },
              () => verify(false),
            );
          }
        },
      });
    });
    // Keep the established client's error event handled after the opening promise.
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export function targetExec(client, command, input = '') {
  return new Promise((resolve, reject) => {
    (client.execMetadata ?? client.exec).call(client, command, (error, channel) => {
      if (error) return reject(error);
      let stdout = '';
      let size = 0;
      channel.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) channel.destroy(new Error('SSH 检查输出过大。'));
        else stdout += chunk;
      });
      channel.stderr.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) channel.destroy(new Error('SSH 检查输出过大。'));
      });
      channel.once('error', reject);
      channel.once('close', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`SSH 检查失败（${code ?? '连接中断'}）。`)),
      );
      channel.end(input);
    });
  });
}

async function withDirectory(client, path, action) {
  if (
    typeof path !== 'string' ||
    (!path.startsWith('/') && path !== '.') ||
    path.includes('\0') ||
    path.length > 2048
  )
    throw new Error('请输入 Linux 项目的绝对路径。');
  const sftp = await new Promise((resolve, reject) =>
    client.sftp((error, value) => (error ? reject(error) : resolve(value))),
  );
  try {
    const canonical = await new Promise((resolve, reject) =>
      sftp.realpath(path, (error, value) => (error ? reject(error) : resolve(value))),
    );
    const info = await new Promise((resolve, reject) =>
      sftp.stat(canonical, (error, value) => (error ? reject(error) : resolve(value))),
    );
    if (!info.isDirectory()) throw new Error('项目路径不是目录。');
    return await action(sftp, canonical);
  } finally {
    sftp.end();
  }
}

export async function targetDirectory(client, path) {
  if (path === '.') throw new Error('请输入 Linux 项目的绝对路径。');
  return withDirectory(client, path, (_sftp, canonical) => canonical);
}

export function targetDirectories(client, path = '.') {
  return withDirectory(client, path, async (sftp, canonical) => {
    const files = await new Promise((resolve, reject) =>
      sftp.readdir(canonical, (error, value) => (error ? reject(error) : resolve(value))),
    );
    return {
      path: canonical,
      parent: posix.dirname(canonical),
      directories: files
        .filter(
          (file) => file.attrs.isDirectory() && file.filename !== '.' && file.filename !== '..',
        )
        .map((file) => ({ name: file.filename, path: posix.join(canonical, file.filename) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export async function startTargetAdapter(connectionId, target, options, signal, onFailure) {
  const keys = await connectionKeys(
    { spawn: (file, args, opts) => spawn(file, args, { ...opts, windowsHide: true }) },
    signal,
    options.keygen ?? 'ssh-keygen',
  );
  const allowed = ssh2.utils.parseKey(keys.loginPublic);
  const publicKey = allowed.getPublicSSH();
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [keys.hostPrivate] });
  const sockets = new Map();
  const listener = createServer((socket) => {
    const key = `${socket.remoteAddress}:${socket.remotePort}`;
    sockets.set(key, socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(key));
    socket.setTimeout(20000, () => socket.destroy());
    server.injectSocket(socket);
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    target.removeListener('close', lost);
    for (const client of clients) client.end();
    for (const socket of sockets.values()) socket.destroy();
    return new Promise((resolve) => listener.close(resolve));
  };
  const lost = () => {
    void close();
    onFailure('目标 SSH 连接已断开，在途命令结果可能未知。');
  };
  target.once('close', lost);
  signal.addEventListener('abort', close, { once: true });
  server.on('connection', (client, info) => {
    const openings = new Set();
    const commands = new Set();
    clients.add(client);
    client.on('error', () => client.end());
    client.once('close', () => clients.delete(client));
    client.once('close', () => {
      for (const pending of openings) pending.abort();
      for (const task of commands) task.cancel();
      commands.clear();
    });
    client.once('ready', () => sockets.get(`${info.ip}:${info.port}`)?.setTimeout(0));
    client.on('authentication', (ctx) => {
      const valid =
        ctx.username === 'device' &&
        ctx.method === 'publickey' &&
        ctx.key.data.length === publicKey.length &&
        timingSafeEqual(ctx.key.data, publicKey) &&
        (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true);
      valid ? ctx.accept() : ctx.reject(['publickey']);
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptCommand, _reject, { command }) => {
        // OpenSSH can send stdin and EOF before the target acknowledges exec.
        // Accept now so ssh2 buffers that input instead of discarding it.
        const local = acceptCommand();
        if (!local) return;
        const pending = new AbortController();
        const task = supervisedCommand(command, target);
        commands.add(task);
        openings.add(pending);
        const cancel = () => {
          pending.abort();
          task.cancel();
        };
        session.once('close', cancel);
        local.once('close', cancel);
        local.on('error', () => {});
        local.stderr.on('error', () => {});
        target.exec(
          task.command,
          (error, remote) => {
            openings.delete(pending);
            if (error) {
              commands.delete(task);
              if (!local.destroyed && !pending.signal.aborted) {
                local.stderr.write(
                  error.code === 'SSH_TARGET_BUSY'
                    ? '目标 SSH 通道繁忙，请稍后重试。\n'
                    : '无法在目标设备上打开命令通道；请检查目标 SSH 连接与会话限制。\n',
                );
                local.exit(255);
                local.close();
              }
            } else {
              remote.once('close', () => commands.delete(task));
              task.attach(
                remote,
                (stream) => attach(local, stream, task),
                () => {
                  if (pending.signal.aborted || local.destroyed) return;
                  local.stderr.write('目标命令启动失败；请检查 setsid、bash 和临时目录权限。\n');
                  local.exit(255);
                  local.close();
                },
              );
            }
          },
          {
            signal: pending.signal,
            onCanceledChannel: (remote) => {
              task.cancel();
              remote.once('close', () => commands.delete(task));
              task.attach(remote);
            },
          },
        );
      });
      session.on('subsystem', (acceptSubsystem, reject, { name }) => {
        if (name !== 'sftp') return reject();
        // SFTP clients can pipeline their INIT packet before confirmation too.
        const local = acceptSubsystem();
        if (!local) return;
        const pending = new AbortController();
        openings.add(pending);
        session.once('close', () => pending.abort());
        local.once('close', () => pending.abort());
        local.on('error', () => {});
        local.stderr.on('error', () => {});
        target.subsys(
          'sftp',
          (error, remote) => {
            openings.delete(pending);
            if (error) {
              if (!pending.signal.aborted)
                local.stderr.write('无法在目标设备上打开 SFTP 通道；请检查 SSH 连接与会话限制。\n');
              local.close();
            } else attach(local, remote);
          },
          { signal: pending.signal },
        );
      });
    });
  });
  function attach(local, remote, task) {
    const dispose = () => (task ? task.cancel() : discardChannel(remote));
    // ssh2 can mark an SSH channel closed without setting stream.destroyed.
    // An incoming EOF is valid stdin completion; a full close cancels input.
    if (
      !local ||
      local.destroyed ||
      closed ||
      local.incoming.state === 'closed' ||
      local.outgoing.state !== 'open'
    )
      return dispose();
    repairChannelOutput(local);
    local.on('error', dispose);
    remote.on('error', () => local.destroy());
    local.stderr.on('error', dispose);
    remote.stderr.on('error', () => local.destroy());
    local.once('close', dispose);
    local.pipe(remote);
    remote.pipe(local, { end: false });
    remote.stderr.pipe(local.stderr, { end: false });
    // SSH close can arrive while a readable is paused by downstream backpressure.
    // Flush both outputs before exit status/EOF, even if the target reports exit early.
    let stdoutDone = false;
    let stderrDone = false;
    let result;
    let ending = false;
    const finish = () => {
      if (!stdoutDone || !stderrDone || !result || ending || local.destroyed) return;
      ending = true;
      local.write('', (error) => {
        if (error || local.destroyed) return;
        local.stderr.end(() => {
          if (local.destroyed) return;
          const [code, signalName, coreDumped, description] = result;
          if (signalName) local.exit(signalName, coreDumped, description);
          else if (typeof code === 'number') local.exit(code);
          local.end();
        });
      });
    };
    remote.once('close', (...values) => {
      result = values;
      finish();
    });
    remote.once('end', () => {
      stdoutDone = true;
      finish();
    });
    remote.stderr.once('end', () => {
      stderrDone = true;
      finish();
    });
  }
  try {
    if (signal.aborted) throw new Error('连接已取消。');
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    listener.on('error', () => onFailure('SSH 适配端点已停止。'));
    if (signal.aborted) throw new Error('连接已取消。');
    return {
      port: listener.address().port,
      close,
      credentials: {
        type: 'tunnel.credentials',
        connectionId,
        username: 'device',
        privateKey: keys.loginPrivate,
        hostPublicKey: keys.hostPublic.trim().split(' ').slice(0, 2).join(' '),
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
