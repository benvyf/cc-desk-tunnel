import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { Throttle } from './throttle.ts';

export function browserEndpoint(value: string): string {
  const url = new URL(value);
  // This is an administrator-selected Docker service, never a URL from the renderer.
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', 'cc-claude-web', 'cc-claude-web-trial'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid private browser endpoint');
  return url.href;
}
export type BrowserOptions = {
  token: string;
  endpoint?: string;
  blocked?: () => string | undefined;
  throttle?: Throttle;
  address?: (request: IncomingMessage) => string;
};
export function createBrowserService(options: BrowserOptions) {
  const endpoint = options.endpoint ? browserEndpoint(options.endpoint) : undefined;
  const expected = createHash('sha256').update(options.token).digest();
  const authorized = (value: unknown) =>
    typeof value === 'string' &&
    value.length <= 4096 &&
    timingSafeEqual(expected, createHash('sha256').update(value).digest());
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });
  let owner: WebSocket | undefined;
  let closed = false;
  const remotes = new Set<WebSocket>();
  const alive = new WeakSet<WebSocket>();
  const pending = new WeakMap<IncomingMessage, () => void>();
  const throttle = options.throttle ?? new Throttle();
  const addressOf =
    options.address ?? ((request: IncomingMessage) => request.socket.remoteAddress ?? 'unknown');
  function watch(socket: WebSocket) {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
  }
  const reason = () =>
    closed ? 'unavailable' : (options.blocked?.() ?? (endpoint ? 'available' : 'not-configured'));
  wss.on('connection', (client, request) => {
    const address = addressOf(request);
    const leave = pending.get(request)!;
    watch(client);
    client.on('error', () => {});
    const timeout = setTimeout(() => client.terminate(), 5000);
    timeout.unref();
    client.once('close', () => {
      leave();
      clearTimeout(timeout);
      if (owner === client) owner = undefined;
    });
    client.once('message', (data, binary) => {
      clearTimeout(timeout);
      leave();
      let auth: { type?: string; token?: unknown } = {};
      try {
        const text = data.toString();
        if (!binary && text.length <= 8192) {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) auth = parsed;
        }
      } catch {}
      if (throttle.blocked(address) || auth.type !== 'authenticate' || !authorized(auth.token)) {
        throttle.fail(address);
        client.close(1008, 'Unauthorized');
        return;
      }
      throttle.succeed(address);
      if (reason() !== 'available') {
        client.close(1013, 'Unavailable');
        return;
      }
      if (owner) {
        client.close(1013, 'Occupied');
        return;
      }
      owner = client;
      const remote = new WebSocket(endpoint!, {
        handshakeTimeout: 10000,
        perMessageDeflate: false,
        maxPayload: 8 * 1024 * 1024,
        followRedirects: false,
      });
      remotes.add(remote);
      watch(remote);
      remote.on('error', () => client.close(1011, 'Remote browser unavailable'));
      remote.on('unexpected-response', (_request, response) => {
        response.resume();
        remote.terminate();
      });
      remote.once('close', () => {
        remotes.delete(remote);
        client.close(1011, 'Remote browser disconnected');
      });
      client.once('close', () => remote.terminate());
      remote.once('open', () => {
        if (client.readyState !== WebSocket.OPEN || reason() !== 'available') {
          remote.terminate();
          return;
        }
        client.send(JSON.stringify({ type: 'ready' }));
        const localStream = createWebSocketStream(client, { highWaterMark: 64 * 1024 });
        const remoteStream = createWebSocketStream(remote, { highWaterMark: 64 * 1024 });
        pipeline(localStream, remoteStream, () => {
          client.terminate();
          remote.terminate();
        });
        pipeline(remoteStream, localStream, () => {
          client.terminate();
          remote.terminate();
        });
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of [...wss.clients, ...remotes]) {
      if (!alive.has(client) || reason() !== 'available') client.terminate();
      else if (client.readyState === WebSocket.OPEN) {
        alive.delete(client);
        client.ping();
      }
    }
  }, 15000);
  heartbeat.unref();
  return {
    busy: () => wss.clients.size > 0,
    handle(request: IncomingMessage, response: ServerResponse) {
      if (!request.url?.startsWith('/cc-browser/')) return false;
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
      } else if (request.method !== 'GET' || request.url !== '/cc-browser/v1/status') reply(404);
      else reply(200, { schema: 1, enabled: reason() === 'available', reason: reason() });
      return true;
    },
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      if (!request.url?.startsWith('/cc-browser/')) return false;
      const address = addressOf(request);
      if (
        closed ||
        request.url !== '/cc-browser/v1/display' ||
        request.headers.origin !== undefined ||
        wss.clients.size >= 4
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      } else if (throttle.blocked(address) || !throttle.enter(address)) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      } else {
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
      closed = true;
      clearInterval(heartbeat);
      for (const client of wss.clients) client.terminate();
      for (const remote of remotes) remote.terminate();
      wss.close();
    },
  };
}
