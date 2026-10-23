import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import * as contract from '../../../packages/managed-updates/src/index.ts';
import { managedBuildIdentity } from '../../../scripts/managed-client-build.mjs';

const require = createRequire(import.meta.url);
const { ManagedController, atomic, alive } = require('../electron/managed-controller.cjs');
const { validateIdentity, installationId } = require('../electron/managed-identity.cjs');
const { createNetwork } = require('../electron/managed-network.cjs');
const { registerClientUpdates } = require('../electron/managed-updates.cjs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const bytes = Buffer.from('fixture installer: never execute');
const identity = {
  product: contract.PRODUCT,
  channel: 'pilot',
  platform: 'win32',
  arch: 'x64',
  build: 1,
  protocol: 20,
  appVersion: '0.3.6',
  sourceCommit: 'a'.repeat(40),
  origin: 'https://fixture.invalid',
  trustedKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) },
};
const release = {
  build: 2,
  protocol: 20,
  appVersion: '0.3.6',
  sourceCommit: 'b'.repeat(40),
  notes: '<b>plain text</b>',
  filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
function payload(revision = 1, value = release) {
  return {
    schema: 1,
    product: contract.PRODUCT,
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    revision,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    state: value ? 'published' : 'empty',
    release: value,
  };
}
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-managed-client-'));
  mkdirSync(join(root, 'app'));
  let index = contract.signIndex(payload(), 'fixture', privateKey);
  let launches = 0;
  let quits = 0;
  let clock = Date.now();
  const options = {
    identity,
    executable: join(root, 'app/client.exe'),
    localAppData: root,
    contract,
    lockName:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\cc-test-${randomUUID()}`
        : join(root, 'lock.sock'),
    now: () => clock,
    processes: async () => [process.pid],
    network: {
      index: async () => index,
      download: async (_url, file, _release, signal, progress) => {
        signal.throwIfAborted();
        writeFileSync(file, bytes);
        progress(bytes.length);
      },
    },
    launchInstaller: async () => {
      launches++;
      return 987654321;
    },
    quit: () => {
      quits++;
    },
    ...overrides,
  };
  const controller = new ManagedController(options);
  controller.report({ blocked: false });
  t.after(() => {
    controller.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    controller,
    options,
    launches: () => launches,
    quits: () => quits,
    index: (value) => {
      index = contract.signIndex(value, 'fixture', privateKey);
    },
    advance: (ms) => {
      clock += ms;
      controller.report({ blocked: false });
    },
  };
}

test('build identity fixes origin and public keys; installation ID is directory-scoped', (t) => {
  assert.equal(validateIdentity(identity).build, 1);
  for (const edit of [
    { build: 0 },
    { origin: 'http://example.org' },
    { origin: 'https://example.org/path' },
    { sourceCommit: 'dirty' },
    { trustedKeys: { fixture: privateKey.export({ type: 'pkcs8', format: 'pem' }) } },
    { privateKey: 'forbidden' },
  ])
    assert.throws(() => validateIdentity({ ...identity, ...edit }));
  const f = fixture(t);
  assert.equal(installationId(f.options.executable), installationId(join(f.root, 'app/other.exe')));
});

test('IPC accepts semantic operations only, preserving no URL/path/version capability', async () => {
  const handlers = new Map();
  let called = 0;
  const runtime = Object.fromEntries(
    ['state', 'check', 'download', 'install', 'cancel', 'report'].map((name) => [
      name,
      () => ++called,
    ]),
  );
  registerClientUpdates((name, fn) => handlers.set(name, fn), runtime);
  for (const action of ['state', 'check', 'download', 'install', 'cancel']) {
    const fn = handlers.get(`managed-update:${action}`);
    assert.throws(() => fn({}, 'https://attacker.invalid/evil.exe'), /参数/);
    assert.throws(() => fn({}, { path: 'evil.exe', build: 99 }), /参数/);
    const expected = called + 1;
    assert.equal(await fn({}), expected);
  }
});

test('packager binds clean source, version and protocol and refuses dirty release identity', (t) => {
  const f = fixture(t);
  const root = join(f.root, 'source');
  for (const folder of ['deploy', 'apps/desktop', 'packages/protocol/src'])
    mkdirSync(join(root, folder), { recursive: true });
  const { product, build, channel, origin, trustedKeys } = identity;
  writeFileSync(
    join(root, 'deploy/managed-client.json'),
    JSON.stringify({ product, build, channel, origin, trustedKeys }),
  );
  writeFileSync(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '0.3.6' }));
  writeFileSync(
    join(root, 'packages/protocol/src/index.ts'),
    'export const PROTOCOL_VERSION = 20;',
  );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  git('init');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  const buildIdentity = managedBuildIdentity(root);
  assert.equal(buildIdentity.sourceCommit, git('rev-parse', 'HEAD'));
  assert.equal(buildIdentity.protocol, 20);
  writeFileSync(
    join(root, 'packages/protocol/src/index.ts'),
    'export const PROTOCOL_VERSION = 21;',
  );
  assert.throws(() => managedBuildIdentity(root), /clean Git/);
});

test('manual throttle preserves candidate; automatic checks share the six-hour interval', async (t) => {
  const f = fixture(t);
  assert.equal((await f.controller.check()).phase, 'available');
  await assert.rejects(f.controller.check(), /30 秒/);
  assert.equal(f.controller.state().phase, 'available');
  f.index(payload(2, null));
  f.advance(31000);
  assert.equal((await f.controller.check(false)).phase, 'available');
  assert.equal((await f.controller.check(true)).phase, 'idle');
});

test('same appVersion higher build downloads and installs; only new embedded build confirms pending', async (t) => {
  const f = fixture(t);
  await f.controller.recover();
  assert.equal((await f.controller.check()).phase, 'available');
  assert.equal((await f.controller.download()).phase, 'ready');
  assert.equal(f.launches(), 0);
  await f.controller.install();
  assert.equal(f.launches(), 1);
  assert.equal(f.quits(), 1);
  assert.equal(JSON.parse(readFileSync(f.controller.file('pending.json'))).targetBuild, 2);
  const next = new ManagedController({ ...f.options, identity: { ...identity, build: 2 } });
  t.after(() => next.stop());
  await next.recover();
  assert.equal(next.state().pending, null);
  assert.equal(JSON.parse(readFileSync(next.file('last-install.json'))).status, 'confirmed');
});

test('revoked index, tampering, protocol mismatch, replay and unknown processes never launch installer', async (t) => {
  for (const scenario of ['withdraw', 'tamper', 'protocol', 'replay', 'unknown', 'busy', 'stale']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      await f.controller.download();
      if (scenario === 'withdraw') f.index(payload(2, null));
      if (scenario === 'tamper') writeFileSync(f.controller.file('ready.exe'), 'bad');
      if (scenario === 'protocol') f.index(payload(2, { ...release, protocol: 19 }));
      if (scenario === 'replay') f.index(payload(1, { ...release, notes: 'equivocation' }));
      if (scenario === 'unknown') f.controller.processes = async () => [process.pid, 1234567];
      if (scenario === 'busy') f.controller.report({ blocked: true });
      if (scenario === 'stale')
        atomic(f.controller.memberFile, { pid: process.pid, at: 0, activity: { blocked: false } });
      await assert.rejects(f.controller.install());
      assert.equal(f.launches(), 0);
      assert.equal(f.quits(), 0);
    });
  }
});

test('shared operation lock excludes a second controller even with another profile', async (t) => {
  const f = fixture(t);
  const other = new ManagedController(f.options);
  t.after(() => other.stop());
  await f.controller.locked(async () => {
    await assert.rejects(other.check(), /EADDRINUSE/);
  });
  assert.equal((await other.check()).phase, 'available');
});

test('operating system releases update lock when its owner is killed', async (t) => {
  const f = fixture(t);
  const child = spawn(
    process.execPath,
    [
      '-e',
      'const net = require("node:net"); const server = net.createServer(); server.listen(process.argv[1], () => process.stdout.write("ready\\n"));',
      f.options.lockName,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  await assert.rejects(f.controller.check(), /EADDRINUSE/);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.equal((await f.controller.check()).phase, 'available');
});

test('cancellation aborts an active download and leaves no executable candidate', async (t) => {
  const f = fixture(t);
  f.controller.network.download = async (_url, _file, _release, signal) =>
    delay(60000, undefined, { signal });
  const download = f.controller.download();
  while (f.controller.state().phase !== 'downloading') await delay(5);
  f.controller.cancel();
  await assert.rejects(download, /aborted/);
  assert.equal(f.controller.state().phase, 'error');
  assert.equal(f.launches(), 0);
});

test('failed installer launch preserves pending and old build does not confirm success', async (t) => {
  const f = fixture(t, {
    launchInstaller: async () => {
      throw new Error('spawn failed');
    },
  });
  await f.controller.download();
  await assert.rejects(f.controller.install(), /spawn failed/);
  assert.equal(f.controller.state().pending.targetBuild, 2);
  await f.controller.recover();
  assert.equal(f.controller.state().pending.status, 'unconfirmed');
});

test(
  'Windows launcher survives its parent and preserves helper rejection in a quoted cache path',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = fixture(t);
    const cache = join(f.root, "installer's cache");
    mkdirSync(cache);
    const installer = join(cache, 'fixture.exe');
    const pending = join(cache, 'pending.json');
    writeFileSync(installer, bytes);
    writeFileSync(pending, '{}');
    const input = {
      file: installer,
      pending,
      directory: join(f.root, 'app'),
      release: { ...release, sha256: '0'.repeat(64) },
    };
    const stdout = execFileSync(
      process.execPath,
      [
        '-e',
        'const {launchInstaller}=require(process.argv[1]); const input=JSON.parse(process.argv[3]); input.parentPid=process.pid; launchInstaller(process.argv[2],input).then(pid=>console.log(pid));',
        fileURLToPath(new URL('../electron/managed-launch.cjs', import.meta.url)),
        fileURLToPath(new URL('../electron/managed-install.ps1', import.meta.url)),
        JSON.stringify(input),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    const helperPid = Number(stdout.trim());
    assert(helperPid > 0);
    const deadline = Date.now() + 10000;
    while (!existsSync(`${pending}.failure.txt`) && Date.now() < deadline) await delay(100);
    assert.match(
      readFileSync(`${pending}.failure.txt`, 'utf8'),
      /Final artifact verification failed/,
    );
    assert.match(readFileSync(`${pending}.helper.log`, 'utf8'), /Waiting for client/);
    while (alive(helperPid) && Date.now() < deadline) await delay(100);
    assert.equal(alive(helperPid), false);
  },
);

test(
  'real Windows installer helper records tampering and never executes the file',
  { skip: process.platform !== 'win32' },
  (t) => {
    const f = fixture(t);
    const installer = join(f.root, 'fixture.exe');
    const pending = join(f.root, 'pending.json');
    writeFileSync(installer, bytes);
    writeFileSync(pending, JSON.stringify({ targetBuild: 2, status: 'pending' }));
    const powershell = join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    assert.throws(() =>
      execFileSync(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          fileURLToPath(new URL('../electron/managed-install.ps1', import.meta.url)),
          '-Installer',
          installer,
          '-InstallDirectory',
          join(f.root, 'app'),
          '-ExpectedHash',
          '0'.repeat(64),
          '-ExpectedSize',
          String(bytes.length),
          '-ParentPid',
          '2147483647',
          '-Pending',
          pending,
        ],
        {
          windowsHide: true,
          stdio: 'pipe',
          timeout: 15000,
          env: {
            ...process.env,
            PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
          },
        },
      ),
    );
    assert.match(
      readFileSync(`${pending}.failure.txt`, 'utf8'),
      /Final artifact verification failed/,
    );
    assert.equal(JSON.parse(readFileSync(pending)).status, 'pending');
  },
);

test('cache junction outside installation cache is rejected', async (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  const part = f.controller.file(`download-${release.build}-${release.sha256}.part`);
  try {
    symlinkSync(outside, part, 'junction');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Symlink creation unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(f.controller.download(), /不安全/);
});

test('Chromium network wrapper bounds index and refuses metadata redirects', async () => {
  const signal = new AbortController().signal;
  for (const response of [
    new Response(null, { status: 302, headers: { location: '/index' } }),
    new Response(Buffer.alloc(65537)),
  ]) {
    const network = createNetwork(async () => response, identity.origin);
    await assert.rejects(network.index('pilot', signal), /重定向|过大/);
  }
});

test('Range resume, 200 restart, size bounds and redirect restrictions', async (t) => {
  for (const scenario of ['resume', 'restart', 'bad-range', 'cross-origin', 'oversize']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      const file = join(f.root, 'network.part');
      writeFileSync(file, bytes.subarray(0, 5));
      let seen;
      const network = createNetwork(async (_url, options) => {
        seen = options;
        if (scenario === 'cross-origin')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://attacker.invalid/cc-updates/v1/artifacts/evil' },
          });
        if (scenario === 'restart') return new Response(bytes, { status: 200 });
        return new Response(
          scenario === 'oversize' ? Buffer.alloc(bytes.length * 2) : bytes.subarray(5),
          {
            status: 206,
            headers: {
              'content-range': `bytes ${scenario === 'bad-range' ? 0 : 5}-${bytes.length - 1}/${bytes.length}`,
            },
          },
        );
      }, identity.origin);
      const download = network.download(
        identity.origin + contract.artifactPath(release),
        file,
        release,
        new AbortController().signal,
        () => {},
      );
      if (['resume', 'restart'].includes(scenario)) {
        await download;
        assert.deepEqual(readFileSync(file), bytes);
        assert.equal(seen.headers.Range, 'bytes=5-');
      } else await assert.rejects(download, /Range|重定向|大小/);
    });
  }
});
