import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';
import { connectService, controlTlsOptions, certificateMatches } from './secure-service.mjs';

export function browserProxyAddress(value) {
  const address = new URL(value);
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('浏览器代理需要已验证的WSS服务地址。');
  address.pathname = '/cc-browser/v2/connect';
  return address;
}

function connectTarget(value) {
  if (typeof value !== 'string' || value.length > 257 || /[^a-zA-Z0-9.:-]/.test(value)) return null;
  const match = /^([^:]+):443$/.exec(value);
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (
    !host.includes('.') ||
    /^[0-9.]+$/.test(host) ||
    !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return host;
}

export async function openBrowserNetworkProxy(
  config,
  { resolveProxy, connectTimeoutMs = 15000, heartbeatMs = 15000 } = {},
) {
  const serviceConfig = { ...config };
  const address = browserProxyAddress(serviceConfig.url);
  controlTlsOptions(serviceConfig);
  const username = 'cc-browser-' + randomBytes(12).toString('hex');
  const password = randomBytes(32).toString('hex');
  const expected = createHash('sha256')
    .update('Basic ' + Buffer.from(username + ':' + password).toString('base64'))
    .digest();
  const authorized = (value) =>
    typeof value === 'string' &&
    value.length < 4096 &&
    timingSafeEqual(expected, createHash('sha256').update(value).digest());
  const sockets = new Set();
  const peers = new Set();
  const openings = new Set();
  let closed = false;
  let closing;
  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(403, { Connection: 'close', 'Content-Length': '0' }).end();
  });
  const reply = (socket, status, challenge = false) => {
    if (!socket.destroyed)
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n${challenge ? 'Proxy-Authenticate: Basic realm="cc-browser"\r\n' : ''}\r\n`,
        () => socket.destroy(),
      );
  };
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', (socket) => {
    if (closed || sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, socket, head) => {
    if (closed || socket.destroyed || request.headers.origin !== undefined) {
      reply(socket, 403);
      return;
    }
    if (!authorized(request.headers['proxy-authorization'])) {
      reply(socket, 407, true);
      return;
    }
    const host = connectTarget(request.url);
    if (!host || head.length > 64 * 1024) {
      reply(socket, 403);
      return;
    }
    socket.setTimeout(0);
    const controller = new AbortController();
    openings.add(controller);
    let peer;
    let established = false;
    let finished = false;
    let heartbeat;
    let deadline;
    const early = head.length ? [head] : [];
    let earlyBytes = head.length;
    const collect = (data) => {
      earlyBytes += data.length;
      if (earlyBytes > 64 * 1024) finish();
      else early.push(data);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      socket.removeListener('data', collect);
      socket.removeListener('end', finish);
      clearTimeout(deadline);
      clearInterval(heartbeat);
      controller.abort();
      openings.delete(controller);
      peer?.terminate();
      if (established || closed) socket.destroy();
      else reply(socket, 502);
    };
    socket.once('close', finish);
    // Keep reading while opening so a caller's FIN cancels delayed resolution/dialing.
    // Early TLS bytes are bounded and forwarded only after the remote is ready.
    socket.on('data', collect);
    socket.once('end', finish);
    socket.resume();
    try {
      peer = new WebSocket(address, {
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: 256 * 1024,
        handshakeTimeout: connectTimeoutMs,
        createConnection: (_options, callback) => {
          connectService(address, serviceConfig, resolveProxy, undefined, controller.signal).then(
            (tls) => callback(null, tls),
            callback,
          );
        },
      });
      peers.add(peer);
      peer.on('error', finish);
      peer.once('close', () => {
        peers.delete(peer);
        clearInterval(heartbeat);
        // Once streaming, its EOF must drain through the writable socket.
        // Destroying here can drop the last frame for a slow local reader.
        if (!established) finish();
      });
      peer.on('unexpected-response', (_request, response) => {
        response.resume();
        finish();
      });
      deadline = setTimeout(finish, connectTimeoutMs);
      deadline.unref();
      let heard = Date.now();
      const alive = () => {
        heard = Date.now();
      };
      peer.on('ping', alive);
      peer.on('pong', alive);
      peer.on('message', (_data, binary) => {
        alive();
        if (established && !binary) finish();
      });
      peer.once('open', () => {
        if (
          closed ||
          finished ||
          socket.destroyed ||
          (serviceConfig.fingerprint &&
            !certificateMatches(
              peer._socket?.getPeerCertificate?.()?.fingerprint256,
              serviceConfig.fingerprint,
            ))
        ) {
          finish();
          return;
        }
        // Never send the service token until this TLS peer's certificate is verified.
        peer.send(JSON.stringify({ type: 'connect', token: serviceConfig.token, host, port: 443 }));
      });
      peer.once('message', (data, binary) => {
        let ready = false;
        try {
          ready = !binary && data.length < 1024 && JSON.parse(data).type === 'ready';
        } catch {}
        if (!ready || closed || finished || socket.destroyed) {
          finish();
          return;
        }
        clearTimeout(deadline);
        socket.pause();
        socket.removeListener('data', collect);
        socket.removeListener('end', finish);
        openings.delete(controller);
        established = true;
        heartbeat = setInterval(() => {
          if (Date.now() - heard > heartbeatMs * 2.5) finish();
          else if (peer.readyState === WebSocket.OPEN) peer.ping();
        }, heartbeatMs);
        heartbeat.unref();
        const stream = createWebSocketStream(peer, { highWaterMark: 64 * 1024 });
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (earlyBytes) stream.write(Buffer.concat(early, earlyBytes));
        // 'finish' means all response bytes have left Node's write buffer. A
        // client need not send its FIN to release this already completed tunnel.
        socket.once('finish', finish);
        const failed = (error) => {
          if (error) finish();
        };
        pipeline(socket, stream, failed);
        pipeline(stream, socket, failed);
      });
    } catch {
      finish();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    username,
    password,
    proxyRules: `http://127.0.0.1:${port}`,
    proxyBypassRules: '<-loopback>',
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise((resolve) => server.close(resolve));
      for (const controller of openings) controller.abort();
      for (const peer of peers) peer.terminate();
      for (const socket of sockets) socket.destroy();
      return closing;
    },
  };
}
