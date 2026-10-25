import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { createServer as tcpServer, connect } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { custom } from '../../server/test/fixtures/web-certificates.ts';
import { connectService } from '../electron/secure-service.mjs';
import { openBrowserNetworkProxy } from '../electron/browser-network-proxy.mjs';
const require = createRequire(import.meta.url);
const { createManagedFetch, createSystemProxyResolver } = require('../electron/managed-fetch.cjs');
const executable = require('electron');
let testDirectory;
const app = {
  isPackaged: false,
  getPath: () => testDirectory || tmpdir(),
  getAppPath: () => resolve('apps/desktop/test-electron/fixtures/managed-fetch.cjs'),
};
const makeFetch = (origin) => createManagedFetch({ app, origin, executable });
function environment(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function waitProxyEvaluations(count) {
  for (let retry = 0; retry < 150; retry++) {
    const profiles = await readdir(testDirectory);
    const entered = await Promise.all(
      profiles.map((name) =>
        access(join(testDirectory, name, 'proxy-evaluation-started')).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (entered.filter(Boolean).length === count) return profiles.filter((_name, i) => entered[i]);
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail('Expected proxy evaluations did not start');
}

async function fixture(t, trusted = true) {
  const root = await mkdtemp(resolve('.local/managed-helper-test-'));
  testDirectory = root;
  const noProfiles = async () => {
    for (let retry = 0; retry < 100 && (await readdir(root)).length; retry++)
      await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(await readdir(root), [], 'Update helper profiles must be removed');
  };
  if (trusted)
    environment(t, 'CC_TEST_UPDATE_SITE_PIN', new X509Certificate(custom.cert).fingerprint256);
  const requests = [],
    sockets = new Set(),
    truncatedResponses = new Set();
  const site = createServer(custom, (req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (req.url === '/redirect')
      res.writeHead(302, { Location: 'https://other.example.test/not-followed' }).end();
    else if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Length': 1024 * 1024 });
      res.write(Buffer.alloc(65536, 'x'));
    } else if (req.url === '/truncated') {
      res.writeHead(200, { 'Content-Length': 1024 * 1024 });
      res.write(Buffer.alloc(65536, 'x'));
      truncatedResponses.add(res);
    } else if (req.url === '/empty') res.writeHead(204).end();
    else if (req.url === '/large') res.end(Buffer.alloc(8 * 1024 * 1024, 'z'));
    else {
      res.writeHead(req.headers.range ? 206 : 200, { 'Content-Type': 'text/plain' });
      res.write('owned-');
      res.end('update');
    }
  });
  site.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => site.close(done));
    testDirectory = undefined;
    await noProfiles();
    await rm(root, { recursive: true, force: true });
  });
  return {
    origin: 'https://default.example.test:' + site.address().port,
    requests,
    sockets,
    site,
    noProfiles,
    truncate: () => {
      for (const response of truncatedResponses) response.destroy();
    },
  };
}

test('managed fetch refuses other origins, credentials, plaintext and non-GET before launching a helper', async () => {
  const fetch = makeFetch('https://updates.example.test');
  for (const target of [
    'http://updates.example.test/',
    'https://other.example.test/',
    'https://updates.example.test:444/',
    'https://u:p@updates.example.test/',
  ]) {
    await assert.rejects(fetch(target), /origin|HTTPS|credentials/);
  }
  await assert.rejects(fetch('https://updates.example.test/', { method: 'POST' }), /GET/);
});

test('managed helper rejects an untrusted website certificate before HTTP', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(makeFetch(f.origin)(f.origin + '/'), /certificate|fetch|ERR_CERT/i);
  assert.deepEqual(f.requests, []);
});

test('managed helper streams GET and Range through actual main helper entry without cookies', async (t) => {
  const f = await fixture(t);
  const response = await makeFetch(f.origin)(f.origin + '/artifact', {
    headers: { Range: 'bytes=10-' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await response.text(), 'owned-update');
  assert.equal(f.requests[0].headers.range, 'bytes=10-');
  assert.equal(f.requests[0].headers.cookie, undefined);
});

test('managed helper returns redirects without following them', async (t) => {
  const f = await fixture(t);
  const response = await makeFetch(f.origin)(f.origin + '/redirect');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://other.example.test/not-followed');
  await response.body.cancel();
  assert.equal(f.requests.length, 1);
});

test('managed helper cancellation after headers releases the unfinished response connection', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const response = await makeFetch(f.origin)(f.origin + '/slow', { signal: controller.signal });
  const closed = Promise.all([...f.sockets].map((socket) => once(socket, 'close')));
  const text = response.text();
  controller.abort();
  await assert.rejects(text);
  await closed;
  assert.equal(f.sockets.size, 0);
});

test('managed helper body cancellation closes the response and truncated bodies reject', async (t) => {
  const f = await fixture(t);
  const response = await makeFetch(f.origin)(f.origin + '/slow');
  const closed = Promise.all([...f.sockets].map((socket) => once(socket, 'close')));
  await response.body.cancel();
  await closed;
  const truncated = await makeFetch(f.origin)(f.origin + '/truncated');
  const reading = truncated.text();
  f.truncate(); // Cut a real response after headers, independent of scheduling.
  await assert.rejects(reading);
});

test('managed helper honors PAC dnsResolve and HTTP CONNECT without a DIRECT fallback', async (t) => {
  const f = await fixture(t),
    connections = [],
    sockets = new Set();
  const proxy = tcpServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    client.once('data', (header) => {
      connections.push(header.toString().split('\r\n')[0]);
      if (connections.length > 1) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const upstream = connect(f.site.address().port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => proxy.close(done));
  });
  const script =
    'function FindProxyForURL(url,host){return dnsResolve(host)==="127.0.0.1" ? "PROXY 127.0.0.1:' +
    proxy.address().port +
    '" : "PROXY 127.0.0.1:1";}';
  environment(
    t,
    'CC_TEST_UPDATE_PROXY',
    JSON.stringify({
      mode: 'pac_script',
      pacScript: 'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent(script),
    }),
  );
  assert.equal(await (await makeFetch(f.origin)(f.origin + '/proxied')).text(), 'owned-update');
  await assert.rejects(makeFetch(f.origin)(f.origin + '/refused'), /fetch|ERR_TUNNEL/i);
  assert.equal(f.requests.length, 1);
  assert.equal(connections.length, 2);
});

test('managed helper preserves SOCKS5 instead of silently connecting DIRECT', async (t) => {
  const f = await fixture(t),
    sockets = new Set(),
    targets = [];
  const proxy = tcpServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    let stage = 'greeting',
      buffer = Buffer.alloc(0);
    const read = (part) => {
      buffer = Buffer.concat([buffer, part]);
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < buffer[1] + 2) return;
        buffer = buffer.subarray(buffer[1] + 2);
        stage = 'request';
        client.write(Buffer.from([5, 0]));
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        const size = buffer[3] === 3 ? 7 + buffer[4] : 10;
        if (buffer.length < size) return;
        targets.push(buffer[3] === 3 ? buffer.subarray(5, size - 2).toString() : 'ipv4');
        const upstream = connect(f.site.address().port, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.off('data', read);
          client.pipe(upstream).pipe(client);
        });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        stage = 'tunnel';
      }
    };
    client.on('data', read);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => proxy.close(done));
  });
  environment(
    t,
    'CC_TEST_UPDATE_PROXY',
    JSON.stringify({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:' + proxy.address().port,
    }),
  );
  assert.equal(await (await makeFetch(f.origin)(f.origin + '/socks')).text(), 'owned-update');
  assert.deepEqual(targets, ['default.example.test']);
});

test('managed helper handles empty responses and slow reads without truncating large content', async (t) => {
  const f = await fixture(t);
  const empty = await makeFetch(f.origin)(f.origin + '/empty');
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
  const response = await makeFetch(f.origin)(f.origin + '/large');
  const reader = response.body.getReader();
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    assert.ok(value.every((byte) => byte === 122));
    bytes += value.length;
    await new Promise((done) => setTimeout(done, bytes < 65537 ? 50 : 1));
  }
  assert.equal(bytes, 8 * 1024 * 1024);
});

test('managed helper spawn failure rejects and releases its timer', async () => {
  const fetch = createManagedFetch({
    app,
    origin: 'https://updates.example.test',
    executable: resolve('.local/nonexistent-update-helper.exe'),
  });
  await assert.rejects(fetch('https://updates.example.test/'), /ENOENT/);
});

test('managed helper packaged branch enforces the embedded origin and cleans completed profiles', async (t) => {
  const f = await fixture(t);
  environment(t, 'CC_TEST_UPDATE_PACKAGED_ORIGIN', 'https://different.example.test');
  await assert.rejects(makeFetch(f.origin)(f.origin + '/'), /origin refused/);
  assert.deepEqual(f.requests, []);
  process.env.CC_TEST_UPDATE_PACKAGED_ORIGIN = f.origin;
  assert.equal(await (await makeFetch(f.origin)(f.origin + '/')).text(), 'owned-update');
  await f.noProfiles();
});

test('managed helper fast reads preserve a complete large response', async (t) => {
  const f = await fixture(t);
  environment(t, 'CC_TEST_UPDATE_DELAY_SEND_CALLBACK', '1');
  const response = await makeFetch(f.origin)(f.origin + '/large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 8 * 1024 * 1024);
  assert.ok(bytes.every((byte) => byte === 122));
  await f.noProfiles();
});

test('isolated system proxy resolution preserves PAC DNS without requesting the service', async (t) => {
  const f = await fixture(t);
  const pac =
    'function FindProxyForURL(url,host){return dnsResolve("localhost") ? "PROXY 127.0.0.1:19001" : "PROXY 127.0.0.1:19002";}';
  environment(
    t,
    'CC_TEST_UPDATE_PROXY',
    JSON.stringify({
      mode: 'pac_script',
      pacScript: 'data:application/x-ns-proxy-autoconfig,' + encodeURIComponent(pac),
    }),
  );
  const resolveProxy = createSystemProxyResolver({ app, executable });
  assert.equal(await resolveProxy(f.origin), 'PROXY 127.0.0.1:19001');
  assert.equal(await resolveProxy(f.origin.replace('https:', 'wss:')), 'PROXY 127.0.0.1:19001');
  await assert.rejects(resolveProxy('http://default.example.test/'), /HTTPS|WSS/);
  assert.deepEqual(f.requests, []);
  await f.noProfiles();
});

test('service cancellation reclaims stalled proxy helpers and bounds concurrent processes', async (t) => {
  const f = await fixture(t);
  environment(t, 'CC_TEST_UPDATE_STALL_PROXY', '1');
  const resolver = createSystemProxyResolver({ app, executable });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map(({ signal }) =>
    connectService(new URL(f.origin), {}, resolver, undefined, signal),
  );
  const settled = Promise.allSettled(requests);
  try {
    const initial = await waitProxyEvaluations(2);
    assert.equal((await readdir(testDirectory)).length, 2, 'At most two proxy helpers may start');
    controllers[2].abort(); // Cancel one queued task, retaining the fourth.
    await assert.rejects(requests[2]);
    controllers[0].abort();
    await assert.rejects(requests[0]);
    let advanced = false;
    for (let retry = 0; retry < 150; retry++) {
      const profiles = await readdir(testDirectory);
      const newProfiles = profiles.filter((name) => !initial.includes(name));
      if (
        newProfiles.length &&
        (await access(join(testDirectory, newProfiles[0], 'proxy-evaluation-started')).then(
          () => true,
          () => false,
        ))
      ) {
        assert.equal(
          profiles.length,
          2,
          'The remaining queued task starts after a slot is reclaimed',
        );
        advanced = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(advanced, true);
  } finally {
    controllers.forEach((controller) => controller.abort());
    await settled;
  }
  await f.noProfiles();
  assert.deepEqual(f.requests, []);
});

test('closing the browser proxy terminates its actual stalled PAC helper', async (t) => {
  const f = await fixture(t);
  environment(t, 'CC_TEST_UPDATE_STALL_PROXY', '1');
  const proxy = await openBrowserNetworkProxy(
    {
      url: f.origin.replace('https:', 'wss:') + '/ws',
      token: 'owned-helper-test-token',
    },
    { resolveProxy: createSystemProxyResolver({ app, executable }) },
  );
  const socket = connect(proxy.port, '127.0.0.1');
  socket.on('error', () => {});
  try {
    await once(socket, 'connect');
    const auth = Buffer.from(proxy.username + ':' + proxy.password).toString('base64');
    socket.write(
      'CONNECT default.example.test:443 HTTP/1.1\r\nHost: default.example.test:443\r\nProxy-Authorization: Basic ' +
        auth +
        '\r\n\r\n',
    );
    await waitProxyEvaluations(1);
  } finally {
    await proxy.close();
    socket.destroy();
  }
  await f.noProfiles();
  assert.deepEqual(f.requests, []);
});
