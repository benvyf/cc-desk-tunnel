// Native-main diagnostics for an owned offline website, with optional OS capture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ownedBrowserService } from '../apps/desktop/test/fixtures/owned-browser-service.ts';
import { custom, defaultCertificate } from '../apps/server/test/fixtures/web-certificates.ts';
const args = process.argv.slice(2);
if (process.platform !== 'win32') throw new Error('This diagnostic is for Windows');
const elevated = execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ],
  { encoding: 'utf8', windowsHide: true },
).trim();
assert.equal(elevated, 'False', 'Run the browser diagnostic from a non-elevated terminal');
if (args.includes('--prepare')) {
  const nonce = randomBytes(12).toString('hex');
  const directory = resolve('.local/cc-native-network-' + nonce.slice(0, 8));
  await mkdir(directory, { recursive: false });
  await writeFile(join(directory, 'run.json'), JSON.stringify({ schema: 1, nonce }, null, 2));
  console.log(JSON.stringify({ marker: 'NATIVE_CHECK_PREPARED', directory }));
  process.exit(0);
}
const directory = resolve(args[0]);
const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
assert.match(run.nonce, /^[a-f0-9]{24}$/);
const withoutCapture = args.includes('--without-capture');
const output = join(directory, withoutCapture ? 'dry-run' : 'observed');
await mkdir(output, { recursive: false });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
if (!withoutCapture) {
  const capture = JSON.parse(await readFile(join(directory, 'capture-ready.json'), 'utf8'));
  assert.equal(capture.nonce, run.nonce);
  const age = Date.now() - Date.parse(capture.startedAt);
  assert.ok(
    age >= 0 && capture.maxSeconds <= 180 && capture.maxSeconds * 1000 - age >= 110000,
    'Capture must have at least 110 seconds remaining',
  );
  assert.equal(
    await access(join(directory, 'capture-complete.json')).then(
      () => true,
      () => false,
    ),
    false,
    'Capture already completed',
  );
  assert.equal(
    await access(join(directory, 'capture-stopped.json')).then(
      () => true,
      () => false,
    ),
    false,
    'Capture already stopped',
  );
  assert.equal(
    await access(join(directory, 'capture-failed.json')).then(
      () => true,
      () => false,
    ),
    false,
    'Capture failed',
  );
}
const report = {
  schema: 1,
  nonce: run.nonce,
  withoutCapture,
  output,
  rootPid: process.pid,
  localAddresses: Object.values(networkInterfaces())
    .flat()
    .map((item) => item.address),
  positiveDnsName: 'capture-' + run.nonce + '.api.ghostapi.org',
};
const sockets = [];
let service, child;
try {
  const listenUdp = async (type, host) => {
    const socket = createSocket(type);
    sockets.push(socket);
    socket.bind(0, host);
    await once(socket, 'listening');
    return socket;
  };
  const udp4 = await listenUdp('udp4', '127.0.0.1');
  const udp6 = await listenUdp('udp6', '::1');
  const unexpectedUdp = { v4: 0, v6: 0 };
  const positive = Buffer.from('CC_CAPTURE_CONTROL_' + run.nonce);
  udp4.on('message', (body) => {
    if (!body.equals(positive)) unexpectedUdp.v4++;
  });
  udp6.on('message', (body) => {
    if (!body.equals(positive)) unexpectedUdp.v6++;
  });
  if (!withoutCapture) {
    report.positiveStartedAt = new Date().toISOString();
    const sender = createSocket('udp4');
    try {
      await new Promise((done, reject) =>
        sender.send(positive, 3478, '74.82.201.214', (error) => (error ? reject(error) : done())),
      );
      report.positiveUdp = {
        destination: '74.82.201.214',
        port: 3478,
        sourcePort: sender.address().port,
      };
    } finally {
      sender.close();
    }
    // Exercise the Windows DNS client explicitly: Node lookup did not produce
    // a visible DNS ETW positive control in the baseline capture.
    const dnsControl = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "try { Resolve-DnsName -Name '" +
          report.positiveDnsName +
          "' -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Out-Null; 'resolved' } catch { $_.FullyQualifiedErrorId }",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    report.positiveDnsResult = dnsControl.stdout.trim();
    report.positiveDnsMethod = 'Windows Resolve-DnsName A DnsOnly NoHostsFile QuickTimeout';
    await pause(500);
    report.positiveEndedAt = new Date().toISOString();
  }
  const host = 'native-' + run.nonce + '.example.test';
  service = await ownedBrowserService(join(output, 'server'), 'owned-native-network-token', host);
  const settings = {
    nonce: run.nonce,
    host,
    token: 'owned-native-network-token',
    deviceId: randomUUID(),
    rtcHost: 'rtc-' + run.nonce + '.api.ghostapi.org',
    prefetchHost: 'prefetch-' + run.nonce + '.api.ghostapi.org',
    protocol: PROTOCOL_VERSION,
    siteFingerprint: new X509Certificate(custom.cert).fingerprint256,
    control: {
      url: service.url,
      fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
    },
    udp4Port: udp4.address().port,
    udp6Port: udp6.address().port,
  };
  const settingsFile = join(output, 'settings.json');
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  report.browserStartedAt = new Date().toISOString();
  child = spawn(
    createRequire(import.meta.url)('electron'),
    [
      resolve('scripts/fixtures/native-browser-network.cjs'),
      '--smoke-test',
      '--user-data-dir=' + join(output, 'profile'),
    ],
    {
      env: { ...env, CC_NETWORK_CHECK_SETTINGS: settingsFile, CC_NETWORK_CHECK_OUTPUT: output },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  report.electronPid = child.pid;
  let errors = '';
  child.stderr.on('data', (part) => {
    errors = (errors + part).slice(-4096);
  });
  const log = createInterface({ input: child.stdout });
  report.events = [];
  log.on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    report.events.push({ at: new Date().toISOString(), ...value });
    if (value.marker === 'STOP_PROXY') {
      service.stopBrowserProxy();
      writeFileSync(join(output, 'proxy-stopped.json'), JSON.stringify({ nonce: run.nonce }), {
        flag: 'wx',
      });
    }
    if (value.marker) console.log(line);
  });
  const watchdog = setTimeout(() => child.kill(), 90000);
  let code;
  try {
    [code] = await once(child, 'exit');
  } finally {
    clearTimeout(watchdog);
    log.close();
  }
  report.browserEndedAt = new Date().toISOString();
  report.unexpectedLoopbackUdp = unexpectedUdp;
  report.childExitCode = code;
  if (code !== 0) report.stderr = errors;
  assert.equal(code, 0, 'Native Electron diagnostic must finish successfully: ' + errors);
  assert.deepEqual(unexpectedUdp, { v4: 0, v6: 0 });
  const native = JSON.parse(await readFile(join(output, 'native-result.json'), 'utf8'));
  assert.equal(native.ok, true);
  report.ok = true;
  console.log(
    'NATIVE_MAIN_FUNCTIONAL_CHECK_PASS security_acceptance=pending capture_analysis_pending=' +
      !withoutCapture,
  );
} catch (error) {
  report.ok = false;
  report.error = String(error.stack || error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  child?.kill();
  await service?.close();
  for (const socket of sockets) socket.close();
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2));
  if (!withoutCapture)
    await writeFile(
      join(directory, 'test-finished.json'),
      JSON.stringify({ nonce: run.nonce, ok: report.ok, endedAt: new Date().toISOString() }),
    );
}
