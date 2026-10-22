import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Run only inside the temporary, unprivileged systemd namespace described in the report.
assert.equal(process.platform, 'linux');
assert.equal(Number(process.versions.node.split('.')[0]), 24);
assert.notEqual(process.getuid(), 0, 'Use a temporary unprivileged systemd identity.');
assert.equal(
  process.argv.length,
  4,
  'Expected extracted runtime and writable scratch directories.',
);
const source = resolve(process.argv[2]);
const scratch = resolve(process.argv[3]);
assert.match(scratch, /^\/run\/cc-update-acceptance-[a-z0-9-]+$/);
assert.equal((await readFile('/proc/net/route', 'utf8')).trim().split('\n').length, 1);
for (const path of [
  '/opt/sub2api',
  '/opt/sub2api-relay',
  '/run/docker.sock',
  '/etc/nginx',
  '/etc/letsencrypt',
]) {
  await assert.rejects(access(path, constants.R_OK), (error) =>
    ['EACCES', 'ENOENT'].includes(error.code),
  );
}
const info = JSON.parse(await readFile(join(source, 'BUILD-INFO.json'), 'utf8'));
for (const [path, hash] of Object.entries(info.files)) {
  assert.ok(!path.includes('..') && !path.startsWith('/'));
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(source, path)))
      .digest('hex'),
    hash,
  );
}
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
assert.equal(manifest.type, 'module');
assert.equal(manifest.dependencies, undefined);
const root = await mkdtemp(join(scratch, 'run-'));
const children = new Set();
const logs = [];
const checks = [];
const mark = (name) => checks.push(name);
const api = '/cc-updates/admin/api';
const channel = (name = 'pilot') => `/cc-updates/v1/channels/${name}/win32-x64.json`;
const origin = 'https://localhost:19443';
const keys = generateKeyPairSync('ed25519');
const token = randomBytes(32).toString('base64url');
const data = join(root, 'data');
const configPath = join(root, 'config.json');
let node;
let nginx;

function start(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {});
  children.add(child);
  child.once('exit', () => children.delete(child));
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (value) => logs.push(value.toString()));
  return child;
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function startNode() {
  const child = start(process.execPath, [
    join(source, 'apps/update-service/src/main.ts'),
    '--config',
    configPath,
  ]);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Node startup timed out')), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Node exited before listening'));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (bytes) => {
      if (bytes.toString().includes('listening on loopback')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}
let ca;
function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      origin + path,
      {
        method,
        ca,
        headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTPS timeout')));
    req.end(body);
  });
}
const headers = { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' };

try {
  await writeFile(
    configPath,
    JSON.stringify({
      origin,
      dataDir: data,
      port: 18817,
      adminName: 'linux-acceptance',
      adminTokenSha256: createHash('sha256').update(token).digest('hex'),
      trustedKeys: { acceptance: keys.publicKey.export({ type: 'spki', format: 'pem' }) },
    }),
    { flag: 'wx', mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ed25519',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      join(root, 'tls.key'),
      '-out',
      join(root, 'tls.crt'),
    ],
    { stdio: 'pipe' },
  );
  ca = await readFile(join(root, 'tls.crt'));
  const template = await readFile(join(source, 'deploy/update-service/nginx.conf.example'), 'utf8');
  const locations = template
    .replaceAll('127.0.0.1:8817', '127.0.0.1:18817')
    .replaceAll('/srv/cc-update-service/public/artifacts/', data + '/public/artifacts/');
  const nginxConfig = join(root, 'nginx.conf');
  await writeFile(
    nginxConfig,
    `pid ${root}/nginx.pid;
error_log ${root}/nginx-error.log warn;
worker_processes 1;
events { worker_connections 128; }
http {
  access_log ${root}/nginx-access.log combined;
  client_body_temp_path ${root}/client-body;
  proxy_temp_path ${root}/proxy;
  fastcgi_temp_path ${root}/fastcgi;
  uwsgi_temp_path ${root}/uwsgi;
  scgi_temp_path ${root}/scgi;
  server {
    listen 127.0.0.1:19443 ssl;
    server_name localhost;
    ssl_certificate ${root}/tls.crt;
    ssl_certificate_key ${root}/tls.key;
    ${locations}
    location / { return 404; }
  }
}
`,
    { flag: 'wx' },
  );
  execFileSync(
    '/usr/sbin/nginx',
    ['-t', '-p', root + '/', '-c', nginxConfig, '-e', join(root, 'nginx-error.log')],
    { stdio: 'pipe' },
  );
  node = await startNode();
  nginx = start('/usr/sbin/nginx', [
    '-p',
    root + '/',
    '-c',
    nginxConfig,
    '-e',
    join(root, 'nginx-error.log'),
    '-g',
    'daemon off;',
  ]);
  let page;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      page = await request('/cc-updates/admin/');
      break;
    } catch {
      await delay(100);
    }
  }
  assert.equal(page?.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal((await request(api + '/status')).status, 401);
  assert.equal((await request(api + '/status', { headers })).status, 200);
  assert.equal(
    (
      await request(api + '/candidates', {
        method: 'POST',
        headers: { ...headers, origin: 'https://wrong.invalid' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(api + '/candidates', { method: 'POST', headers, body: '{}' })).status,
    400,
  );
  assert.equal((await request(channel())).status, 404);
  mark(
    'standalone Node 24 and actual Nginx template over verified localhost TLS; auth/Origin/schema rejection',
  );

  const { signIndex } = await import(
    pathToFileURL(join(source, 'packages/managed-updates/src/index.ts')).href
  );
  const bytes = randomBytes(2 * 1024 * 1024);
  const release = {
    appVersion: '0.3.6',
    protocol: 20,
    sourceCommit: info.sourceCommit,
    notes: 'linux-acceptance-private-request-body',
    filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  function signed(revision, build = 1, name = 'pilot', empty = false) {
    return signIndex(
      {
        schema: 1,
        product: 'cc-desk-tunnel-managed',
        channel: name,
        platform: 'win32',
        arch: 'x64',
        revision,
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        state: empty ? 'empty' : 'published',
        release: empty ? null : { ...release, build },
      },
      'acceptance',
      keys.privateKey,
    );
  }
  async function candidate(signedBytes) {
    const reply = await request(api + '/candidates', {
      method: 'POST',
      headers,
      body: signedBytes,
    });
    assert.equal(reply.status, 201);
    return JSON.parse(reply.bytes).id;
  }
  async function activate(id, expected = 200) {
    const reply = await request(`${api}/candidates/${id}/activate`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(reply.status, expected);
  }
  async function upload(id, body, expected = 204) {
    assert.equal(
      (
        await request(`${api}/candidates/${id}/artifact`, {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/octet-stream' },
          body,
        })
      ).status,
      expected,
    );
  }
  const first = signed(1);
  const id = await candidate(first);
  await upload(id, Buffer.alloc(bytes.length), 400);
  await upload(id, bytes.subarray(1), 400);
  assert.equal((await request(channel())).status, 404);
  await upload(id, bytes);
  await activate(id);
  assert.deepEqual((await request(channel())).bytes, first);
  assert.equal((await request(channel())).headers['cache-control'], 'no-store');
  assert.equal((await request(channel(), { method: 'HEAD' })).bytes.length, 0);
  const artifact = `/cc-updates/v1/artifacts/1/win32-x64/${release.filename}`;
  const full = await request(artifact);
  assert.equal(full.status, 200);
  assert.deepEqual(full.bytes, bytes);
  const head = await request(artifact, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), bytes.length);
  assert.equal(head.bytes.length, 0);
  const range = await request(artifact, { headers: { range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], `bytes 0-15/${bytes.length}`);
  assert.deepEqual(range.bytes, bytes.subarray(0, 16));
  assert.equal(
    (await request(artifact, { headers: { range: `bytes=${bytes.length}-` } })).status,
    416,
  );
  assert.equal((await request(artifact, { method: 'POST' })).status, 403);
  for (const path of [
    '/cc-updates/private/state.sqlite',
    '/cc-updates/public/',
    '/cc-updates/v1/artifacts/',
    `/cc-updates/v1/artifacts/1/win32-x64/${id}.bin`,
    '/cc-updates/admin/config.json',
  ])
    assert.equal((await request(path)).status, 404);
  for (const [path, mode] of [
    [data, 0o755],
    [join(data, 'private'), 0o700],
    [join(data, 'public/artifacts/1/win32-x64'), 0o755],
    [join(data, 'public/artifacts/1/win32-x64', release.filename), 0o644],
  ])
    assert.equal((await stat(path)).mode & 0o777, mode);
  mark(
    'signed upload/activation; tampered and truncated uploads rejected; exact metadata/installer; HEAD/206/416; private URLs and Linux modes',
  );

  const second = signed(2, 2);
  const next = await candidate(second);
  await upload(next, bytes);
  const conflict = join(data, 'public/artifacts/2/win32-x64', release.filename);
  await mkdir(dirname(conflict), { recursive: true });
  await writeFile(conflict, 'conflicting incomplete artifact', { flag: 'wx' });
  const failed = await request(`${api}/candidates/${next}/activate`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  assert.ok(failed.status >= 400);
  assert.deepEqual((await request(channel())).bytes, first);
  await rm(conflict);
  const secondWriter = start(process.execPath, [
    join(source, 'apps/update-service/src/main.ts'),
    '--config',
    configPath,
  ]);
  const [writerCode] = await once(secondWriter, 'exit');
  assert.equal(writerCode, 1);
  await writeFile(join(data, 'private/interrupted.part'), 'partial');
  await stop(node, 'SIGKILL');
  node = await startNode();
  await assert.rejects(access(join(data, 'private/interrupted.part')), { code: 'ENOENT' });
  assert.deepEqual((await request(channel())).bytes, first);
  await activate(next);
  assert.deepEqual((await request(channel())).bytes, second);
  mark(
    'failed activation preserves old index; second writer excluded; SIGKILL lock release, restart recovery and reserved-build retry',
  );

  await activate(await candidate(signed(3, 2)));
  await activate(await candidate(signed(1, 1, 'stable')));
  assert.equal(JSON.parse((await request(api + '/status', { headers })).bytes).channels.length, 2);
  const withdrawal = signed(4, 2, 'pilot', true);
  await activate(await candidate(withdrawal));
  assert.deepEqual((await request(channel())).bytes, withdrawal);
  await activate(await candidate(signed(2, 2)), 409);
  await activate(await candidate(signed(5, 1)), 409);
  assert.deepEqual((await request(artifact)).bytes, bytes);
  mark(
    'renewal, known-build stable promotion, signed withdrawal, revision/build floors and retained immutable artifact',
  );

  await stop(nginx);
  await stop(node);
  const allLogs =
    logs.join('') +
    (await readFile(join(root, 'nginx-access.log'), 'utf8')) +
    (await readFile(join(root, 'nginx-error.log'), 'utf8'));
  for (const secret of [
    token,
    `Bearer ${token}`,
    'linux-acceptance-private-request-body',
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  ])
    assert.ok(!allLogs.includes(secret), 'Logs must not contain credentials or request bodies.');
  mark('captured Node/Nginx logs omit token, signing private key and request-body marker');
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        sourceCommit: info.sourceCommit,
        nodeVersion: process.version,
        uid: process.getuid(),
        network: 'systemd private network; localhost TLS with explicit trusted CA',
        checks,
        limitations: [
          'test Nginx and Node share the temporary service UID; permission modes and URL isolation verified, distinct production Nginx identity not exercised',
          'power-loss durability is not simulated',
          'public DNS/TLS, production configuration and Windows client integration remain separate',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of [...children]) await stop(child);
  assert.equal(dirname(root), scratch);
  assert.ok(root.startsWith(join(scratch, 'run-')));
  await rm(root, { recursive: true, force: true });
}
