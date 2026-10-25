import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net';
import { createServer as createTlsServer, connect as connectTls } from 'node:tls';
import { createServer as createHttpsServer } from 'node:https';
import { get as getHttps } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, createWebSocketStream } from 'ws';
import { createBrowserProxy, type BrowserProxyOptions } from '../src/browser-proxy.ts';
import {
  browserProxyHost,
  publicBrowserAddress,
  resolveBrowserTarget,
} from '../src/browser-proxy-target.ts';
import { ca, custom, defaultCertificate } from './fixtures/web-certificates.ts';
import { createProxyServer } from '../src/server.ts';
import { environmentConfig } from '../src/config.ts';

const token = 'offline-browser-proxy-test-credential';
const host = 'default.example.test';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('browser proxy permits ordinary public IPs and rejects local, reserved and transition addresses', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '104.18.1.1', '2606:4700::1111', '2001:4860:4860::8888'])
    assert.equal(publicBrowserAddress(ip), true, ip);
  for (const ip of [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.9',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2001::1',
    '2001:20::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    'fe80::1%eth0',
    'not-an-ip',
  ])
    assert.equal(publicBrowserAddress(ip), false, ip);
});

test('browser proxy accepts exact DNS names, without URLs, IP literals, wildcards or ambiguous hosts', () => {
  assert.equal(browserProxyHost('CLAUDE.AI'), 'claude.ai');
  for (const value of [
    '',
    'localhost',
    '127.0.0.1',
    '[::1]',
    '*.claude.ai',
    'claude.ai.',
    ' claude.ai',
    'https://claude.ai',
    'user@claude.ai',
    'claude.ai/path',
    'claude.ai:443',
    'claude..ai',
    '-a.test',
    'a-.test',
    '中文.test',
    'K.test',
    'claude.ai\n',
    'claude.ai\r',
    'claude.ai\0',
    'a'.repeat(64) + '.test',
  ])
    assert.throws(() => browserProxyHost(value));
});

test('target policy checks exact host and port before DNS, then validates every address and pins one', async () => {
  let lookups = 0;
  const lookup = async () => {
    lookups++;
    return [{ address: '1.1.1.1', family: 4 }];
  };
  const allowed = new Set([host]);
  for (const [name, port] of [
    ['other.test', 443],
    [host, 80],
    [host, '443'],
    ['127.0.0.1', 443],
  ] as const)
    await assert.rejects(resolveBrowserTarget(name, port, allowed, lookup));
  assert.equal(lookups, 0);
  assert.deepEqual(await resolveBrowserTarget(host, 443, allowed, lookup), {
    address: '1.1.1.1',
    family: 4,
    port: 443,
  });
  for (const answers of [
    [],
    [{ address: '10.0.0.1', family: 4 }],
    [
      { address: '1.1.1.1', family: 4 },
      { address: '::ffff:127.0.0.1', family: 6 },
    ],
    [{ address: '1.1.1.1', family: 6 }],
  ])
    await assert.rejects(resolveBrowserTarget(host, 443, allowed, async () => answers));
});

async function fixture(t: TestContext, options: Partial<BrowserProxyOptions> = {}, tls = false) {
  let lookups = 0,
    dials = 0,
    received = 0;
  const targets = new Set<Socket>();
  const target = createTcpServer((socket) => {
    targets.add(socket);
    socket.once('close', () => targets.delete(socket));
    socket.on('data', (chunk) => (received += chunk.length));
    socket.pipe(socket);
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const proxy = createBrowserProxy({
    token,
    hosts: [host],
    lookup: async () => {
      lookups++;
      return [{ address: '1.1.1.1', family: 4 }];
    },
    dial: (target) => {
      dials++;
      assert.deepEqual(target, { address: '1.1.1.1', family: 4, port: 443 });
      return connect({ host: '127.0.0.1', port: (targetServer.address() as AddressInfo).port });
    },
    ...options,
  });
  const targetServer = target;
  const handler: RequestListener = (req, res) => {
    if (!proxy.handle(req, res)) res.writeHead(404).end();
  };
  const server = tls ? createHttpsServer(defaultCertificate, handler) : createServer(handler);
  server.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `${tls ? 'wss' : 'ws'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    proxy.close();
    for (const socket of targets) socket.destroy();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => target.close(r))]);
  });
  async function open() {
    const ws = new WebSocket(origin + '/cc-browser/v2/connect', { rejectUnauthorized: false });
    ws.on('error', () => {});
    await once(ws, 'open');
    return ws;
  }
  return {
    proxy,
    server,
    origin,
    open,
    lookups: () => lookups,
    dials: () => dials,
    received: () => received,
    targets,
  };
}

test('unauthenticated, unconfigured and blocked connections never resolve DNS or dial a target', async (t) => {
  for (const [options, credential] of [
    [{}, 'wrong'],
    [{ hosts: [] }, token],
    [{ blocked: () => 'moderation-required' }, token],
    [{ blocked: () => 'maintenance' }, token],
  ] as [Partial<BrowserProxyOptions>, string][]) {
    const f = await fixture(t, options);
    const ws = await f.open();
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'connect', token: credential, host, port: 443 }));
    assert.ok([1008, 1013].includes((await closed)[0]));
    assert.equal(f.lookups(), 0);
    assert.equal(f.dials(), 0);
  }
});

test('malformed first frames and rejected targets close without target dialing', async (t) => {
  const f = await fixture(t);
  for (const frame of [
    'null',
    '[]',
    '{',
    JSON.stringify({ type: 'connect', token, host: 'other.test', port: 443 }),
    JSON.stringify({ type: 'connect', token, host, port: 80 }),
  ]) {
    const ws = await f.open();
    const closed = once(ws, 'close');
    ws.send(frame);
    await closed;
  }
  assert.equal(f.lookups(), 0);
  assert.equal(f.dials(), 0);
});

test('binary traffic uses backpressure and a closing client releases its target connection', async (t) => {
  const f = await fixture(t);
  const ws = await f.open();
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
  assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
  const stream = createWebSocketStream(ws);
  const chunks: Buffer[] = [];
  const expected = Buffer.alloc(1024 * 1024, 0x53);
  let received = 0;
  const complete = new Promise<void>((resolve) => {
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received === expected.length) resolve();
    });
  });
  for (let offset = 0; offset < expected.length; offset += 64 * 1024)
    stream.write(expected.subarray(offset, offset + 64 * 1024));
  await complete;
  assert.deepEqual(Buffer.concat(chunks), expected);
  ws.terminate();
  for (let i = 0; i < 100 && f.targets.size; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.targets.size, 0);
});

test('an expired or cancelled DNS lookup cannot create a late target connection', async (t) => {
  for (const cancel of [false, true]) {
    let release!: (value: { address: string; family: number }[]) => void;
    const dns = new Promise<{ address: string; family: number }[]>((r) => (release = r));
    const f = await fixture(t, { lookup: () => dns, connectTimeoutMs: 50 });
    const ws = await f.open();
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
    if (cancel) {
      await tick();
      ws.terminate();
    }
    await closed;
    release([{ address: '1.1.1.1', family: 4 }]);
    await tick();
    await tick();
    assert.equal(f.dials(), 0);
  }
});

test('maintenance starting during DNS and pipelined pre-ready frames cannot open a target', async (t) => {
  for (const earlyFrame of [false, true]) {
    let release!: (value: { address: string; family: number }[]) => void;
    let blocked: string | undefined;
    const dns = new Promise<{ address: string; family: number }[]>((r) => (release = r));
    let entered!: () => void;
    const resolving = new Promise<void>((r) => (entered = r));
    const f = await fixture(t, {
      lookup: () => {
        entered();
        return dns;
      },
      blocked: () => blocked,
    });
    const ws = await f.open();
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
    await resolving;
    if (earlyFrame) {
      ws.send(Buffer.from('early data'));
      await closed;
    } else blocked = 'maintenance';
    release([{ address: '1.1.1.1', family: 4 }]);
    await closed;
    await tick();
    assert.equal(f.dials(), 0);
  }
});

test('silent authentication, mixed private DNS and post-ready text are rejected', async (t) => {
  const silent = await fixture(t, { authTimeoutMs: 40 });
  const silentWs = await silent.open();
  await once(silentWs, 'close');
  assert.equal(silent.dials(), 0);
  const mixed = await fixture(t, {
    lookup: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
  });
  const ws = await mixed.open();
  const denied = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
  await denied;
  assert.equal(mixed.dials(), 0);
  const f = await fixture(t);
  const text = await f.open();
  const ready = once(text, 'message');
  text.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
  await ready;
  const closed = once(text, 'close');
  text.send('forbidden text');
  await closed;
  await tick();
  assert.equal(f.received(), 0);
});

test('status authentication and forbidden origins never contact DNS or a target', async (t) => {
  const f = await fixture(t);
  const address = f.origin.replace('ws:', 'http:') + '/cc-browser/v2/status';
  assert.equal((await fetch(address)).status, 401);
  assert.equal(
    (await fetch(address, { headers: { authorization: `Bearer ${token}`, origin: 'null' } }))
      .status,
    403,
  );
  assert.deepEqual(
    await (await fetch(address, { headers: { authorization: `Bearer ${token}` } })).json(),
    { schema: 2, enabled: true, reason: 'available' },
  );
  const ws = new WebSocket(f.origin + '/cc-browser/v2/connect', { origin: 'file://' });
  ws.on('error', () => {});
  const [, response] = await once(ws, 'unexpected-response');
  assert.equal(response.statusCode, 403);
  response.resume();
  ws.terminate();
  assert.equal(f.lookups(), 0);
  assert.equal(f.dials(), 0);
});

test('pending sign-ins are bounded and failed sign-ins share status throttling', async (t) => {
  const f = await fixture(t, { authTimeoutMs: 500 });
  const pending: WebSocket[] = [];
  for (let i = 0; i < 4; i++) pending.push(await f.open());
  const denied = new WebSocket(f.origin + '/cc-browser/v2/connect');
  denied.on('error', () => {});
  const [, response] = await once(denied, 'unexpected-response');
  assert.equal(response.statusCode, 429);
  response.resume();
  denied.terminate();
  for (const ws of pending) ws.terminate();
  for (let i = 0; i < 50 && f.proxy.busy(); i++) await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 6; i++) {
    const ws = await f.open();
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ type: 'connect', token: 'wrong', host, port: 443 }));
    await closed;
  }
  assert.equal(
    (
      await fetch(f.origin.replace('ws:', 'http:') + '/cc-browser/v2/status', {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    429,
  );
  assert.equal(f.lookups(), 0);
});

test('target EOF preserves all response bytes and service close releases established targets', async (t) => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x63);
  const target = createTcpServer((socket) => socket.end(bytes));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise<void>((r) => target.close(() => r())));
  const f = await fixture(t, {
    dial: () => connect({ host: '127.0.0.1', port: (target.address() as AddressInfo).port }),
  });
  const ws = await f.open();
  const chunks: Buffer[] = [];
  const completed = new Promise<void>((resolve, reject) => {
    let received = 0;
    ws.on('message', (data, binary) => {
      if (binary) {
        const chunk = Buffer.from(data as Buffer);
        chunks.push(chunk);
        received += chunk.length;
      }
      if (received === bytes.length) resolve();
    });
    ws.once('close', () => {
      if (received !== bytes.length) reject(new Error('Truncated target response'));
    });
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
  await completed;
  assert.deepEqual(Buffer.concat(chunks), bytes);
  ws.terminate();
  const active = await fixture(t);
  const peer = await active.open();
  const ready = once(peer, 'message');
  peer.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
  await ready;
  const closed = once(peer, 'close');
  active.proxy.close();
  await closed;
  for (let i = 0; i < 100 && active.targets.size; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(active.targets.size, 0);
});

test('website TLS survives the encrypted proxy unchanged and is verified by its own CA', async (t) => {
  const target = createTlsServer(custom, (socket) => socket.pipe(socket));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise<void>((r) => target.close(() => r())));
  const f = await fixture(
    t,
    { dial: () => connect({ host: '127.0.0.1', port: (target.address() as AddressInfo).port }) },
    true,
  );
  const ws = await f.open();
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
  await ready;
  const stream = createWebSocketStream(ws);
  stream.on('error', () => {});
  const tls = connectTls({ socket: stream as unknown as Socket, servername: host, ca });
  tls.on('error', () => {});
  try {
    await once(tls, 'secureConnect');
    assert.equal(tls.authorized, true);
    assert.equal(
      tls.getPeerCertificate().fingerprint256,
      new X509Certificate(custom.cert).fingerprint256,
    );
    const echoed = once(tls, 'data');
    tls.write('owned-test-site');
    assert.equal((await echoed)[0].toString(), 'owned-test-site');
  } finally {
    tls.destroy();
    ws.terminate();
  }
});

test('configuration keeps proxy disabled by default and validates administrator DNS names', () => {
  assert.equal(environmentConfig({}, '/state').options.browserProxyHosts, undefined);
  assert.deepEqual(
    environmentConfig({ PROXY_BROWSER_PROXY_HOSTS: 'DEFAULT.EXAMPLE.TEST,other.test' }, '/state')
      .options.browserProxyHosts,
    [host, 'other.test'],
  );
  for (const value of ['*.test', host + ',', '127.0.0.1', 'https://claude.ai', 'localhost'])
    assert.throws(() => environmentConfig({ PROXY_BROWSER_PROXY_HOSTS: value }, '/state'));
});

test('full TLS CC service exposes v2 status and preserves default, moderation and maintenance gates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-proxy-gate-'));
  const unused = async (): Promise<never> => {
    throw new Error('No managed operation expected');
  };
  try {
    for (const reason of ['not-configured', 'available', 'moderation-required', 'maintenance']) {
      let reviews = 0;
      const service = createProxyServer({
        token,
        dataDir: join(directory, reason),
        tls: {
          cert: Buffer.from(defaultCertificate.cert),
          key: Buffer.from(defaultCertificate.key),
        },
        browserProxyHosts: reason === 'not-configured' ? undefined : [host],
        moderation:
          reason === 'moderation-required'
            ? {
                endpoint: 'https://review.example.invalid/cc-updates/v1/moderation/check',
                nodeId: 'offline-proxy-gate',
                token: 'offline-proxy-review-token-12345678901234567',
                fetcher: async () => {
                  reviews++;
                  throw new Error('No review request expected');
                },
              }
            : undefined,
        managed:
          reason === 'maintenance'
            ? {
                initialMaintenance: true,
                backend: {
                  check: unused,
                  status: unused,
                  prepare: unused,
                  activate: () => {
                    throw new Error('No install expected');
                  },
                },
              }
            : undefined,
      });
      try {
        const origin = await service.listen(0);
        const body = await new Promise<string>((resolve, reject) => {
          getHttps(
            origin + '/cc-browser/v2/status',
            {
              rejectUnauthorized: false,
              headers: { authorization: `Bearer ${token}` },
            },
            (res) => {
              if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Unexpected proxy status ${res.statusCode}`));
                return;
              }
              let result = '';
              res.on('data', (chunk) => (result += chunk));
              res.on('end', () => resolve(result));
            },
          ).on('error', reject);
        });
        assert.deepEqual(JSON.parse(body), { schema: 2, enabled: reason === 'available', reason });
        if (reason !== 'available') {
          const ws = new WebSocket(origin.replace('https:', 'wss:') + '/cc-browser/v2/connect', {
            rejectUnauthorized: false,
          });
          ws.on('error', () => {});
          await once(ws, 'open');
          const closed = once(ws, 'close');
          ws.send(JSON.stringify({ type: 'connect', token, host, port: 443 }));
          assert.equal((await closed)[0], 1013);
        }
        assert.equal(reviews, 0);
      } finally {
        await service.close();
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
