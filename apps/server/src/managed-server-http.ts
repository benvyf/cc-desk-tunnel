import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  strictObject,
  requireValue,
  type ServerRelease,
  type SignedServerIndex,
} from '../../../packages/managed-server/src/index.ts';
import { Throttle } from './throttle.ts';

export type CurrentProgram = {
  build: number;
  protocol: number;
  appVersion: string;
  sha256: string | null;
};
export type ServerCheck = {
  schema: 1;
  current: CurrentProgram;
  candidate: ServerRelease | null;
  index: SignedServerIndex | null;
  compatible: boolean;
  reason:
    'available' | 'current' | 'protocol-unavailable' | 'manual-image-upgrade' | 'disabled' | 'busy';
};
export type Phase =
  | 'idle'
  | 'staging'
  | 'stopping'
  | 'backup'
  | 'switching'
  | 'probing'
  | 'committed'
  | 'rolled-back'
  | 'failed';
export type ServerStatus = {
  schema: 1;
  phase: Phase;
  current: CurrentProgram;
  target: ServerRelease | null;
  error?: string;
  hostMaintenance?: boolean;
  retryable?: boolean;
  serving?: boolean;
  hostDiagnostics?: {
    schema: 1;
    idle: boolean;
    serving: boolean;
    ready: boolean;
    base: { build: number; descriptorSha256: string };
    program: { build: number; protocol: number; sha256: string | null; descriptorSha256: string };
    activity: {
      tasks: number;
      terminals: number;
      reviews: number;
      pending: number;
      registering: number;
      connections: number;
    };
  };
};
export type InstallConfirmation = {
  clientProtocol: number;
  confirmed: true;
  build: number;
  sha256: string;
};
export type ManagedBackend = {
  check(protocol: number): Promise<ServerCheck>;
  status(): Promise<ServerStatus>;
  prepare(request: InstallConfirmation, operationId?: string): Promise<void>;
  activate(operationId?: string): void;
  cancelPrepared?(operationId: string): Promise<void> | void;
};
export type MaintenanceAdmission = {
  enter(disconnectClients?: boolean): boolean;
  recoverRelay?(): boolean;
  leave(): void;
  busy?(): boolean;
  serving?(): boolean;
  activity?(): NonNullable<ServerStatus['hostDiagnostics']>['activity'];
};
const PREFIX = '/cc-managed/server/v1/';
export function managedServerHandler(options: {
  token: string;
  backend: ManagedBackend;
  admission: MaintenanceAdmission;
  address?: (request: IncomingMessage) => string;
  readiness?: () => unknown;
  nonce?: string;
  authorizeDesktopTicket?: (ticket: string) => Promise<unknown>;
  onCancel?: (callback: (operationId: string) => void) => void;
}) {
  requireValue(options.token.length >= 24, 'Managed API requires existing strong service token');
  const expected = createHash('sha256').update(options.token).digest();
  const throttle = new Throttle();
  let relayLease: { id: string; expires: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let install: { id: string; gated: boolean } | undefined;
  const releaseInstall = (operationId: string) => {
    if (install?.id !== operationId) return;
    if (install.gated) options.admission.leave();
    install = undefined;
  };
  options.onCancel?.(releaseInstall);
  function releaseRelay() {
    if (!relayLease) return;
    clearTimeout(relayLease.timer);
    relayLease = undefined;
    options.admission.leave();
  }
  return (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url?.startsWith(PREFIX)) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    const reply = (status: number, value?: unknown) => {
      response.writeHead(status);
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (request.headers.origin !== undefined) {
      reply(403);
      return true;
    }
    const address = options.address?.(request) ?? request.socket.remoteAddress ?? 'unknown';
    if (throttle.blocked(address)) {
      response.setHeader('Retry-After', throttle.blocked(address));
      reply(429);
      return true;
    }
    const provided = request.headers.authorization ?? '';
    if (!throttle.enter(address)) {
      reply(429);
      return true;
    }
    const route = request.url.slice(PREFIX.length);
    const run = async () => {
      const serviceAuthorized =
        provided.startsWith('Bearer ') &&
        timingSafeEqual(expected, createHash('sha256').update(provided.slice(7)).digest());
      let authorized = serviceAuthorized;
      if (
        !authorized &&
        options.authorizeDesktopTicket &&
        /^Bearer ccs_[A-Za-z0-9_-]{43}$/.test(provided)
      ) {
        try {
          await options.authorizeDesktopTicket(provided.slice(7));
          authorized = true;
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 401 && status !== 403) {
            // A validation outage is retryable and must not count as a bad login.
            reply(503, { error: 'authorization-unavailable' });
            return;
          }
          // Revoked, expired and wrong-node tickets cannot authorize maintenance.
        }
      }
      if (!authorized) {
        throttle.fail(address);
        reply(401);
        return;
      }
      throttle.succeed(address);
      if (route === 'host-install' && !serviceAuthorized) {
        reply(403);
        return;
      }
      if (relayLease && relayLease.expires <= Date.now()) releaseRelay();
      if (route === 'relay-enter' || route === 'relay-leave') {
        if (
          request.method !== 'POST' ||
          !serviceAuthorized ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
        ) {
          reply(403);
          return;
        }
        if (route === 'relay-leave') {
          if (!relayLease || request.headers['x-cc-relay-lease'] !== relayLease.id) {
            reply(409, { error: 'relay-lease-mismatch' });
            return;
          }
          releaseRelay();
          reply(200, { released: true });
          return;
        }
        // Synchronous admission checks all tasks/terminals and closes reconnect admission
        // before disconnecting idle clients. A lost agent cannot leave maintenance forever.
        const recovery = request.headers['x-cc-relay-recovery'] === 'disconnected';
        if (
          relayLease ||
          install ||
          !(recovery ? options.admission.recoverRelay?.() : options.admission.enter(true))
        ) {
          reply(409, { error: 'busy' });
          return;
        }
        const timer = setTimeout(releaseRelay, 120000);
        timer.unref();
        relayLease = { id: randomUUID(), expires: Date.now() + 120000, timer };
        reply(200, { lease: relayLease.id, expires: relayLease.expires });
        return;
      }
      if (relayLease && request.method === 'POST' && ['install', 'host-install'].includes(route)) {
        reply(409, { error: 'relay-maintenance' });
        return;
      }

      if (request.method === 'GET' && route === 'status') {
        const status = await options.backend.status();
        if (
          status.hostDiagnostics &&
          options.admission.activity &&
          options.admission.serving &&
          options.admission.busy
        ) {
          const serving = options.admission.serving() && status.hostDiagnostics.ready;
          const idle = serving && !options.admission.busy();
          status.hostDiagnostics = {
            ...status.hostDiagnostics,
            serving,
            idle,
            activity: options.admission.activity(),
          };
          status.serving = serving;
          status.hostMaintenance = true;
          status.retryable = status.retryable === true && serving;
        }
        reply(200, status);
        return;
      }
      if (request.method === 'GET' && route === 'ready' && options.readiness && options.nonce) {
        if (
          request.headers['x-cc-launch-nonce'] !== options.nonce ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
        ) {
          reply(403);
          return;
        }
        reply(200, options.readiness());
        return;
      }
      if (request.method !== 'POST' || !['check', 'install', 'host-install'].includes(route)) {
        reply(404);
        return;
      }
      if (request.headers['content-type'] !== 'application/json') {
        reply(400);
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => request.destroy(), 10000);
      timer.unref();
      let input: Record<string, unknown>;
      try {
        for await (const chunk of request) {
          bytes += chunk.length;
          requireValue(bytes <= 4096, 'Body too large');
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        input = strictObject(
          body,
          route === 'check'
            ? ['clientProtocol']
            : ['clientProtocol', 'confirmed', 'build', 'sha256'],
        );
        requireValue(
          Number.isSafeInteger(input.clientProtocol) && (input.clientProtocol as number) > 0,
          'Invalid client protocol',
        );
        if (route !== 'check')
          requireValue(
            input.confirmed === true &&
              Number.isSafeInteger(input.build) &&
              (input.build as number) > 0 &&
              typeof input.sha256 === 'string' &&
              /^[a-f0-9]{64}$/.test(input.sha256),
            'Exact confirmation required',
          );
      } catch {
        reply(400);
        return;
      } finally {
        clearTimeout(timer);
      }
      if (route === 'check') {
        reply(200, await options.backend.check(input.clientProtocol as number));
        return;
      }
      // The typed management reservation spans asynchronous staging and handoff.
      if (install || relayLease) {
        reply(409, { error: 'busy' });
        return;
      }
      const operationId = randomUUID();
      install = { id: operationId, gated: false };
      const host = route === 'host-install';
      // Normal installs retain their enter-before-prepare contract.
      if (!host) {
        if (!options.admission.enter()) {
          releaseInstall(operationId);
          reply(409, { error: 'busy' });
          return;
        }
        install.gated = true;
      }
      let cancellationAttempted = false;
      const cancelAndRelease = async () => {
        cancellationAttempted = true;
        try {
          await options.backend.cancelPrepared?.(operationId);
        } finally {
          releaseInstall(operationId);
        }
      };
      try {
        await options.backend.prepare(input as InstallConfirmation, operationId);
        if (install?.id !== operationId) throw new Error('Preparation canceled');
        // Host staging leaves business open. Only this synchronous final gate may
        // disconnect idle clients, after every actual activity collection is checked.
        if (host) {
          if (!options.admission.enter(true)) {
            await cancelAndRelease();
            reply(409, { error: 'busy' });
            return;
          }
          install.gated = true;
        }
        let activated = false;
        const activate = () => {
          if (!activated) {
            activated = true;
            options.backend.activate(operationId);
          }
        };
        response.once('finish', activate);
        response.once('close', activate);
        if (response.destroyed) activate();
        reply(202, { accepted: true, build: input.build, sha256: input.sha256 });
      } catch (error) {
        if (cancellationAttempted) throw error;
        await cancelAndRelease();
        reply(409, { error: 'release-not-installable' });
      }
    };
    void run()
      .catch(() => {
        if (!response.headersSent) reply(503, { error: 'management-unavailable' });
        else response.destroy();
      })
      .finally(() => throttle.leave(address));
    return true;
  };
}
