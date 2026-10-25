import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { createProxyServer } from '../../../server/src/server.ts';
import { createBrowserProxy } from '../../../server/src/browser-proxy.ts';
import { custom, defaultCertificate } from '../../../server/test/fixtures/web-certificates.ts';

// Everything is loopback-owned. The facade combines real Coding with an
// independently authenticated v2 proxy using only test-local DNS/dial injection.
export async function ownedBrowserService(directory: string, token: string) {
  const coding = createProxyServer({ token, dataDir: directory });
  const internal = new URL(await coding.listen(0));
  const sockets = new Set<Duplex>();
  const site = createServer(custom, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><title>Owned integrated Chat</title><label>测试输入<input id="owned-input"></label>',
    );
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const browser = createBrowserProxy({
    token,
    hosts: ['default.example.test'],
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    dial: (target) => {
      assert.equal(target.address, '1.1.1.1');
      return connect({ host: '127.0.0.1', port: (site.address() as { port: number }).port });
    },
  });
  const gateway = createServer(defaultCertificate, (req, res) => {
    if (browser.handle(req, res)) return;
    const pass = request(
      {
        host: '127.0.0.1',
        port: internal.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    pass.on('error', () => res.destroy());
    req.pipe(pass);
  });
  gateway.on('upgrade', (req, socket, head) => {
    if (browser.upgrade(req, socket, head)) return;
    const upstream = connect({ host: '127.0.0.1', port: Number(internal.port) });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('connect', () => {
      const headers = req.rawHeaders.reduce<string[]>(
        (lines, value, index, values) =>
          index % 2 ? lines : [...lines, value + ': ' + values[index + 1]],
        [],
      );
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  for (const server of [site, gateway])
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  return {
    url: `wss://127.0.0.1:${(gateway.address() as { port: number }).port}/ws`,
    async close() {
      browser.close();
      for (const socket of sockets) socket.destroy();
      await coding.close();
      await Promise.all([
        new Promise<void>((r) => gateway.close(() => r())),
        new Promise<void>((r) => site.close(() => r())),
      ]);
    },
  };
}
