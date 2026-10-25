import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { request, get } from 'node:http';
import { createServer } from 'node:https';
import { connect, createServer as createTcpServer } from 'node:net';
import { connect as connectTls, createServer as createTlsServer } from 'node:tls';
import { WebSocketServer } from 'ws';
import { createBrowserProxy } from '../../server/src/browser-proxy.ts';
import { ca, defaultCertificate, custom } from '../../server/test/fixtures/web-certificates.ts';
import {
  browserProxyAddress,
  openBrowserNetworkProxy,
} from '../electron/browser-network-proxy.mjs';

const website = 'default.example.test';
const token = 'offline-network-proxy-credential';
const auth = (proxy) =>
  'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
async function tunnel(
  proxy,
  { authorization = auth(proxy), target = website + ':443', origin } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers: {
        ...(authorization ? { 'Proxy-Authorization': authorization } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      agent: false,
    });
    req.once('connect', (response, socket, head) => resolve({ response, socket, head }));
    req.once('error', reject);
    req.end();
  });
}

async function fixture(
  t,
  {
    wrongPin = false,
    untrustedCa = false,
    raw = false,
    silent = false,
    redirect = false,
    noPong = false,
    onRawReady,
    websiteHandler,
    ...timing
  } = {},
) {
  let dials = 0;
  const authFrames = [];
  const targets = new Set();
  const websiteServer = createTlsServer(custom, (socket) => {
    targets.add(socket);
    socket.on('close', () => targets.delete(socket));
    if (websiteHandler) websiteHandler(socket);
    else socket.pipe(socket);
  });
  websiteServer.listen(0, '127.0.0.1');
  await once(websiteServer, 'listening');
  const service = createBrowserProxy({
    token,
    hosts: [website],
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    dial: (target) => {
      assert.equal(target.address, '1.1.1.1');
      dials++;
      return connect({ host: '127.0.0.1', port: websiteServer.address().port });
    },
  });
  const server = createServer(defaultCertificate);
  let upgrades = 0;
  const rawServer = raw
    ? new WebSocketServer({ noServer: true, autoPong: !silent && !noPong })
    : undefined;
  rawServer?.on('connection', (ws) =>
    ws.once('message', (data) => {
      authFrames.push(JSON.parse(data));
      if (!silent) ws.send(JSON.stringify({ type: 'ready' }));
      onRawReady?.(ws);
    }),
  );
  server.on('upgrade', (req, socket, head) => {
    upgrades++;
    if (redirect)
      socket.end(
        'HTTP/1.1 302 Found\r\nLocation: /wrong-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    else if (rawServer)
      rawServer.handleUpgrade(req, socket, head, (ws) => rawServer.emit('connection', ws));
    else service.upgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = {
    url: `wss://127.0.0.1:${server.address().port}/ws`,
    token,
    fingerprint: untrustedCa
      ? undefined
      : wrongPin
        ? '11'.repeat(32)
        : new X509Certificate(defaultCertificate.cert).fingerprint256,
  };
  const proxy = await openBrowserNetworkProxy(config, timing);
  t.after(async () => {
    await proxy.close();
    service.close();
    for (const ws of rawServer?.clients ?? []) ws.terminate();
    for (const socket of targets) socket.destroy();
    await Promise.all([
      new Promise((r) => server.close(r)),
      new Promise((r) => websiteServer.close(r)),
    ]);
  });
  return { proxy, config, authFrames, dials: () => dials, upgrades: () => upgrades, service };
}

test('network proxy fixes the authenticated service path and rejects injected addresses', () => {
  assert.equal(
    browserProxyAddress('wss://127.0.0.1:8443/ws').href,
    'wss://127.0.0.1:8443/cc-browser/v2/connect',
  );
  for (const value of [
    'ws://x/ws',
    'https://claude.ai/',
    'wss://u:p@x/ws',
    'wss://x/ws?target=x',
    'wss://x/ws#x',
  ])
    assert.throws(() => browserProxyAddress(value));
});

test('local proxy credentials are random and missing or incorrect credentials never reach the remote', async (t) => {
  const f = await fixture(t);
  const other = await openBrowserNetworkProxy(f.config);
  t.after(() => other.close());
  assert.notEqual(f.proxy.password, other.password);
  assert.equal(f.proxy.proxyBypassRules, '<-loopback>');
  assert.ok(!f.proxy.proxyRules.includes('DIRECT'));
  for (const authorization of [null, 'Basic wrong']) {
    const result = await tunnel(f.proxy, { authorization });
    assert.equal(result.response.statusCode, 407);
    result.socket.destroy();
  }
  assert.equal(f.upgrades(), 0);
});

test('plaintext requests and invalid CONNECT targets are refused without remote dialing', async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${f.proxy.port}/`, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
  for (const target of [
    website + ':80',
    '127.0.0.1:443',
    '[::1]:443',
    'localhost:443',
    'user@' + website + ':443',
  ]) {
    const result = await tunnel(f.proxy, { target });
    assert.equal(result.response.statusCode, 403);
    result.socket.destroy();
  }
  assert.equal(f.upgrades(), 0);
});

test('owned website TLS and data pass through the authenticated CC channel with the original site certificate', async (t) => {
  const f = await fixture(t);
  const result = await tunnel(f.proxy);
  assert.equal(result.response.statusCode, 200);
  assert.equal(result.head.length, 0);
  const tls = connectTls({ socket: result.socket, servername: website, ca });
  tls.on('error', () => {});
  try {
    await once(tls, 'secureConnect');
    assert.equal(tls.authorized, true);
    assert.equal(
      tls.getPeerCertificate().fingerprint256,
      new X509Certificate(custom.cert).fingerprint256,
    );
    const data = once(tls, 'data');
    tls.write('private-owned-site-test');
    assert.equal((await data)[0].toString(), 'private-owned-site-test');
    assert.equal(f.dials(), 1);
  } finally {
    tls.destroy();
  }
});

test('wrong service fingerprint or an untrusted service CA receives zero credentials', async (t) => {
  for (const options of [{ wrongPin: true }, { untrustedCa: true }]) {
    const f = await fixture(t, { ...options, raw: true });
    const result = await tunnel(f.proxy);
    assert.equal(result.response.statusCode, 502);
    result.socket.destroy();
    assert.deepEqual(f.authFrames, []);
  }
});

test('redirects and missing readiness fail without alternate local or remote requests', async (t) => {
  for (const options of [{ redirect: true }, { raw: true, silent: true }]) {
    const f = await fixture(t, { ...options, connectTimeoutMs: 80 });
    const result = await tunnel(f.proxy);
    assert.equal(result.response.statusCode, 502);
    result.socket.destroy();
    assert.equal(f.upgrades(), 1);
    assert.equal(f.dials(), 0);
  }
});

test('remote shutdown closes the existing local tunnel without reconnecting or falling back', async (t) => {
  const f = await fixture(t);
  const result = await tunnel(f.proxy);
  assert.equal(result.response.statusCode, 200);
  const closed = once(result.socket, 'close');
  result.socket.on('error', () => {});
  f.service.close();
  result.socket.resume();
  await closed;
  assert.equal(f.dials(), 1);
  assert.equal(f.upgrades(), 1);
});

test('closing is idempotent and releases incomplete HTTP and established connections', async (t) => {
  const f = await fixture(t);
  const incomplete = connect({ host: '127.0.0.1', port: f.proxy.port });
  incomplete.on('error', () => {});
  await once(incomplete, 'connect');
  const result = await tunnel(f.proxy);
  assert.equal(result.response.statusCode, 200);
  result.socket.on('error', () => {});
  result.socket.resume();
  const ended = once(result.socket, 'close');
  await Promise.all([f.proxy.close(), f.proxy.close()]);
  await ended;
  incomplete.destroy();
});

test(
  'closing a browser proxy releases its pending upstream HTTP CONNECT socket',
  { timeout: 3000 },
  async (t) => {
    let entered;
    const received = new Promise((resolve) => {
      entered = resolve;
    });
    const sockets = new Set();
    const upstream = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', entered);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      upstream.close();
    });
    const f = await fixture(t, {
      resolveProxy: () => `PROXY 127.0.0.1:${upstream.address().port}`,
    });
    const pending = tunnel(f.proxy).catch(() => null);
    await received;
    await f.proxy.close();
    (await pending)?.socket.destroy();
    for (let index = 0; sockets.size && index < 50; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      sockets.size,
      0,
      'closing the browser must reclaim the upstream socket before its timeout',
    );
  },
);

test('browser-origin CONNECT is refused even with valid local credentials', async (t) => {
  const f = await fixture(t);
  const result = await tunnel(f.proxy, { origin: 'https://unrelated.example' });
  assert.equal(result.response.statusCode, 403);
  result.socket.destroy();
  assert.equal(f.upgrades(), 0);
});

test(
  'a ready gateway that stops answering heartbeat closes the tunnel',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t, { raw: true, noPong: true, heartbeatMs: 30 });
    const result = await tunnel(f.proxy);
    assert.equal(result.response.statusCode, 200);
    result.socket.on('error', () => {});
    result.socket.resume();
    await once(result.socket, 'close');
    assert.equal(f.upgrades(), 1);
  },
);

test(
  'close cancels pending proxy resolution and a late result cannot dial the gateway',
  { timeout: 3000 },
  async (t) => {
    let release;
    let resolving;
    const entered = new Promise((resolve) => {
      resolving = resolve;
    });
    const f = await fixture(t, {
      resolveProxy: () => {
        resolving();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = tunnel(f.proxy).catch(() => null);
    await entered;
    await f.proxy.close();
    release('DIRECT');
    const result = await pending;
    result?.socket.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.upgrades(), 0);
  },
);

test(
  'large owned-site response survives a paused reader and target EOF byte for byte',
  { timeout: 15000 },
  async (t) => {
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    const f = await fixture(t, {
      websiteHandler: (socket) => socket.once('data', () => socket.end(payload)),
    });
    const result = await tunnel(f.proxy);
    assert.equal(result.response.statusCode, 200);
    const tls = connectTls({ socket: result.socket, servername: website, ca });
    tls.on('error', () => {});
    t.after(() => tls.destroy());
    await once(tls, 'secureConnect');
    tls.pause();
    tls.write('owned-site-download');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const chunks = [];
    for await (const chunk of tls) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
  },
);

test('untrusted website certificate is still rejected inside a trusted service tunnel', async (t) => {
  const f = await fixture(t);
  const result = await tunnel(f.proxy);
  assert.equal(result.response.statusCode, 200);
  const tls = connectTls({ socket: result.socket, servername: website });
  t.after(() => tls.destroy());
  await assert.rejects(once(tls, 'secureConnect'), /certificate|issuer/i);
});

test(
  'client FIN cancels a pending CONNECT before a delayed resolver can dial',
  { timeout: 3000 },
  async (t) => {
    let release, entered;
    const resolving = new Promise((resolve) => {
      entered = resolve;
    });
    const f = await fixture(t, {
      resolveProxy: () => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const socket = connect({ host: '127.0.0.1', port: f.proxy.port });
    socket.on('error', () => {});
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.write(
      `CONNECT ${website}:443 HTTP/1.1\r\nHost: ${website}:443\r\nProxy-Authorization: ${auth(f.proxy)}\r\n\r\n`,
    );
    await resolving;
    socket.end();
    socket.resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release('DIRECT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.upgrades(), 0);
    assert.equal(f.dials(), 0);
  },
);

test(
  'pipelined CONNECT bytes are preserved and excessive early bytes fail closed',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t, {
      raw: true,
      onRawReady: (ws) => ws.on('message', (data) => ws.send(data)),
    });
    // This raw gateway is an owned byte echo, not a TLS website.
    // Keep the initial bytes in the same write as HTTP headers to exercise CONNECT head.
    for (const size of [1024, 65 * 1024]) {
      const socket = connect({ host: '127.0.0.1', port: f.proxy.port });
      socket.on('error', () => {});
      t.after(() => socket.destroy());
      await once(socket, 'connect');
      const chunks = [];
      const response = new Promise((resolve) =>
        socket.on('data', (chunk) => {
          chunks.push(chunk);
          const data = Buffer.concat(chunks);
          const end = data.indexOf('\r\n\r\n');
          if (end >= 0 && (size !== 1024 || data.length >= end + 4 + size)) resolve(data);
        }),
      );
      socket.write(
        Buffer.concat([
          Buffer.from(
            `CONNECT ${website}:443 HTTP/1.1\r\nProxy-Authorization: ${auth(f.proxy)}\r\n\r\n`,
          ),
          Buffer.alloc(size, 0x4b),
        ]),
      );
      if (size === 1024) {
        const data = await response;
        assert.match(data.toString(), /^HTTP\/1.1 200/);
        assert.deepEqual(data.subarray(data.indexOf('\r\n\r\n') + 4), Buffer.alloc(size, 0x4b));
      } else {
        // The limit includes head plus subsequent bytes received before ready.
        assert.match((await response).toString(), /^HTTP\/1.1 (403|502)/);
      }
      socket.destroy();
    }
  },
);

test(
  'normal gateway EOF drains all bytes to a throttled local reader',
  { timeout: 10000 },
  async (t) => {
    const payload = Buffer.alloc(256 * 1024, 0x6e);
    const f = await fixture(t, {
      raw: true,
      onRawReady: (ws) => {
        for (let index = 0; index < 64; index++) ws.send(payload);
        ws.close();
      },
    });
    const result = await tunnel(f.proxy);
    assert.equal(result.response.statusCode, 200);
    const chunks = [result.head];
    result.socket.on('error', () => {});
    const ended = new Promise((resolve) => {
      result.socket.once('end', resolve);
      result.socket.once('close', resolve);
    });
    const read = () => {
      const chunk = result.socket.read(65536);
      if (chunk) chunks.push(chunk);
    };
    result.socket.on('readable', () => {});
    const timer = setInterval(read, 5);
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      result.socket.destroy();
    }, 6000);
    t.after(() => {
      clearInterval(timer);
      result.socket.destroy();
    });
    await ended;
    clearTimeout(watchdog);
    clearInterval(timer);
    let rest;
    while ((rest = result.socket.read()) !== null) chunks.push(rest);
    const received = Buffer.concat(chunks);
    assert.equal(received.length, payload.length * 64);
    assert.ok(received.equals(Buffer.alloc(payload.length * 64, 0x6e)));
    assert.equal(timedOut, false, 'normal EOF must finish without forced socket destruction');
  },
);

test(
  'completed remote EOF releases quota even if local clients keep their writable half open',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, {
      raw: true,
      onRawReady: (ws) => {
        ws.send(Buffer.from('done'));
        ws.close();
      },
    });
    const clients = [];
    t.after(() => clients.forEach((socket) => socket.destroy()));
    for (let index = 0; index < 66; index++) {
      const socket = connect({ host: '127.0.0.1', port: f.proxy.port, allowHalfOpen: true });
      clients.push(socket);
      socket.on('error', () => {});
      const chunks = [];
      socket.on('data', (data) => chunks.push(data));
      const ended = new Promise((resolve) => {
        socket.once('end', resolve);
        socket.once('close', resolve);
      });
      socket.write(
        `CONNECT ${website}:443 HTTP/1.1\r\nProxy-Authorization: ${auth(f.proxy)}\r\n\r\n`,
      );
      await ended;
      assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 200/);
    }
  },
);
