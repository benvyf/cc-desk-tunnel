import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server as NetServer } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import ssh2 from 'ssh2';
import { Tunnel, sshProbe } from '../../server/src/tunnel.ts';
import { openChannels } from '../electron/tunnel-channels.mjs';
import { createSshTargets } from '../electron/ssh-targets.mjs';
import { createProxyServer } from '../../server/src/server.ts';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { repairChannelOutput } from '../electron/ssh-channel-output.mjs';
import {
  connectSshTarget,
  startTargetAdapter,
  targetDirectory,
} from '../electron/ssh-target-adapter.mjs';

test(
  'pipelined exec input and SFTP INIT survive delayed target acknowledgements',
  { timeout: 15000 },
  async (t) => {
    for (const kind of ['exec', 'sftp']) {
      await t.test(kind, async (t) => {
        const f = await fixture(t);
        const { target, client } = await adapterOf(t, f);
        const method = kind === 'exec' ? 'exec' : 'subsys';
        const original = target[method].bind(target);
        target[method] = (command, callback) => setTimeout(() => original(command, callback), 100);
        const request = kind === 'exec' ? 'exec' : 'subsystem';
        const send = client._protocol[request].bind(client._protocol);
        const input =
          kind === 'exec'
            ? Buffer.from('pipelined stdin 中文\n')
            : Buffer.from([0, 0, 0, 5, 1, 0, 0, 0, 3]);
        client._protocol[request] = (recipient, command, wantReply) => {
          send(recipient, command, wantReply);
          // Model OpenSSH's legal pipelining, without waiting for CHANNEL_SUCCESS.
          client._protocol.channelData(recipient, input);
          if (kind === 'exec') client._protocol.channelEOF(recipient);
        };
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Pipelined input was lost')), 2000);
          client[method](kind === 'exec' ? 'target-command' : 'sftp', (error, channel) => {
            if (error) {
              clearTimeout(timer);
              return reject(error);
            }
            channel.on('error', () => {});
            channel.stderr.resume();
            const output = [];
            channel.on('data', (data) => {
              output.push(data);
              if (kind === 'sftp') {
                clearTimeout(timer);
                resolve({ bytes: Buffer.concat(output) });
                channel.close();
              }
            });
            if (kind === 'exec')
              channel.once('close', (code) => {
                clearTimeout(timer);
                resolve({ code, bytes: Buffer.concat(output) });
              });
          });
        });
        if (kind === 'exec') {
          assert.equal(result.code, 7);
          assert.deepEqual(result.bytes, input);
        } else {
          assert.equal(result.bytes[4], 2);
          assert.equal(result.bytes.readUInt32BE(5), 3);
        }
      });
    }
  },
);

async function nativeProbeOnTestHost(configPath) {
  // Production is Linux. This gives Windows test keys the equivalent of 0600.
  if (process.platform === 'win32') {
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
    }).match(/S-1-\d+(?:-\d+)+/)[0];
    execFileSync(
      'icacls.exe',
      [join(dirname(configPath), 'identity'), '/inheritance:r', '/grant:r', `*${sid}:F`],
      {
        windowsHide: true,
      },
    );
  }
  return sshProbe(configPath);
}

test(
  'closing a caller before target acknowledgement never forwards its buffered input',
  { timeout: 15000 },
  async (t) => {
    for (const kind of ['exec', 'sftp']) {
      await t.test(kind, async (t) => {
        const f = await fixture(t);
        const { target, client } = await adapterOf(t, f);
        const method = kind === 'exec' ? 'exec' : 'subsys';
        const original = target[method].bind(target);
        const barrier = target.exec.bind(target);
        let release;
        const opening = new Promise((resolve) => {
          target[method] = (command, callback) =>
            original(command, (error, remote) => {
              assert.ifError(error);
              release = () => callback(error, remote);
              resolve();
            });
        });
        const channel = await new Promise((resolve, reject) =>
          client[method](kind === 'exec' ? 'canceled-command' : 'sftp', (error, value) =>
            error ? reject(error) : resolve(value),
          ),
        );
        channel.on('error', () => {});
        channel.resume();
        channel.stderr.resume();
        await opening;
        const input =
          kind === 'exec'
            ? Buffer.from('canceled stdin must never reach the target')
            : Buffer.from([0, 0, 0, 5, 1, 0, 0, 0, 3]);
        channel.write(input);
        const closed = once(channel, 'close');
        channel.close();
        await closed;
        assert.equal(f.controls.inputBytes, 0);
        assert.equal(f.controls.sftpInits, 0);
        release();
        // A subsequent channel on the same target SSH transport is a barrier:
        // any canceled input forwarded before it must already have arrived.
        await new Promise((resolve, reject) =>
          barrier('barrier', (error, value) => {
            if (error) return reject(error);
            value.on('error', reject);
            value.resume();
            value.stderr.resume();
            value.once('close', resolve);
            value.end();
          }),
        );
        assert.equal(f.controls.inputBytes, 0, 'closed exec must discard buffered stdin');
        assert.equal(f.controls.sftpInits, 0, 'closed SFTP must discard buffered INIT');
      });
    }
  },
);

test(
  'forwarding failures close their channel without breaking the adapter',
  { timeout: 15000 },
  async (t) => {
    for (const kind of ['exec', 'sftp']) {
      for (const closeFirst of [false, true]) {
        await t.test(
          `${kind} ${closeFirst ? 'caller already closed' : 'open failed'}`,
          async (t) => {
            const f = await fixture(t);
            const { target, client } = await adapterOf(t, f);
            const method = kind === 'exec' ? 'exec' : 'subsys';
            const original = target[method].bind(target);
            let fail;
            target[method] = (_command, callback) => {
              fail = () => callback(new Error('target refused'));
            };
            const channel = await new Promise((resolve, reject) =>
              client[method](kind === 'exec' ? 'failing-command' : 'sftp', (error, value) =>
                error ? reject(error) : resolve(value),
              ),
            );
            channel.on('error', () => {});
            channel.resume();
            channel.stderr.resume();
            const closed = once(channel, 'close');
            if (closeFirst) {
              channel.close();
              await closed;
              fail();
            } else {
              fail();
              const [code] = await closed;
              if (kind === 'exec') assert.equal(code, 255);
            }
            target[method] = original;
            const result = await new Promise((resolve, reject) =>
              client.exec('still-usable', (error, value) => {
                if (error) return reject(error);
                const output = [];
                value.on('data', (data) => output.push(data));
                value.stderr.resume();
                value.once('close', (code) =>
                  resolve({ code, text: Buffer.concat(output).toString() }),
                );
                value.end('still usable');
              }),
            );
            assert.deepEqual(result, { code: 7, text: 'still usable' });
          },
        );
      }
    }
  },
);

// Real SSH transports and SFTP packets. The target's command handler is a fixture:
// no test starts a local project command or contacts a model provider.
async function fixture(t, loginKey) {
  const key = ssh2.utils.generateKeyPairSync('rsa', { bits: 2048 });
  const server = new ssh2.Server({ hostKeys: [key.private] });
  const peers = new Set();
  const commands = [];
  const files = new Map();
  const controls = {
    capabilities: true,
    sftp: true,
    logins: 0,
    earlyExit: false,
    inputBytes: 0,
    sftpInits: 0,
  };
  server.on('connection', (client) => {
    client.once('ready', () => controls.logins++);
    peers.add(client);
    client.on('error', () => {});
    client.once('close', () => peers.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'dev') return ctx.reject();
      if (loginKey && ctx.method === 'publickey') {
        const allowed = ssh2.utils.parseKey(loginKey.public);
        if (
          allowed.getPublicSSH().equals(ctx.key.data) &&
          (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))
        )
          return ctx.accept();
      }
      if (!loginKey && ctx.method === 'password' && ctx.password === 'test-password')
        return ctx.accept();
      ctx.reject();
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptCommand, _reject, { command }) => {
        commands.push(command);
        const stream = acceptCommand();
        stream.on('error', () => {});
        stream.stderr.on('error', () => {});
        repairChannelOutput(stream);
        const parts = [];
        stream.on('data', (chunk) => {
          parts.push(chunk);
          controls.inputBytes += chunk.length;
        });
        stream.on('end', () => {
          if (stream.destroyed || stream.writableEnded || stream.outgoing.state !== 'open') return;
          const input = Buffer.concat(parts);
          const check =
            command === 'test "$(uname -s)" = Linux && test -x /bin/bash' ||
            input.toString().startsWith('echo CC_DESK_TUNNEL_SSH_READY');
          const output = () => {
            stream.write(input);
            stream.stderr.end(check ? '' : 'remote stderr', () => {
              if (check || !controls.earlyExit)
                stream.exit(check ? (controls.capabilities ? 0 : 1) : 7);
              stream.end();
            });
          };
          if (!check && controls.earlyExit) {
            stream.exit(7);
            setImmediate(output);
          } else output();
        });
      });
      session.on('sftp', (acceptSftp, reject) => {
        if (!controls.sftp) return reject();
        const sftp = acceptSftp();
        sftp.on('ready', () => controls.sftpInits++);
        const { STATUS_CODE } = ssh2.utils.sftp;
        sftp.on('REALPATH', (id, path) => {
          const canonical = path === '.' ? '/home/dev' : path;
          sftp.name(id, [{ filename: canonical, longname: canonical, attrs: {} }]);
        });
        const listed = new Set();
        sftp.on('OPENDIR', (id, path) => sftp.handle(id, Buffer.from(`directory:${path}`)));
        sftp.on('READDIR', (id, handle) => {
          const path = handle.toString();
          if (listed.has(path)) return sftp.status(id, STATUS_CODE.EOF);
          listed.add(path);
          sftp.name(id, [
            { filename: 'project', longname: 'project', attrs: { mode: 0o40755 } },
            { filename: 'file.txt', longname: 'file.txt', attrs: { mode: 0o100644 } },
            { filename: '..', longname: '..', attrs: { mode: 0o40755 } },
          ]);
        });
        sftp.on('STAT', (id) =>
          sftp.attrs(id, { mode: 0o40755, uid: 1, gid: 1, size: 0, atime: 0, mtime: 0 }),
        );
        sftp.on('OPEN', (id, path, flags) => {
          if (flags & 8) files.set(path, Buffer.alloc(0));
          sftp.handle(id, Buffer.from(path));
        });
        sftp.on('FSTAT', (id, handle) =>
          sftp.attrs(id, {
            mode: 0o100644,
            uid: 1,
            gid: 1,
            size: files.get(handle.toString()).length,
            atime: 0,
            mtime: 0,
          }),
        );
        sftp.on('WRITE', (id, handle, offset, data) => {
          const previous = files.get(handle.toString());
          const next = Buffer.alloc(Math.max(previous.length, offset + data.length));
          previous.copy(next);
          data.copy(next, offset);
          files.set(handle.toString(), next);
          sftp.status(id, STATUS_CODE.OK);
        });
        sftp.on('CLOSE', (id) => sftp.status(id, STATUS_CODE.OK));
        sftp.on('READ', (id, handle, offset, length) => {
          const data = files.get(handle.toString()).subarray(offset, offset + length);
          data.length ? sftp.data(id, data) : sftp.status(id, STATUS_CODE.EOF);
        });
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const client of peers) client.end();
    server.close();
  });
  return {
    config: { host: '127.0.0.1', port: server.address().port, username: 'dev', auth: 'password' },
    commands,
    files,
    controls,
    drop: () => {
      for (const client of peers) client.end();
    },
  };
}

async function adapterOf(t, f) {
  const controller = new AbortController();
  const target = await connectSshTarget(
    f.config,
    'test-password',
    async () => true,
    controller.signal,
  );
  t.after(() => target.destroy());
  const adapter = await startTargetAdapter(randomUUID(), target, {}, controller.signal, () => {});
  t.after(() => adapter.close());
  const client = new ssh2.Client();
  client.on('error', () => {});
  const ready = once(client, 'ready');
  client.connect({
    host: '127.0.0.1',
    port: adapter.port,
    username: adapter.credentials.username,
    privateKey: adapter.credentials.privateKey,
  });
  await ready;
  t.after(() => client.destroy());
  return { target, client, adapter };
}

test(
  'target host trust is explicit, pinned, and rejects changes before authentication',
  { timeout: 15000 },
  async (t) => {
    const first = await fixture(t);
    const controller = new AbortController();
    await assert.rejects(
      connectSshTarget(first.config, 'test-password', async () => false, controller.signal),
      /未信任/,
    );
    const client = await connectSshTarget(
      first.config,
      'test-password',
      async () => true,
      controller.signal,
    );
    client.destroy();
    assert.match(first.config.fingerprint, /^SHA256:/);
    const second = await fixture(t);
    await assert.rejects(
      connectSshTarget(
        { ...second.config, fingerprint: first.config.fingerprint },
        'test-password',
        () => assert.fail('must not ask to replace a pinned key'),
        controller.signal,
      ),
      /指纹已变化/,
    );
  },
);

test(
  'encrypted identity files authenticate locally and reject a wrong passphrase',
  { timeout: 15000 },
  async (t) => {
    const loginKey = ssh2.utils.generateKeyPairSync('rsa', {
      bits: 2048,
      cipher: 'aes256-cbc',
      passphrase: 'test-only-passphrase',
    });
    const f = await fixture(t, loginKey);
    const directory = await mkdtemp(join(tmpdir(), 'cc-ssh-identity-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const identityFile = join(directory, 'identity');
    await writeFile(identityFile, loginKey.private, { mode: 0o600 });
    const config = { ...f.config, auth: 'key', identityFile };
    await assert.rejects(
      connectSshTarget(config, 'wrong', async () => true, new AbortController().signal),
    );
    const client = await connectSshTarget(
      config,
      'test-only-passphrase',
      async () => true,
      new AbortController().signal,
    );
    client.destroy();
  },
);

test(
  'adapter preserves exec input, stderr and nonzero exit over two real SSH transports',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    f.controls.earlyExit = true;
    const { client } = await adapterOf(t, f);
    const data = Buffer.from('remote input 中文\n'.repeat(180000));
    const stream = await new Promise((resolve, reject) =>
      client.exec('exec "$CC_DESK_TUNNEL_SHELL" -s', (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const stdout = [],
      stderr = [];
    stream.on('data', (chunk) => stdout.push(chunk));
    stream.stderr.on('data', (chunk) => stderr.push(chunk));
    let outputAtExit = 0;
    stream.once('exit', () => (outputAtExit = Buffer.concat(stdout).length));
    const finished = once(stream, 'close');
    stream.end(data);
    const [code] = await finished;
    assert.equal(code, 7);
    assert.equal(outputAtExit, data.length, 'exit status must follow the forwarded output');
    assert.deepEqual(Buffer.concat(stdout), data);
    assert.equal(Buffer.concat(stderr).toString(), 'remote stderr');
    assert.deepEqual(f.commands, [
      'export CC_DESK_TUNNEL_SHELL=/bin/bash; exec "$CC_DESK_TUNNEL_SHELL" -s',
    ]);
  },
);

test(
  'raw SFTP forwarding preserves file bytes and validates directories on the target',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const { target, client } = await adapterOf(t, f);
    assert.equal(await targetDirectory(target, '/home/dev/project'), '/home/dev/project');
    await assert.rejects(targetDirectory(target, 'C:\\local'), /绝对路径/);
    const sftp = await new Promise((resolve, reject) =>
      client.sftp((error, value) => (error ? reject(error) : resolve(value))),
    );
    const bytes = Buffer.from('目标文件\n'.repeat(10000));
    await new Promise((resolve, reject) =>
      sftp.writeFile('/home/dev/project/file.txt', bytes, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    assert.deepEqual(f.files.get('/home/dev/project/file.txt'), bytes);
    const received = await new Promise((resolve, reject) =>
      sftp.readFile('/home/dev/project/file.txt', (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    assert.deepEqual(received, bytes);
    sftp.end();
  },
);

test(
  'native service actor queries only the test model and executes through existing Tunnel and desktop channels',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    f.controls.earlyExit = true;
    const { adapter } = await adapterOf(t, f);
    const directory = await mkdtemp(join(tmpdir(), 'cc-ssh-tunnel-'));
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    let channels;
    const tunnel = new Tunnel(
      { probe: nativeProbeOnTestHost },
      directory,
      randomUUID(),
      (id) => {
        channels.open(id);
        return true;
      },
      () => assert.fail('unexpected tunnel failure'),
    );
    const offer = await tunnel.start();
    wss.on('connection', (peer) =>
      peer.once('message', (raw) => {
        const attach = JSON.parse(raw.toString());
        assert.ok(tunnel.matches(attach.secret));
        assert.ok(tunnel.attach(attach.channelId, peer));
      }),
    );
    channels = openChannels(
      offer,
      adapter.port,
      async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
        await once(socket, 'open');
        return socket;
      },
      (message) => assert.fail(message),
    );
    t.after(async () => {
      channels.close();
      await tunnel.close();
      for (const peer of wss.clients) peer.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    const client = new ssh2.Client();
    client.on('error', () => {});
    t.after(() => client.destroy());
    const ready = once(client, 'ready');
    client.connect({
      host: '127.0.0.1',
      port: tunnel.port,
      username: 'device',
      privateKey: adapter.credentials.privateKey,
    });
    await ready;
    const stream = await new Promise((resolve, reject) =>
      client.exec('target-command', (error, value) => (error ? reject(error) : resolve(value))),
    );
    let output = '';
    stream.on('data', (chunk) => (output += chunk));
    stream.stderr.resume();
    const finished = once(stream, 'close');
    stream.end('through existing tunnel');
    assert.equal((await finished)[0], 7);
    assert.equal(output, 'through existing tunnel');
    assert.equal(f.commands.at(-1), 'export CC_DESK_TUNNEL_SHELL=/bin/bash; target-command');

    await tunnel.accept({ ...adapter.credentials, connectionId: tunnel.id }, 'linux');
    t.diagnostic('native SSH probe passed');
    const requests = [];
    const script = 'controlled-model-target-script\n';
    const model = createHttpServer((request, response) => {
      const parts = [];
      request.on('data', (chunk) => parts.push(chunk));
      request.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(parts).toString()));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ script }));
      });
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    t.after(() => new Promise((resolve) => model.close(resolve)));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(?:ANTHROPIC|CLAUDE|OPENAI|DEEPSEEK)/i.test(name) && !name.endsWith('_POSIX_FD_STATE'),
      ),
    );
    let actorPid;
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          fileURLToPath(new URL('./fixtures/ssh-native-roundtrip.mjs', import.meta.url)),
          directory,
          `http://127.0.0.1:${model.address().port}`,
          tunnel.ssh.configPath,
        ],
        { timeout: 15000, windowsHide: true, env: environment },
        (error, output) => {
          if (error) reject(error);
          else resolve(output);
        },
      );
      actorPid = child.pid;
    });
    assert.match(stdout, /PASS: simulated Ubuntu/);
    assert.deepEqual(requests, [{ pid: actorPid, text: 'Run controlled target task' }]);
    assert.notEqual(
      actorPid,
      process.pid,
      'desktop/target test process did not send the model request',
    );
    assert.equal(
      f.commands.at(-1),
      'export CC_DESK_TUNNEL_SHELL=/bin/bash; exec "$CC_DESK_TUNNEL_SHELL" -s',
    );
  },
);

test(
  'target manager registers Linux SSH devices and creates isolated projects through the existing server',
  { timeout: 30000 },
  async (t) => {
    const targetA = await fixture(t);
    const targetB = await fixture(t);
    const directory = await mkdtemp(join(tmpdir(), 'cc-ssh-service-'));
    const token = `test-only-${randomUUID()}`;
    const server = createProxyServer({
      token,
      dataDir: directory,
      claude: { executable: process.execPath },
      tunnel: { probe: nativeProbeOnTestHost },
      tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
    });
    const address = await server.listen(0);
    let saved = [];
    const manager = createSshTargets({
      read: () => saved,
      write: (entries) => (saved = entries),
      confirmHost: async () => true,
    });
    t.after(async () => {
      await manager.setService(null);
      await server.close();
      await rm(directory, { recursive: true, force: true });
    });
    await manager.setService({
      config: {
        url: address.replace('https:', 'wss:') + '/ws',
        fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
      },
      binaries: {},
      credentials: async () => ({ token }),
    });
    const a = manager.save({ ...targetA.config, name: 'target A' });
    const b = manager.save({ ...targetB.config, name: 'target B' });
    await manager.connect(a, 'test-password');
    await manager.connect(b, 'test-password');
    assert.equal(manager.list().find((entry) => entry.id === a).status, 'connected');
    const first = await manager.createSession(a, '/home/dev/project');
    const second = await manager.createSession(b, '/home/dev/project');
    assert.equal(server.store.get(first).session.device.id, a);
    assert.equal(server.store.get(second).session.device.id, b);
    assert.equal(server.store.get(first).session.device.platform, 'linux');
    assert.equal(server.store.get(first).session.device.viaSsh, true);
    assert.notEqual(
      server.store.get(first).session.nativeRoot,
      server.store.get(second).session.nativeRoot,
    );
    assert.deepEqual(saved.find((entry) => entry.id === a).projects, ['/home/dev/project']);
    assert.ok(!JSON.stringify(saved).includes('test-password'));
    assert.ok(!JSON.stringify(saved).includes(token));
    assert.ok(targetA.commands.some((command) => command.includes('CC_DESK_TUNNEL_SHELL')));
    const resumed = await manager.openProject(a, '/home/dev/project');
    assert.deepEqual(resumed, { sessionId: first, created: false });
    assert.equal(
      server.store.list().length,
      2,
      'continuing a project does not create another session',
    );
    const directoryList = await manager.directories(a);
    assert.deepEqual(directoryList, {
      path: '/home/dev',
      parent: '/home',
      directories: [{ name: 'project', path: '/home/dev/project' }],
    });
    const separate = await manager.openProject(a, '/home/dev/project', true);
    assert.equal(separate.created, true);
    assert.notEqual(separate.sessionId, first);
    assert.equal((await manager.openProject(a, '/home/dev/project')).sessionId, separate.sessionId);
    server.store.rename(first, 'Most recently used session');
    await manager.disconnect(a);
    await manager.connect(a, 'test-password');
    assert.equal(
      (await manager.openProject(a, '/home/dev/project')).sessionId,
      first,
      'newer server activity takes precedence over an older valid local hint',
    );
    server.store.delete(first);
    await manager.disconnect(a);
    await manager.connect(a, 'test-password');
    assert.deepEqual(
      await manager.openProject(a, '/home/dev/project'),
      { sessionId: separate.sessionId, created: false },
      'a saved hint cannot restore a deleted session after reconnect',
    );
    assert.notEqual(
      (await manager.openProject(a, '/home/dev/project')).sessionId,
      second,
      'same path on another target is not reused',
    );
    await manager.disconnect(a);
    assert.equal(manager.list().find((entry) => entry.id === b).status, 'connected');
    await assert.rejects(manager.createSession(a, '/home/dev/project'), /尚未就绪/);
    const logins = targetB.controls.logins;
    const reconnecting = manager.connect(b, 'test-password');
    await manager.setService(null);
    await assert.rejects(reconnecting);
    assert.equal(
      targetB.controls.logins,
      logins,
      'logging out during cleanup must not start another SSH login',
    );
    assert.equal(manager.list().find((entry) => entry.id === b).status, 'disconnected');
  },
);

test(
  'connection diagnostics identify the failed stage without leaking credentials or reviving removed connections',
  { timeout: 30000 },
  async (t) => {
    const target = await fixture(t);
    let saved = [];
    const changes = [];
    const logs = [];
    const manager = createSshTargets({
      read: () => saved,
      write: (entries) => (saved = entries),
      changed: (entries) => changes.push(entries),
      confirmHost: async () => true,
      log: (text) => logs.push(text),
    });
    t.after(() => manager.setService(null));
    const context = {
      config: { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
      binaries: {},
      credentials: async () => {
        throw new Error('secret-token-must-not-be-shown');
      },
    };
    await manager.setService(context);
    const id = manager.save({ ...target.config, name: 'diagnostic target' });
    await assert.rejects(manager.connect(id, 'wrong-password'), /SSH 登录失败/);
    assert.equal(manager.list()[0].stage, 'ssh');
    assert.equal(manager.list()[0].errorCode, 'AUTH_FAILED');
    target.controls.capabilities = false;
    await assert.rejects(manager.connect(id, 'test-password'), /目标环境检查失败/);
    assert.equal(manager.list()[0].stage, 'capabilities');
    target.controls.capabilities = true;
    target.controls.sftp = false;
    await assert.rejects(manager.connect(id, 'test-password'), /SFTP 检查失败/);
    target.controls.sftp = true;
    await assert.rejects(manager.connect(id, 'test-password'), /Ubuntu 工作空间认证失败/);
    assert.equal(manager.list()[0].stage, 'authorization');
    assert.ok(!JSON.stringify(changes).includes('secret-token-must-not-be-shown'));
    assert.ok(!logs.join('\n').includes('test-password'));
    await manager.remove(id);
    await manager.setService(null);
    assert.deepEqual(manager.list(), []);
  },
);

test(
  'target loss during bridge startup closes a listener returned after failure',
  { timeout: 15000 },
  async (t) => {
    const target = await fixture(t);
    let saved = [];
    let failed;
    const failureObserved = new Promise((resolve) => (failed = resolve));
    const manager = createSshTargets({
      read: () => saved,
      write: (value) => (saved = value),
      confirmHost: async () => true,
      changed: (entries) => {
        if (entries.some((entry) => entry.status === 'failed')) failed();
      },
    });
    await manager.setService({
      config: { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
      binaries: {},
      credentials: async () => ({ token: `test-only-${randomUUID()}` }),
    });
    const id = manager.save({ ...target.config, name: 'late bridge' });
    const originalListen = NetServer.prototype.listen;
    let release;
    let captured;
    const listening = new Promise((resolve) => {
      t.mock.method(NetServer.prototype, 'listen', function (...args) {
        const callback = args.at(-1);
        if (!captured && typeof callback === 'function') {
          captured = this;
          args[args.length - 1] = function (...values) {
            release = () => callback.apply(this, values);
            resolve();
          };
        }
        return originalListen.apply(this, args);
      });
    });
    t.after(async () => {
      release?.();
      await manager.setService(null);
      if (captured?.listening) await new Promise((resolve) => captured.close(resolve));
    });
    const connecting = manager.connect(id, 'test-password');
    const rejected = assert.rejects(connecting);
    await listening;
    target.drop();
    await failureObserved;
    // Let closeRun finish before the intentionally delayed factory returns.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await rejected;
    assert.equal(
      captured.listening,
      false,
      'late bridge must not leave a loopback listener behind',
    );
  },
);
