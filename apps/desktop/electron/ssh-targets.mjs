import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import {
  connectSshTarget,
  startTargetAdapter,
  targetDirectory,
  targetDirectories,
  targetExec,
} from './ssh-target-adapter.mjs';
import { openProxyBridge } from './proxy-bridge.mjs';

const field = (value, name, maximum = 256) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\0\r\n]/.test(value)
  )
    throw new Error(`请填写有效的${name}。`);
  return value.trim();
};

const stages = {
  ssh: 'SSH 登录',
  capabilities: '目标环境检查',
  sftp: 'SFTP 检查',
  authorization: 'Ubuntu 工作空间认证',
  tunnel: '开发通道连接',
  ready: '开发通道已就绪',
};
const serviceIdentity = (config) =>
  JSON.stringify([
    config.nodeId ?? null,
    new URL(config.url).href,
    (config.fingerprint ?? '').replaceAll(':', '').toLowerCase(),
  ]);
function diagnosis(stage, error) {
  const reasons = {
    HOST_KEY_CHANGED: '主机指纹已变化，请核实后添加新的连接。',
    HOST_NOT_TRUSTED: '未信任该 SSH 主机。',
    ENOENT: '身份文件不存在，请重新选择。',
    EACCES: '无法读取身份文件，请检查文件权限。',
    ENOTFOUND: '无法解析主机名，请核对地址。',
    ECONNREFUSED: '目标拒绝连接，请检查 SSH 服务和端口。',
    ETIMEDOUT: '连接超时，请检查目标网络。',
    AUTH_FAILED: '身份验证失败，请检查用户名、密码或私钥口令。',
  };
  const code =
    error?.level === 'client-authentication' || /Cannot parse privateKey/.test(error?.message ?? '')
      ? 'AUTH_FAILED'
      : Object.hasOwn(reasons, error?.code)
        ? error.code
        : 'CONNECTION_FAILED';
  const tips = {
    ssh: '请核对主机、端口和身份验证信息。',
    capabilities:
      '目标需要 Linux、/bin/bash、setsid --wait、mkfifo 和 timeout，请检查目标的非交互 SSH 环境。',
    sftp: '请检查目标是否启用 SFTP，以及当前用户的访问权限。',
    authorization: '请重新登录并连接此配置所属的 Ubuntu 工作空间。',
    tunnel: '请检查 Ubuntu 服务的网络、证书和协议版本是否与客户端匹配。',
    ready: '连接已中断，请核实在途命令状态，避免重复执行。',
  };
  return {
    code,
    message: `${stage === 'ready' ? '连接中断' : `${stages[stage] ?? '连接'}失败`}：${reasons[code] ?? tips[stage]}`,
  };
}

// One owner per desktop service profile. SSH secrets live only in connect()'s
// opening call; persistent entries contain configuration, trust and project paths.
export function createSshTargets({
  read,
  write,
  confirmHost,
  changed,
  log = () => {},
  retryMs = 1000,
}) {
  let service = null;
  let generation = 0;
  const active = new Map();
  // Connection intent and authentication material live only for this signed-in
  // process. They never enter list(), persisted settings, logs or the renderer.
  const wanted = new Map();
  const attempts = new Map();
  const entries = () => read() ?? [];
  const scope = () => service?.config.nodeId ?? service?.config.url;
  const emit = () => changed?.(list());
  const entryOf = (id) => {
    const entry = entries().find((item) => item.id === id);
    if (!entry) throw new Error('SSH 连接不存在。');
    return entry;
  };
  function list() {
    return entries().map((entry) => ({
      ...entry,
      available: !!service && entry.scope === scope(),
      status: active.get(entry.id)?.status ?? 'disconnected',
      error: active.get(entry.id)?.error ?? '',
      stage: active.get(entry.id)?.stage,
      errorCode: active.get(entry.id)?.errorCode,
    }));
  }
  function persist(entry) {
    write(entries().map((item) => (item.id === entry.id ? entry : item)));
    emit();
  }
  function closeRun(run, intentional = true) {
    run.closing ??= (async () => {
      run.controller.abort();
      for (const pending of run.pending.values()) pending.reject(new Error('SSH 开发通道已断开。'));
      run.pending.clear();
      run.socket?.close();
      try {
        await run.bridge?.close(false, intentional);
      } finally {
        run.target?.destroy();
        run.target = undefined;
        run.socket = undefined;
        run.bridge = undefined;
        run.sessions.clear();
      }
    })();
    return run.closing;
  }
  async function disconnect(id, preserveAttempt = false) {
    if (!preserveAttempt) attempts.set(id, (attempts.get(id) ?? 0) + 1);
    const intent = wanted.get(id);
    wanted.delete(id);
    if (intent) {
      clearTimeout(intent.timer);
      intent.secret = '';
    }
    const run = active.get(id);
    if (!run) return;
    active.delete(id);
    await closeRun(run);
    emit();
  }
  function failure(id, run, error) {
    if (active.get(id) !== run || run.controller.signal.aborted) return;
    const intent = wanted.get(id);
    const retryable =
      error.retryable ??
      (!['HOST_KEY_CHANGED', 'HOST_NOT_TRUSTED', 'ENOENT', 'EACCES'].includes(error.code) &&
        error.level !== 'client-authentication' &&
        !/Cannot parse privateKey/.test(error.message ?? '') &&
        ['ssh', 'tunnel', 'ready'].includes(run.stage));
    const retry = !!intent?.established && retryable;
    const diagnostic = diagnosis(run.stage, error);
    run.status = retry ? 'connecting' : 'failed';
    run.error = diagnostic.message;
    run.errorCode = diagnostic.code;
    log(`SSH target ${id}: ${run.stage}: ${diagnostic.code}`);
    emit();
    if (!retry && intent) {
      wanted.delete(id);
      intent.secret = '';
    }
    void closeRun(run, false)
      .then(() => {
        if (!retry || wanted.get(id) !== intent || !service || generation !== intent.generation)
          return;
        intent.timer = setTimeout(
          () => {
            intent.timer = undefined;
            if (wanted.get(id) !== intent || !service) return;
            void connect(id, intent.secret, true).catch(() => {});
          },
          Math.min(retryMs * 2 ** Math.min(intent.failures++, 4), 10000),
        );
        intent.timer.unref?.();
      })
      .catch(() => {
        log(`SSH target ${id}: cleanup_failed`);
        if (intent && wanted.get(id) === intent) {
          wanted.delete(id);
          intent.secret = '';
          run.status = 'failed';
          emit();
        }
      });
  }
  async function setService(value) {
    if (value && service && serviceIdentity(value.config) === serviceIdentity(service.config)) {
      service = value;
      emit();
      return;
    }
    const turn = ++generation;
    service = null;
    await Promise.all(
      [...new Set([...active.keys(), ...wanted.keys()])].map((id) => disconnect(id)),
    );
    if (turn !== generation) return;
    service = value;
    emit();
  }
  function save(input) {
    if (input?.id) {
      const entry = entryOf(input.id);
      const name = field(input.name, '显示名称', 120);
      const run = active.get(entry.id);
      if (run?.status === 'connected') {
        const rename = async () => {
          await request(run, { type: 'device.rename', name });
          persist({ ...entryOf(entry.id), name });
          return entry.id;
        };
        run.renaming = (run.renaming ?? Promise.resolve()).then(rename, rename);
        return run.renaming;
      }
      persist({ ...entry, name });
      return input.id;
    }
    if (!service) throw new Error('请先连接 Ubuntu 工作空间，再添加 SSH 设备。');
    const host = field(input?.host, '主机名');
    if (/[\s/@]/.test(host)) throw new Error('主机名只填写域名或 IP，用户名请单独填写。');
    const username = field(input?.username, '用户名');
    const port = input.port === '' || input.port == null ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('SSH 端口应为 1–65535。');
    if (!['key', 'password'].includes(input.auth)) throw new Error('请选择身份验证方式。');
    const entry = {
      id: randomUUID(),
      scope: scope(),
      name: input.name?.trim() ? field(input.name, '显示名称', 120) : `${username}@${host}`,
      host,
      port,
      username,
      auth: input.auth,
      ...(input.auth === 'key'
        ? { identityFile: field(input.identityFile, '身份文件路径', 2048) }
        : {}),
      projects: [],
    };
    write([...entries(), entry]);
    emit();
    return entry.id;
  }
  async function connect(id, secret = '', recovering = false) {
    const entry = entryOf(id);
    const context = service;
    const turn = generation;
    if (!context || entry.scope !== scope())
      throw new Error('请连接此 SSH 配置所属的 Ubuntu 工作空间。');
    if (typeof secret !== 'string' || secret.length > 16384) throw new Error('SSH 登录信息无效。');
    let intent = recovering ? wanted.get(id) : null;
    const attempt = recovering ? intent?.attempt : (attempts.get(id) ?? 0) + 1;
    if (!recovering) attempts.set(id, attempt);
    if (recovering) {
      if (!intent) throw new Error('连接已取消。');
      const previous = active.get(id);
      active.delete(id);
      if (previous) await closeRun(previous, false);
    } else await disconnect(id, true);
    if (
      !service ||
      serviceIdentity(service.config) !== serviceIdentity(context.config) ||
      generation !== turn ||
      attempts.get(id) !== attempt
    )
      throw new Error('连接已取消。');
    if (!recovering) {
      intent = {
        secret,
        established: false,
        failures: 0,
        generation: turn,
        attempt,
        timer: undefined,
      };
      wanted.set(id, intent);
    }
    if (wanted.get(id) !== intent) throw new Error('连接已取消。');
    const run = {
      status: 'connecting',
      error: '',
      controller: new AbortController(),
      pending: new Map(),
      sessions: new Map(),
      stage: 'ssh',
    };
    active.set(id, run);
    emit();
    try {
      const current = () => {
        if (
          !service ||
          serviceIdentity(service.config) !== serviceIdentity(context.config) ||
          generation !== turn ||
          attempts.get(id) !== attempt ||
          active.get(id) !== run ||
          run.controller.signal.aborted
        )
          throw new Error('连接已取消。');
      };
      const config = { ...entry };
      const stage = (value) => {
        run.stage = value;
        emit();
      };
      run.target = await connectSshTarget(
        config,
        secret,
        (fingerprint) => confirmHost(entry, fingerprint),
        run.controller.signal,
      );
      current();
      if (config.fingerprint !== entry.fingerprint)
        persist({ ...entryOf(id), fingerprint: config.fingerprint });
      run.target.once('close', () =>
        failure(
          id,
          run,
          Object.assign(new Error('目标 SSH 已断开，在途命令结果可能未知。'), { retryable: true }),
        ),
      );
      stage('capabilities');
      await targetExec(
        run.target,
        'test "$(uname -s)" = Linux && test -x /bin/bash && command -v mkfifo >/dev/null && command -v timeout >/dev/null && setsid --wait /bin/bash -c :',
      );
      // Probe SFTP without requiring an initial project path.
      stage('sftp');
      await targetDirectory(run.target, '/');
      current();
      run.status = 'ssh-connected';
      stage('authorization');
      const credentials = await service.credentials();
      current();
      stage('tunnel');
      const candidate = join(context.binaries.openssh ?? '', 'ssh-keygen.exe');
      run.bridge = await openProxyBridge(
        context.config,
        {
          ...context.binaries,
          onAuth: undefined,
          device: { id, platform: 'linux', viaSsh: true },
          startSsh: (connectionId, _options, signal, fail) =>
            startTargetAdapter(
              connectionId,
              run.target,
              { keygen: existsSync(candidate) ? candidate : 'ssh-keygen' },
              signal,
              fail,
            ),
        },
        () => failure(id, run, new Error('Ubuntu 开发通道已断开。')),
      );
      current();
      const socket = new WebSocket(run.bridge.url);
      run.socket = socket;
      await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => reject(new Error('Ubuntu 开发通道连接超时。')), 60000);
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          run.controller.signal.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const aborted = () => finish(new Error('连接已取消。'));
        run.controller.signal.addEventListener('abort', aborted, { once: true });
        socket.once('open', () => {
          socket.send(
            JSON.stringify({
              type: 'auth',
              protocolVersion: PROTOCOL_VERSION,
              token: credentials.token,
              deviceName: entry.name,
            }),
          );
          socket.send(JSON.stringify({ type: 'device', id }));
        });
        socket.on('message', (raw) => {
          let parsed;
          try {
            parsed = serverMessageSchema.safeParse(JSON.parse(raw.toString()));
          } catch {
            parsed = { success: false };
          }
          if (!parsed.success) return finish(new Error('Ubuntu 返回了不兼容的消息。'));
          const message = parsed.data;
          if (message.type === 'ready') {
            for (const session of message.sessions)
              if (session.device?.id === id) run.sessions.set(session.id, session);
            run.status = 'connected';
            intent.established = true;
            intent.failures = 0;
            stage('ready');
            finish();
          } else if (message.type === 'session.updated') {
            if (message.session.device?.id === id)
              run.sessions.set(message.session.id, message.session);
            else run.sessions.delete(message.session.id);
          } else if (message.type === 'session.deleted') {
            run.sessions.delete(message.sessionId);
          } else if (message.type === 'connection.error') {
            const error = new Error(message.message);
            error.retryable = ['connection_lost', 'tunnel_failed', 'ssh_failed'].includes(
              message.code,
            );
            finish(error);
            failure(id, run, error);
          } else if (message.type === 'response') {
            const pending = run.pending.get(message.requestId);
            if (!pending) return;
            run.pending.delete(message.requestId);
            message.ok
              ? pending.resolve(message)
              : pending.reject(new Error(message.message ?? '远程会话创建失败。'));
          }
        });
        socket.on('error', () => finish(new Error('Ubuntu 开发通道无法连接。')));
        socket.once('close', () => {
          finish(new Error('Ubuntu 开发通道已关闭。'));
          failure(id, run, new Error('Ubuntu 开发通道已关闭。'));
        });
      });
      current();
      const latestName = entryOf(id).name;
      if (latestName !== entry.name)
        await request(run, { type: 'device.rename', name: latestName });
      current();
    } catch (error) {
      failure(id, run, error);
      await closeRun(run);
      // A factory can finish after closeRun has already cleaned an earlier stage.
      // Dispose these late results too, even if the failed row is still displayed.
      await run.bridge?.close();
      run.target?.destroy();
      run.bridge = undefined;
      run.target = undefined;
      throw new Error(run.error || '连接已取消。');
    }
  }
  function readyRun(id) {
    const entry = entryOf(id);
    const run = active.get(id);
    if (!service || entry.scope !== scope() || run?.status !== 'connected')
      throw new Error('SSH 开发通道尚未就绪。');
    return run;
  }
  function rememberProject(id, path, sessionId) {
    const latest = entryOf(id);
    persist({
      ...latest,
      projects: [path, ...latest.projects.filter((value) => value !== path)],
      lastSessionId: sessionId,
    });
  }
  async function createSession(id, path) {
    const run = readyRun(id);
    const projectPath = await targetDirectory(run.target, path);
    if (active.get(id) !== run || run.socket.readyState !== WebSocket.OPEN)
      throw new Error('SSH 开发通道已断开。');
    const response = await request(run, { type: 'session.create', title: '新会话', projectPath });
    if (!response.sessionId) throw new Error('服务端未返回会话标识。');
    rememberProject(id, projectPath, response.sessionId);
    return response.sessionId;
  }
  function request(run, command) {
    if (run.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('SSH 开发通道已断开。'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        run.pending.delete(requestId);
        reject(new Error('操作响应超时，请先检查当前状态，避免重复操作。'));
      }, 20000);
      run.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      run.socket.send(JSON.stringify({ ...command, requestId }));
    });
  }
  return {
    list,
    save,
    connect,
    disconnect,
    createSession,
    setService,
    async prepareService(config) {
      if (service && serviceIdentity(config) !== serviceIdentity(service.config))
        await setService(null);
    },
    async openProject(id, path, forceNew = false) {
      const run = readyRun(id);
      const canonical = await targetDirectory(run.target, path);
      if (readyRun(id) !== run) throw new Error('SSH 开发通道已变化，请重试。');
      if (!forceNew) {
        const candidates = [...run.sessions.values()].filter(
          (session) => session.projectPath === canonical,
        );
        const lastSessionId = entryOf(id).lastSessionId;
        const session = candidates.sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            Number(b.id === lastSessionId) - Number(a.id === lastSessionId),
        )[0];
        if (session) {
          rememberProject(id, canonical, session.id);
          return { sessionId: session.id, created: false };
        }
      }
      return { sessionId: await createSession(id, canonical), created: true };
    },
    async directories(id, path) {
      const run = readyRun(id);
      const result = await targetDirectories(run.target, path);
      if (readyRun(id) !== run) throw new Error('SSH 开发通道已变化，请重新浏览。');
      return result;
    },
    async forkSession(id, sessionId, beforeMessageId) {
      const entry = entryOf(id);
      const run = active.get(id);
      if (!service || entry.scope !== scope() || run?.status !== 'connected')
        throw new Error('SSH 开发通道尚未就绪。');
      const response = await request(run, {
        type: 'session.fork',
        sessionId,
        ...(beforeMessageId ? { beforeMessageId } : {}),
      });
      if (!response.sessionId) throw new Error('服务端未返回会话标识。');
      return response.sessionId;
    },
    async remove(id) {
      await disconnect(id);
      write(entries().filter((entry) => entry.id !== id));
      emit();
    },
  };
}
