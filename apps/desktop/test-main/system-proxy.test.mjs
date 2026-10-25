import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, createServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { httpProxy, openSocket } from '../electron/system-proxy.mjs';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';
import { connectService, serviceJson } from '../electron/secure-service.mjs';
import { openBrowserBridge } from '../electron/browser-bridge.mjs';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
// A CONNECT proxy that records what it was asked for and refuses port 1.
async function proxyServer(requests) {
  return listen((client) => {
    client.once('data', (head) => {
      const line = head.toString('latin1').split('\r\n')[0];
      requests.push(line);
      const [, host, port] = /^CONNECT (.+):(\d+) HTTP\/1\.1$/.exec(line);
      if (port === '1') return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const target = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.pipe(target).pipe(client);
      });
      target.on('error', () => client.destroy());
      client.on('error', () => target.destroy());
    });
  });
}

test('only an HTTP proxy in first place is taken from the system answer', () => {
  assert.deepEqual(httpProxy('PROXY 127.0.0.1:7890; DIRECT'), { host: '127.0.0.1', port: 7890 });
  assert.deepEqual(httpProxy('proxy gateway.example:8080'), {
    host: 'gateway.example',
    port: 8080,
  });
  for (const answer of ['DIRECT', 'DIRECT; PROXY 127.0.0.1:7890', 'SOCKS5 127.0.0.1:1080', ''])
    assert.equal(httpProxy(answer), null);
  assert.equal(httpProxy(undefined), null);
});

test('management cancellation bounds a pending system proxy resolver before socket dialing', async () => {
  let finish;
  const controller = new AbortController();
  const pending = connectService(
    new URL('wss://127.0.0.1:1/ws'),
    { fingerprint: '' },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    undefined,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, /取消/);
  finish('DIRECT');
});

test('a connection through the proxy reaches the target; without one it goes direct', async (t) => {
  const requests = [];
  const echo = await listen((socket) => socket.pipe(socket));
  const proxy = await proxyServer(requests);
  t.after(() => {
    echo.close();
    proxy.close();
  });
  for (const via of [{ host: '127.0.0.1', port: proxy.address().port }, null]) {
    const socket = await openSocket(via, '127.0.0.1', echo.address().port);
    socket.resume();
    socket.write('ping');
    assert.equal(String((await once(socket, 'data'))[0]), 'ping');
    socket.destroy();
  }
  assert.deepEqual(requests, [`CONNECT 127.0.0.1:${echo.address().port} HTTP/1.1`]);
});

test('a refusing or silent proxy fails the connection instead of leaving it open', async (t) => {
  const proxy = await proxyServer([]);
  const silent = await listen(() => {});
  t.after(() => {
    proxy.close();
    silent.close();
  });
  await assert.rejects(
    openSocket({ host: '127.0.0.1', port: proxy.address().port }, '127.0.0.1', 1),
    /403/,
  );
  await assert.rejects(
    openSocket({ host: '127.0.0.1', port: silent.address().port }, '127.0.0.1', 1, 200),
    /timed out/,
  );
});

// A throwaway certificate made in memory by PowerShell; nothing enters the Windows certificate store.
async function selfSigned() {
  const script = `$key = [Security.Cryptography.RSA]::Create(2048)
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256', [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
    @{ cert = $certificate.ExportCertificatePem(); key = $key.ExportPkcs8PrivateKeyPem() } | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)(
    'pwsh.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
  return JSON.parse(stdout);
}

test(
  'CA verification matches the requested service IP through direct and CONNECT routes before sending credentials',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const certificate = await selfSigned(); // Trusted only by this process; valid for localhost, not 127.0.0.1.
    assert.equal(new X509Certificate(certificate.cert).checkIP('127.0.0.1'), undefined);
    const trusted = getCACertificates('default');
    setDefaultCACertificates([...trusted, certificate.cert]);
    t.after(() => setDefaultCACertificates(trusted));
    let credentials = 0;
    const service = createHttpsServer(certificate, (_req, res) => {
      credentials++;
      res.end(JSON.stringify({ ok: true }));
    });
    const wss = new WebSocketServer({ server: service });
    wss.on('connection', (ws) =>
      ws.once('message', () => {
        credentials++;
        ws.send(JSON.stringify({ type: 'ready' }));
        ws.send(Buffer.from([5]));
      }),
    );
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const proxy = await proxyServer([]);
    t.after(async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((done) => wss.close(done));
      service.closeAllConnections();
      await new Promise((done) => service.close(done));
      await new Promise((done) => proxy.close(done));
    });
    const config = {
      url: `wss://127.0.0.1:${service.address().port}/ws`,
      fingerprint: '',
      token: 'offline-service-ip-identity-test-token',
    };
    for (const route of [undefined, () => `PROXY 127.0.0.1:${proxy.address().port}`]) {
      await assert.rejects(serviceJson(config, 'GET', '/cc-browser/v1/status', undefined, route), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
      assert.equal(credentials, 0);
      const refused = await openBrowserBridge(config, { resolveProxy: route });
      try {
        const local = new WebSocket(refused.url, { origin: 'file://' });
        await once(local, 'open');
        assert.equal((await once(local, 'close'))[0], 1011);
        assert.equal(credentials, 0);
      } finally {
        await refused.close();
      }
    }
    const matching = { ...config, url: config.url.replace('127.0.0.1', 'localhost') };
    assert.deepEqual(await serviceJson(matching, 'GET', '/cc-browser/v1/status'), { ok: true });
    const accepted = await openBrowserBridge(matching);
    try {
      const local = new WebSocket(accepted.url, { origin: 'file://' });
      await once(local, 'open');
      assert.deepEqual((await once(local, 'message'))[0], Buffer.from([5]));
      assert.equal(credentials, 2);
      local.terminate();
    } finally {
      await accepted.close();
    }
  },
);

test(
  'managed HTTPS POST uses system CONNECT proxy and validates pin before writing token; refuses redirects and oversized JSON',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const { cert, key } = await selfSigned();
    const received = [];
    let mode = 'normal';
    const service = createHttpsServer({ cert, key }, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({
        path: req.url,
        token: req.headers.authorization,
        origin: req.headers.origin,
        method: req.method,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      if (mode === 'redirect') {
        res.writeHead(302, { Location: '/steal' });
        res.end();
      } else if (mode === 'oversized') res.end('x'.repeat(300000));
      else res.end(JSON.stringify({ ok: true }));
    });
    service.on('tlsClientError', () => {});
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const requests = [],
      asked = [];
    const proxy = await proxyServer(requests);
    t.after(() => {
      service.closeAllConnections();
      service.close();
      proxy.close();
    });
    const config = {
      url: `wss://127.0.0.1:${service.address().port}/nested/ws`,
      token: 'fixture-token-at-least-24-characters',
      fingerprint: new X509Certificate(cert).fingerprint256,
    };
    const resolveProxy = async (url) => {
      asked.push(url);
      return `PROXY 127.0.0.1:${proxy.address().port}`;
    };
    const send = (c) =>
      serviceJson(c, 'POST', '/cc-managed/server/v1/check', { clientProtocol: 1 }, resolveProxy);
    await assert.rejects(send({ ...config, fingerprint: 'AB'.repeat(32) }), /指纹不匹配/);
    assert.equal(received.length, 0);
    assert.deepEqual(await send(config), { ok: true });
    assert.deepEqual(received[0], {
      path: '/cc-managed/server/v1/check',
      token: `Bearer ${config.token}`,
      origin: undefined,
      method: 'POST',
      body: { clientProtocol: 1 },
    });
    assert.equal(requests.length, 2);
    assert.equal(asked.length, 2);
    mode = 'redirect';
    await assert.rejects(send(config), /302/);
    assert.equal(received.length, 2);
    mode = 'oversized';
    await assert.rejects(send(config), /过大/);
  },
);

test(
  'the control connection goes through the system proxy and still checks the pinned certificate',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const { cert, key } = await selfSigned();
    const service = createHttpsServer({ cert, key });
    const messages = [];
    new WebSocketServer({ server: service }).on('connection', (socket) =>
      socket.on('message', (raw) => messages.push(String(raw))),
    );
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const requests = [];
    const asked = [];
    const proxy = await proxyServer(requests);
    const target = `127.0.0.1:${service.address().port}`;
    const open = (fingerprint) =>
      openProxyBridge(
        { url: `wss://${target}/ws`, fingerprint },
        {
          resolveProxy: async (url) => {
            asked.push(url);
            return `PROXY 127.0.0.1:${proxy.address().port}; DIRECT`;
          },
        },
        () => {},
        [undefined],
      );
    const bridges = [];
    t.after(async () => {
      for (const bridge of bridges) await bridge.close();
      service.closeAllConnections();
      service.close();
      proxy.close();
    });
    const send = async (fingerprint) => {
      const bridge = await open(fingerprint);
      bridges.push(bridge);
      const local = new WebSocket(bridge.url);
      await once(local, 'open');
      local.send(JSON.stringify({ type: 'auth', token: 'secret' }));
      return local;
    };

    await send(new X509Certificate(cert).fingerprint256);
    while (!messages.length) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(messages[0]), { type: 'auth', token: 'secret', tunnel: true });
    assert.deepEqual(asked, [`https://${target}`]);
    assert.deepEqual(requests, [`CONNECT ${target} HTTP/1.1`]);

    // Another certificate behind the same proxy is refused before the token leaves this machine.
    const refused = await send('AB'.repeat(32));
    assert.match(String((await once(refused, 'message'))[0]), /指纹不匹配/);
    assert.equal(messages.length, 1);
    assert.equal(requests.length, 2);
  },
);
test(
  'a service that goes silent is given up and the reason recorded; one that answers is kept',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const { cert, key } = await selfSigned();
    const fingerprint = new X509Certificate(cert).fingerprint256;
    const bridges = [];
    const services = [];
    t.after(async () => {
      for (const bridge of bridges) await bridge.close();
      for (const service of services) {
        service.closeAllConnections();
        service.close();
      }
    });
    // `answers` is whether the service returns the signs of life it is asked for.
    const connect = async (answers) => {
      const service = createHttpsServer({ cert, key });
      services.push(service);
      new WebSocketServer({ server: service, autoPong: answers });
      service.listen(0, '127.0.0.1');
      await once(service, 'listening');
      const lines = [];
      const bridge = await openProxyBridge(
        { url: `wss://127.0.0.1:${service.address().port}/ws`, fingerprint },
        { heartbeatMs: 100, log: (line) => lines.push(line) },
        () => {},
        [undefined],
      );
      bridges.push(bridge);
      const local = new WebSocket(bridge.url);
      await once(local, 'open');
      return { local, lines };
    };

    const silent = await connect(false);
    const [raw] = await once(silent.local, 'message');
    // A fault on the way, which the window tries again.
    assert.equal(JSON.parse(String(raw)).code, 'connection_lost');
    assert.match(String(raw), /没有收到服务端的任何数据/);
    await once(silent.local, 'close');
    assert.ok(silent.lines.some((line) => line.startsWith('Reached 127.0.0.1')));
    assert.ok(silent.lines.some((line) => line.startsWith('Connection given up: 已有')));

    const answering = await connect(true);
    let ended = false;
    answering.local.once('close', () => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(ended, false);
    assert.equal(
      answering.lines.some((line) => line.startsWith('Connection given up')),
      false,
    );
  },
);
