import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createBrowserProxy } from '../apps/server/src/browser-proxy.ts';

// Owned-site lab only. This entrypoint never loads server.ts, native agents,
// production settings, Claude endpoints, or lookup/dial overrides.
export async function startEgressLab({
  key,
  cert,
  token,
  host = '127.0.0.1',
  port = 0,
  lifetimeMs = 45 * 60 * 1000,
}) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new Error('Invalid lab token');
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 45 * 60 * 1000)
    throw new Error('Invalid lab lifetime');
  const proxy = createBrowserProxy({ token, hosts: ['api.ghostapi.org'] });
  const expiresAt = new Date(Date.now() + lifetimeMs).toISOString();
  const server = createServer(
    { key, cert, minVersion: 'TLSv1.2', handshakeTimeout: 5000, maxHeaderSize: 8192 },
    (request, response) => {
      if (proxy.handle(request, response)) return;
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify({ status: 'synthetic-egress-lab', expiresAt }));
      } else response.writeHead(404, { Connection: 'close' }).end();
    },
  );
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.on('upgrade', (request, socket, head) => {
    if (!proxy.upgrade(request, socket, head)) socket.destroy();
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  let closing, expiry;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const close = () => {
    if (closing) return closing;
    clearTimeout(expiry);
    proxy.close();
    for (const socket of sockets) socket.destroy();
    closing = new Promise((resolve) => server.close(resolve)).then(() => resolveClosed());
    return closing;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await close();
    throw error;
  }
  expiry = setTimeout(() => {
    void close();
  }, lifetimeMs);
  expiry.unref();
  return { address: `https://${host}:${server.address().port}`, close, closed, expiresAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const state = '/run/cc-egress-lab';
  const lab = await startEgressLab({
    key: readFileSync(state + '/key.pem'),
    cert: readFileSync(state + '/cert.pem'),
    token: readFileSync(state + '/token', 'utf8').trim(),
    host: '0.0.0.0',
    port: 8787,
  });
  process.once('SIGTERM', () => {
    void lab.close();
  });
  process.once('SIGINT', () => {
    void lab.close();
  });
  console.log(JSON.stringify({ marker: 'EGRESS_LAB_READY', expiresAt: lab.expiresAt }));
}
