import { fork } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireValue, strictObject } from '../../../packages/managed-server/src/index.ts';
import type { ManagedBackend } from './managed-server-http.ts';
import type { LaunchOptions, ProgramChild, ReadyProof } from './managed-server-supervisor.ts';

function probe(
  settings: { port: number; tls: boolean; env: NodeJS.ProcessEnv },
  nonce: string,
): Promise<ReadyProof> {
  return new Promise((resolve, reject) => {
    const req = (settings.tls ? httpsRequest : httpRequest)(
      {
        hostname: '127.0.0.1',
        port: settings.port,
        method: 'GET',
        path: '/cc-managed/server/v1/ready',
        rejectUnauthorized: false,
        headers: {
          authorization: `Bearer ${settings.env.PROXY_TOKEN}`,
          'x-cc-launch-nonce': nonce,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) res.destroy(new Error('Oversized readiness'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            requireValue(res.statusCode === 200, 'Readiness denied');
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.once('timeout', () => req.destroy(new Error('Readiness timeout')));
    req.once('error', reject);
    req.end();
  });
}
export async function forkProgram(
  options: LaunchOptions,
  settings: { env: NodeJS.ProcessEnv; cwd: string; port: number; tls: boolean; loader?: string },
  backend: ManagedBackend,
): Promise<ProgramChild> {
  const child = fork(join(options.root, 'apps/server/src/managed-main.ts'), [], {
    cwd: settings.cwd,
    execArgv: settings.loader ? ['--import', pathToFileURL(settings.loader).href] : [],
    detached: process.platform !== 'win32',
    env: {
      ...settings.env,
      CC_MANAGED_SUPERVISED: '1',
      CC_MANAGED_PROGRAM_ROOT: options.root,
      CC_MANAGED_NONCE: options.expected.nonce,
      CC_MANAGED_RELEASE_HASH: options.expected.releaseHash,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let ended = false;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      ended = true;
      resolve();
    });
    child.once('error', () => {
      ended = true;
      resolve();
    });
  });
  let readySeen = false;
  let resolveReady!: (value: ReadyProof) => void, rejectReady!: (reason: unknown) => void;
  const ready = new Promise<ReadyProof>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Attach immediately: a failed fork must not create an unhandled rejection before the supervisor awaits it.
  void ready.catch(() => {});
  child.once('error', rejectReady);
  void exited.then(() => {
    if (!readySeen) rejectReady(new Error('Child exited before readiness'));
  });
  const send = (value: unknown) => {
    if (child.connected) child.send(value as object, () => {});
  };
  let pending = 0;
  child.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Buffer.byteLength(JSON.stringify(raw)) > 8192) return;
    const message = raw as Record<string, unknown>;
    if (message.kind === 'cc-managed-ready' && !readySeen) {
      readySeen = true;
      void probe(settings, options.expected.nonce)
        .then((proof) => {
          requireValue(
            JSON.stringify(proof) === JSON.stringify(message.proof),
            'IPC and local readiness differ',
          );
          resolveReady(proof);
        })
        .catch(rejectReady);
      return;
    }
    if (message.kind !== 'cc-managed-request' || pending >= 4) return;
    let request: Record<string, unknown>;
    try {
      request = strictObject(message, ['kind', 'id', 'method', 'input']);
      requireValue(
        typeof request.id === 'string' && /^[a-f0-9]{32}$/.test(request.id),
        'Invalid request',
      );
    } catch {
      return;
    }
    pending++;
    const handle = async () => {
      switch (request.method) {
        case 'check':
          requireValue(
            Number.isSafeInteger(request.input) && (request.input as number) > 0,
            'Invalid protocol',
          );
          return backend.check(request.input as number);
        case 'status':
          requireValue(request.input === null, 'Invalid status');
          return backend.status();
        case 'prepare': {
          const c = strictObject(request.input, ['clientProtocol', 'confirmed', 'build', 'sha256']);
          requireValue(
            c.confirmed === true &&
              Number.isSafeInteger(c.clientProtocol) &&
              (c.clientProtocol as number) > 0 &&
              Number.isSafeInteger(c.build) &&
              (c.build as number) > 0 &&
              typeof c.sha256 === 'string' &&
              /^[a-f0-9]{64}$/.test(c.sha256),
            'Invalid confirmation',
          );
          return backend.prepare(c as Parameters<ManagedBackend['prepare']>[0]);
        }
        case 'activate':
          requireValue(request.input === null, 'Invalid activation');
          backend.activate();
          return null;
        default:
          throw new Error('Unknown method');
      }
    };
    void handle()
      .then(
        (value) =>
          send({ kind: 'cc-managed-response', id: request.id, ok: true, value: value ?? null }),
        () => send({ kind: 'cc-managed-response', id: request.id, ok: false, value: null }),
      )
      .finally(() => {
        pending--;
      });
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  };
  const groupAlive = () => {
    if (!child.pid || process.platform === 'win32') return !ended;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw e;
    }
  };
  let stopping: Promise<void> | undefined;
  return {
    ready,
    exited,
    commit() {
      send({ kind: 'cc-managed-commit', nonce: options.expected.nonce });
    },
    cancelMaintenance() {
      send({ kind: 'cc-managed-cancel', nonce: options.expected.nonce });
    },
    stop() {
      stopping ??= (async () => {
        send({ kind: 'cc-managed-stop', nonce: options.expected.nonce });
        signalGroup('SIGTERM');
        let deadline = Date.now() + 15000;
        while (groupAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        if (groupAlive()) signalGroup('SIGKILL');
        deadline = Date.now() + 5000;
        while (groupAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        requireValue(!groupAlive(), 'Old process group did not exit');
        await exited;
      })();
      return stopping;
    },
  };
}
