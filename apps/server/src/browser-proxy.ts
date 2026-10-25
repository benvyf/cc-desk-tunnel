import { createHash, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline, type Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { Throttle } from './throttle.ts';
import {
  browserProxyHost,
  resolveBrowserTarget,
  type BrowserLookup,
  type BrowserTarget,
} from './browser-proxy-target.ts';

export type BrowserProxyOptions = {
  token: string;
  hosts?: string[];
  blocked?: () => string | undefined;
  throttle?: Throttle;
  address?: (request: IncomingMessage) => string;
  // Explicit process-local dependencies for owned offline peers; never read from environment or client frames.
  lookup?: BrowserLookup;
  dial?: (target: BrowserTarget) => Socket;
  authTimeoutMs?: number;
  connectTimeoutMs?: number;
};

export function createBrowserProxy(options: BrowserProxyOptions) {
  const allowed = new Set((options.hosts ?? []).map(browserProxyHost));
  if (allowed.size > 64) throw new Error('Too many browser proxy hosts');
  const expected = createHash('sha256').update(options.token).digest();
  const authorized = (value: unknown) =>
    typeof value === 'string' &&
    value.length <= 4096 &&
    timingSafeEqual(expected, createHash('sha256').update(value).digest());
  const throttle = options.throttle ?? new Throttle();
  const addressOf =
    options.address ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown');
  const socketOptions = {
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 256 * 1024,
    closeTimeout: 1000,
  };
  const wss = new WebSocketServer(socketOptions);
  let closed = false;
  const reason = () =>
    closed
      ? 'unavailable'
      : (options.blocked?.() ?? (allowed.size ? 'available' : 'not-configured'));
  const sockets = new Set<Socket>();
  const alive = new WeakSet<WebSocket>();
  const pending = new WeakMap<IncomingMessage, () => void>();

  wss.on('connection', (ws, request) => {
    const address = addressOf(request);
    const leave = pending.get(request)!;
    let phase: 'first' | 'opening' | 'ready' | 'closed' = 'first';
    let target: Socket | undefined;
    let deadline: ReturnType<typeof setTimeout>;
    const fail = (code: number, message: string) => {
      if (phase === 'closed') return;
      phase = 'closed';
      leave();
      clearTimeout(deadline);
      target?.destroy();
      ws.close(code, message);
    };
    deadline = setTimeout(() => {
      throttle.fail(address);
      fail(1008, 'Authentication timeout');
    }, options.authTimeoutMs ?? 5000);
    deadline.unref();
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => {});
    ws.once('close', () => {
      phase = 'closed';
      leave();
      clearTimeout(deadline);
      target?.destroy();
    });
    ws.on('message', (data, binary) => {
      if (phase !== 'first') {
        if (phase !== 'ready' || !binary || reason() !== 'available')
          fail(1008, 'Invalid proxy frame');
        return;
      }
      phase = 'opening';
      leave();
      clearTimeout(deadline);
      let auth: { type?: string; token?: unknown; host?: unknown; port?: unknown } = {};
      try {
        if (!binary && data.toString().length <= 8192) {
          const value = JSON.parse(data.toString());
          if (value && typeof value === 'object' && !Array.isArray(value)) auth = value;
        }
      } catch {}
      if (throttle.blocked(address) || auth.type !== 'connect' || !authorized(auth.token)) {
        throttle.fail(address);
        fail(1008, 'Unauthorized');
        return;
      }
      throttle.succeed(address);
      if (reason() !== 'available') {
        fail(1013, 'Unavailable');
        return;
      }
      deadline = setTimeout(
        () => fail(1011, 'Target connection timeout'),
        options.connectTimeoutMs ?? 15000,
      );
      deadline.unref();
      const current = () =>
        phase === 'opening' && ws.readyState === WebSocket.OPEN && reason() === 'available';
      void resolveBrowserTarget(auth.host, auth.port, allowed, options.lookup)
        .then((resolved) => {
          if (!current()) {
            fail(1013, 'Unavailable');
            return;
          }
          target = options.dial
            ? options.dial(resolved)
            : connect({
                host: resolved.address,
                port: resolved.port,
                family: resolved.family,
              });
          const socket = target;
          sockets.add(socket);
          socket.on('error', () => fail(1011, 'Target unavailable'));
          socket.once('close', () => {
            sockets.delete(socket);
            fail(1011, 'Target closed');
          });
          socket.once('connect', () => {
            if (!current()) {
              fail(1013, 'Unavailable');
              return;
            }
            clearTimeout(deadline);
            phase = 'ready';
            ws.send(JSON.stringify({ type: 'ready' }));
            const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
            const stop = () => {
              socket.destroy();
              ws.terminate();
            };
            pipeline(stream, socket, stop);
            pipeline(socket, stream, stop);
          });
        })
        .catch(() => fail(1008, 'Target denied'));
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws) || reason() !== 'available') ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) {
        alive.delete(ws);
        ws.ping();
      }
    }
  }, 15000);
  heartbeat.unref();

  return {
    busy: () => wss.clients.size > 0,
    handle(request: IncomingMessage, response: ServerResponse) {
      if (!request.url?.startsWith('/cc-browser/v2/')) return false;
      const reply = (status: number, body: object = {}) => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(body));
      };
      const address = addressOf(request);
      if (request.headers.origin !== undefined) reply(403);
      else if (throttle.blocked(address)) reply(429);
      else if (!authorized(request.headers.authorization?.replace(/^Bearer /, ''))) {
        throttle.fail(address);
        reply(401);
      } else if (request.method !== 'GET' || request.url !== '/cc-browser/v2/status') reply(404);
      else reply(200, { schema: 2, enabled: reason() === 'available', reason: reason() });
      return true;
    },
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      if (!request.url?.startsWith('/cc-browser/v2/')) return false;
      const address = addressOf(request);
      const reject = (status: number) =>
        socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`, () =>
          socket.destroy(),
        );
      if (
        closed ||
        request.url !== '/cc-browser/v2/connect' ||
        request.headers.origin !== undefined ||
        wss.clients.size >= 64
      )
        reject(403);
      else if (throttle.blocked(address) || !throttle.enter(address)) reject(429);
      else {
        let waiting = true;
        const leave = () => {
          if (waiting) {
            waiting = false;
            throttle.leave(address);
          }
        };
        pending.set(request, leave);
        socket.once('close', leave);
        try {
          wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
        } catch {
          leave();
          socket.destroy();
        }
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close();
    },
  };
}
