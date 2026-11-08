import { randomBytes } from 'node:crypto';
import type { ManagedBackend, ServerCheck, ServerStatus } from './managed-server-http.ts';
import type { ReadyProof } from './managed-server-supervisor.ts';
import { MANAGEMENT_IPC_TIMEOUT_MS } from './managed-server-supervisor.ts';

export function connectManagedSupervisor(nonce: string): {
  backend: ManagedBackend;
  ready(proof: ReadyProof): void;
  onCommit(callback: () => void): void;
  onStop(callback: () => void): void;
  onCancel(callback: () => void): void;
} {
  if (!process.send || !process.connected || !/^[a-f0-9]{64}$/.test(nonce))
    throw new Error('Missing private supervisor IPC');
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(reason: unknown): void; timer: NodeJS.Timeout }
  >();
  let commit = () => {},
    stop = () => {},
    cancel = () => {};
  process.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (message.kind === 'cc-managed-response' && typeof message.id === 'string') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok === true) request.resolve(message.value);
      else request.reject(new Error('Supervisor rejected request'));
    } else if (message.nonce === nonce && message.kind === 'cc-managed-commit') commit();
    else if (message.nonce === nonce && message.kind === 'cc-managed-stop') stop();
    else if (message.nonce === nonce && message.kind === 'cc-managed-cancel') cancel();
  });
  process.on('disconnect', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Supervisor disconnected'));
    }
    pending.clear();
    stop();
  });
  const call = (method: string, input: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (pending.size >= 4) {
        reject(new Error('Management busy'));
        return;
      }
      const id = randomBytes(16).toString('hex'),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Supervisor timeout'));
        }, MANAGEMENT_IPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      process.send!(
        { kind: 'cc-managed-request', id, method, input },
        undefined,
        undefined,
        (error: Error | null) => {
          if (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        },
      );
    });
  return {
    backend: {
      check: async (protocol) => (await call('check', protocol)) as ServerCheck,
      status: async () => (await call('status', null)) as ServerStatus,
      prepare: async (input) => {
        await call('prepare', input);
      },
      activate: () => {
        void call('activate', null).catch(() => {});
      },
    },
    ready: (proof) => process.send!({ kind: 'cc-managed-ready', proof }),
    onCommit: (callback) => {
      commit = callback;
    },
    onStop: (callback) => {
      stop = callback;
    },
    onCancel: (callback) => {
      cancel = callback;
    },
  };
}
