import { createHash, timingSafeEqual } from 'node:crypto';
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
  hostMaintenance?: boolean;
  retryable?: boolean;
  schema: 1;
  phase: Phase;
  current: CurrentProgram;
  target: ServerRelease | null;
  error?: string;
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
  prepare(request: InstallConfirmation): Promise<void>;
  cancel?(): Promise<void>;
  activate(): void;
};
export type MaintenanceAdmission = {
  enter(disconnectClients?: boolean): boolean;
  leave(): void;
  busy?(): boolean;
  serving?(): boolean;
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
}) {
  requireValue(options.token.length >= 24, 'Managed API requires existing strong service token');
  const expected = createHash('sha256').update(options.token).digest();
  const throttle = new Throttle();
  let installPending = false;
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
      const hostInstall = request.method === 'POST' && route === 'host-install';
      if (
        hostInstall &&
        (!serviceAuthorized ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address))
      ) {
        reply(403);
        return;
      }
      if (request.method === 'GET' && route === 'status') {
        const status = await options.backend.status();
        reply(200, {
          ...status,
          ...(serviceAuthorized
            ? {
                hostMaintenance: status.hostMaintenance === true && !!options.backend.cancel,
                serving: options.admission.serving?.() === true,
              }
            : {}),
        });
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
      if (installPending) {
        reply(409, { error: 'busy' });
        return;
      }
      installPending = true;
      try {
        if (hostInstall) {
          // Stage with the old service available; only the final synchronous admission
          // may disconnect idle peers. Busy or failed staging must leave them alone.
          if (
            !options.backend.cancel ||
            (await options.backend.status()).hostMaintenance !== true
          ) {
            reply(409, { error: 'host-maintenance-unavailable' });
            return;
          }
          if (options.admission.busy?.()) {
            reply(409, {
              error: 'busy; finish tasks and close native terminals; original service left running',
            });
            return;
          }
          try {
            await options.backend.prepare(input as InstallConfirmation);
          } catch {
            const status = await options.backend.status();
            reply(409, {
              error: `${status.error ?? 'preparation-failed'}; no cutover requested; inspect service status`,
            });
            return;
          }
          if (!options.admission.enter(true)) {
            await options.backend.cancel();
            reply(409, {
              error: 'busy; finish tasks and close native terminals; original service left running',
            });
            return;
          }
        }
        // enter() is synchronous: close every admission gate, then recheck all activity before any await.
        if (!hostInstall && !options.admission.enter()) {
          reply(409, { error: 'busy' });
          return;
        }
        try {
          if (!hostInstall) await options.backend.prepare(input as InstallConfirmation);
          let activated = false;
          const activate = () => {
            if (!activated) {
              activated = true;
              options.backend.activate();
            }
          };
          response.once('finish', activate);
          response.once('close', activate);
          if (response.destroyed) activate();
          reply(202, { accepted: true, build: input.build, sha256: input.sha256 });
        } catch {
          options.admission.leave();
          reply(409, { error: 'release-not-installable' });
        }
      } finally {
        installPending = false;
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
