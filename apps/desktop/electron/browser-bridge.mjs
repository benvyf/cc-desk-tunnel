import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { connectService, controlTlsOptions, certificateMatches } from './secure-service.mjs';

export function browserAddress(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash)
    throw new Error('网页通道需要已验证的WSS服务地址。');
  url.pathname = '/cc-browser/v1/display';
  return url;
}
export async function openBrowserBridge(config, { resolveProxy, heartbeatMs = 15000 } = {}) {
  const address = browserAddress(config.url);
  controlTlsOptions(config);
  const nonce = randomBytes(32).toString('hex');
  const server = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new Set();
  server.on('connection', (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
  });
  let remote;
  let closed = false;
  let closing;
  server.on('upgrade', (request, socket, head) => {
    if (
      closed ||
      wss.clients.size ||
      request.url !== `/browser/${nonce}` ||
      !['null', 'file://'].includes(request.headers.origin)
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (local) => {
    local.on('error', () => {});
    const localStream = createWebSocketStream(local, { highWaterMark: 64 * 1024 });
    localStream.on('error', () => {});
    remote = new WebSocket(address, {
      perMessageDeflate: false,
      maxPayload: 8 * 1024 * 1024,
      followRedirects: false,
      handshakeTimeout: 15000,
      createConnection: (_options, callback) => {
        connectService(address, config, resolveProxy).then(
          (socket) => callback(null, socket),
          callback,
        );
      },
    });
    const peer = remote;
    let heartbeat;
    let heard = Date.now();
    const alive = () => {
      heard = Date.now();
    };
    peer.on('ping', alive);
    peer.on('pong', alive);
    peer.on('message', alive);
    const timeout = setTimeout(() => {
      peer.terminate();
      local.close(1011, '网页连接超时');
    }, 15000);
    timeout.unref();
    peer.on('error', () => local.close(1011, '远端网页不可用'));
    peer.on('unexpected-response', (_req, response) => {
      response.resume();
      peer.terminate();
    });
    local.once('close', () => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      localStream.destroy();
      peer.terminate();
    });
    peer.once('close', () => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      local.close(1011, '远端网页连接中断');
    });
    peer.once('open', () => {
      if (
        closed ||
        local.readyState !== WebSocket.OPEN ||
        (config.fingerprint &&
          !certificateMatches(peer._socket.getPeerCertificate().fingerprint256, config.fingerprint))
      ) {
        peer.terminate();
        return;
      }
      // The TLS connection and actual certificate are verified before sending this first credential frame.
      peer.send(JSON.stringify({ type: 'authenticate', token: config.token }));
    });
    peer.once('message', (data, binary) => {
      let ready = false;
      try {
        ready = !binary && data.length < 1024 && JSON.parse(data).type === 'ready';
      } catch {}
      if (!ready) {
        peer.terminate();
        return;
      }
      clearTimeout(timeout);
      heartbeat = setInterval(() => {
        if (Date.now() - heard > heartbeatMs * 2.5) peer.terminate();
        else if (peer.readyState === WebSocket.OPEN) peer.ping();
      }, heartbeatMs);
      heartbeat.unref();
      const remoteStream = createWebSocketStream(peer, { highWaterMark: 64 * 1024 });
      pipeline(localStream, remoteStream, () => {
        local.terminate();
        peer.terminate();
      });
      pipeline(remoteStream, localStream, () => {
        local.terminate();
        peer.terminate();
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}/browser/${nonce}`,
    close() {
      if (closing) return closing;
      closed = true;
      const stopped = new Promise((r) => server.close(r));
      for (const client of wss.clients) client.terminate();
      remote?.terminate();
      for (const socket of sockets) socket.destroy();
      closing = Promise.all([stopped, new Promise((r) => wss.close(r))]).then(() => {});
      return closing;
    },
  };
}
