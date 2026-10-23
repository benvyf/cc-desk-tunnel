// Isolated Windows acceptance. Uses ephemeral signing keys and a test-only application ID.
// Never installs over CC Desk Tunnel or contacts a model/production update origin.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build as electronBuild, Platform, Arch } from 'electron-builder';
import { _electron } from '@playwright/test';
import { extractFile, uncache } from '@electron/asar';
import { stageDesktop } from './package-desktop.mjs';
import { signIndex, PRODUCT, artifactPath } from '../packages/managed-updates/src/index.ts';
import { defaultCertificate } from '../apps/server/test/fixtures/web-certificates.ts';
import { createRequire } from 'node:module';
const { installationId } = createRequire(import.meta.url)(
  '../apps/desktop/electron/managed-identity.cjs',
);
const { alive } = createRequire(import.meta.url)('../apps/desktop/electron/managed-controller.cjs');

if (process.platform !== 'win32') throw new Error('Windows acceptance only');
const interactiveCancel = process.argv.includes('--interactive-cancel');
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(
  root,
  '.local/managed-client-acceptance',
  new Date().toISOString().replaceAll(/[:.]/g, '-'),
);
mkdirSync(directory, { recursive: true });
const name = 'CC Managed Update Acceptance';
const vendor = existsSync(join(root, 'apps/desktop/vendor/pwsh/pwsh.exe'))
  ? join(root, 'apps/desktop/vendor')
  : join(root, 'CC Desk Tunnel/resources/vendor');
if (!existsSync(join(vendor, 'pwsh/pwsh.exe')))
  throw new Error('Prepare bundled PowerShell before acceptance');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
let index;
let artifact;
let revision = 0;
let requested = 0;
const server = createServer(defaultCertificate, (request, response) => {
  requested++;
  if (request.url === '/cc-updates/v1/channels/pilot/win32-x64.json') {
    response.end(index);
    return;
  }
  if (artifact && request.url === artifactPath(artifact.release)) {
    const offset = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1];
    const bytes = artifact.bytes;
    const start = offset ? Number(offset) : 0;
    response.writeHead(start ? 206 : 200, {
      'content-length': bytes.length - start,
      ...(start ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    response.end(bytes.subarray(start));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
const origin = `https://127.0.0.1:${server.address().port}`;
const appVersion = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'))).version;
const identity = {
  product: PRODUCT,
  build: 1,
  channel: 'pilot',
  origin,
  trustedKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) },
  appVersion,
  protocol: 20,
  sourceCommit: 'a'.repeat(40),
  platform: 'win32',
  arch: 'x64',
};
function publish(release) {
  const now = Date.now();
  index = signIndex(
    {
      schema: 1,
      product: PRODUCT,
      channel: 'pilot',
      platform: 'win32',
      arch: 'x64',
      revision: ++revision,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      state: release ? 'published' : 'empty',
      release,
    },
    'fixture',
    privateKey,
  );
}
publish(null);
async function build(build) {
  const app = join(directory, `stage-${build}`);
  await stageDesktop(root, app, {
    description: 'TEST ONLY managed update acceptance',
    files: ['prepare-ssh.ps1', 'component-host.ps1', 'managed-install.ps1'],
    managedIdentity: { ...identity, build },
  });
  const results = await electronBuild({
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      appId: 'io.github.ccdesktunnel.managed.acceptance',
      compression: 'store',
      productName: name,
      executableName: name,
      electronVersion: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json')))
        .version,
      electronDist: join(root, 'node_modules/electron/dist'),
      directories: { app, output: join(directory, `build-${build}`) },
      npmRebuild: false,
      asar: true,
      asarUnpack: ['electron/*.ps1'],
      files: ['package.json', 'electron/**', 'dist/**'],
      extraResources: [
        { from: vendor, to: 'vendor', filter: ['openssh/**', 'pwsh/**', '!**/runtime.json'] },
      ],
      win: {
        target: 'nsis',
        signExecutable: false,
        icon: join(root, 'apps/desktop/electron/icon.png'),
      },
      nsis: {
        useZip: true,
        differentialPackage: false,
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        runAfterFinish: false,
        deleteAppDataOnUninstall: false,
        artifactName: 'CC-Desk-Tunnel-Setup-${version}-x64.exe',
      },
    },
  });
  return results.find((file) => file.endsWith('.exe') && !file.includes('uninstaller'));
}
const applications = new Set();
async function launch(executablePath, profile) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('PROXY_'),
    ),
  );
  const application = await _electron.launch({
    executablePath,
    args: ['--smoke-test', `--user-data-dir=${join(directory, profile)}`],
    env,
  });
  applications.add(application);
  await application.evaluate(async ({ session }, certificate) => {
    await session.defaultSession.setProxy({ mode: 'direct' });
    session.defaultSession.setCertificateVerifyProc((request, callback) =>
      callback(
        request.hostname === '127.0.0.1' &&
          request.certificate.data.replace(/\s/g, '') === certificate.replace(/\s/g, '')
          ? 0
          : -3,
      ),
    );
  }, defaultCertificate.cert);
  const page = await application.firstWindow();
  await page.waitForFunction(() => window.desktop?.managedUpdate);
  for (let count = 0; count < 100; count++) {
    const state = await page.evaluate(() => window.desktop.managedUpdate.state());
    if (state.phase !== 'disabled') return { application, page };
    await delay(100);
  }
  throw new Error('Packaged updater failed to initialize');
}
async function call(page, action) {
  return page.evaluate((action) => window.desktop.managedUpdate[action](), action);
}
async function install(application) {
  try {
    await call(application.page, 'install');
  } catch (error) {
    if (!/closed|destroyed/i.test(error.message)) throw error;
  }
  applications.delete(application.application);
}
const evidence = {
  origin,
  directory,
  checks: [],
  installation: false,
  ...(interactiveCancel ? { cancellation: false } : {}),
};
try {
  const installer2 = await build(2);
  const installer1 = await build(1);
  artifact = { bytes: readFileSync(installer2) };
  artifact.release = {
    build: 2,
    appVersion,
    protocol: 20,
    sourceCommit: identity.sourceCommit,
    notes: '<script>fixture must remain text</script>',
    filename: `CC-Desk-Tunnel-Setup-${appVersion}-x64.exe`,
    size: artifact.bytes.length,
    sha256: createHash('sha256').update(artifact.bytes).digest('hex'),
  };
  publish(artifact.release);
  const installed = join(directory, 'installed');
  await promisify(execFile)(installer1, ['/S', `/D=${installed}`], {
    windowsHide: true,
    timeout: 180000,
  });
  const executable = join(installed, `${name}.exe`);
  assert(existsSync(executable));
  const first = await launch(executable, 'profile-one');
  assert.equal((await call(first.page, 'state')).identity.build, 1);
  let resumed = first;
  if (!interactiveCancel) {
    const ipc = await first.application.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const event = { senderFrame: BrowserWindow.getAllWindows()[0].webContents.mainFrame };
      const failures = [];
      for (const channel of [
        'update:install',
        'service:upgrade',
        'release:notes',
        'managed-update:download',
      ]) {
        try {
          await ipcMain._invokeHandlers.get(channel)(event, 'https://attacker.invalid/evil.exe');
        } catch (error) {
          failures.push(error.message);
        }
      }
      return failures;
    });
    assert.equal(ipc.length, 4);
    evidence.checks.push('packaged old IPC refusal and new IPC argument rejection');
    assert.equal((await call(first.page, 'check')).phase, 'available');
    assert.equal((await call(first.page, 'download')).phase, 'ready');
    const second = await launch(executable, 'profile-two');
    assert.equal((await call(second.page, 'state')).phase, 'ready');
    await second.application.evaluate(({ ipcMain, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      ipcMain._invokeHandlers.get('managed-update:activity')(
        { senderFrame: window.webContents.mainFrame },
        { blocked: true },
      );
      // A crashed renderer cannot later replace its busy report with a safe one.
      window.webContents.forcefullyCrashRenderer();
    });
    await assert.rejects(call(first.page, 'install'), /断开|状态/);
    evidence.checks.push('independent profiles share cache; crashed busy peer blocks install');
    await second.application.close();
    applications.delete(second.application);
    await first.application.close();
    applications.delete(first.application);
    resumed = await launch(executable, 'profile-one');
    publish(null);
    await assert.rejects(call(resumed.page, 'install'), /撤回|改变/);
    evidence.checks.push('fresh signed withdrawal blocks cached installer');
    publish(artifact.release);
    assert.equal((await call(resumed.page, 'download')).phase, 'ready');
  } else {
    assert.equal((await call(first.page, 'check')).phase, 'available');
    assert.equal((await call(first.page, 'download')).phase, 'ready');
  }
  const cache = join(
    process.env.LOCALAPPDATA,
    'CC-Desk-Tunnel/updates',
    installationId(executable),
  );
  const pendingFile = join(cache, 'pending.json');
  if (interactiveCancel) {
    await delay(2100);
    await install(resumed);
    const pending = JSON.parse(readFileSync(pendingFile));
    assert.equal(pending.targetBuild, 2);
    const cancelDeadline = Date.now() + 15 * 60000;
    // Leave the production helper untouched: a human clicks Cancel in the real NSIS window.
    writeFileSync(
      join(directory, 'awaiting-cancel.json'),
      JSON.stringify(
        {
          product: name,
          targetBuild: 2,
          helperPid: pending.helperPid,
          instruction:
            'Click Cancel in CC Managed Update Acceptance Setup; confirm cancellation if asked.',
        },
        null,
        2,
      ),
    );
    console.log('ACTION_REQUIRED_CANCEL', directory);
    while (alive(pending.helperPid)) {
      if (Date.now() >= cancelDeadline)
        throw new Error('Timed out waiting for interactive cancellation');
      await delay(200);
    }
    assert.match(
      readFileSync(`${pendingFile}.failure.txt`, 'utf8'),
      /^Installer exit code: [1-9]\d*$/,
    );
    const archive = join(installed, 'resources/app.asar');
    uncache(archive);
    assert.equal(JSON.parse(extractFile(archive, 'electron/managed-build.json')).build, 1);
    resumed = await launch(executable, 'profile-one');
    const cancelled = await call(resumed.page, 'state');
    assert.equal(cancelled.identity.build, 1);
    assert.equal(cancelled.pending.targetBuild, 2);
    assert.equal(cancelled.pending.status, 'unconfirmed');
    assert.equal(cancelled.phase, 'ready');
    assert.equal(existsSync(join(cache, 'last-install.json')), false);
    evidence.cancellation = true;
    evidence.checks.push(
      'human cancels unchanged interactive NSIS; old build starts, pending stays unconfirmed and retry is ready',
    );
    writeFileSync(join(directory, 'after-cancel.json'), JSON.stringify(cancelled, null, 2));
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    // Preserve cancellation diagnostics separately so the retry is checked for fresh failures.
    renameSync(`${pendingFile}.failure.txt`, `${pendingFile}.cancelled.failure.txt`);
    console.log('CANCEL_VERIFIED_RETRYING', directory);
  }
  // The real helper is exercised with a fixed test wrapper adding /S; production remains interactive.
  // The wrapper is installed into the test package only, never the source or a production package.
  const helper = join(installed, 'resources/app.asar.unpacked/electron/managed-install.ps1');
  const text = readFileSync(helper, 'utf8');
  writeFileSync(
    helper,
    text.replace(
      ' -ArgumentList "/D=$InstallDirectory"',
      ' -ArgumentList "/S /D=$InstallDirectory"',
    ),
  );
  await delay(2100);
  await install(resumed);
  assert.equal(JSON.parse(readFileSync(pendingFile)).targetBuild, 2);
  // Wait for the helper and NSIS rather than starting the old binary mid-install.
  const pending = JSON.parse(readFileSync(pendingFile));
  const installDeadline = Date.now() + 180000;
  while (true) {
    let installedBuild = null;
    try {
      const archive = join(installed, 'resources/app.asar');
      uncache(archive);
      installedBuild = JSON.parse(extractFile(archive, 'electron/managed-build.json')).build;
    } catch {}
    if (existsSync(`${pendingFile}.failure.txt`))
      throw new Error(readFileSync(`${pendingFile}.failure.txt`, 'utf8'));
    if (!alive(pending.helperPid) && installedBuild === 2) break;
    if (Date.now() >= installDeadline) throw new Error('Installer acceptance timed out');
    await delay(200);
  }
  if (existsSync(`${pendingFile}.failure.txt`))
    throw new Error(readFileSync(`${pendingFile}.failure.txt`, 'utf8'));
  const upgraded = await launch(executable, 'profile-one');
  const final = await call(upgraded.page, 'state');
  assert.equal(final.identity.build, 2);
  assert.equal(final.pending, null);
  evidence.checks.push('real NSIS build 1 -> 2, external helper and embedded-build confirmation');
  evidence.installation = true;
  await upgraded.page.getByRole('button', { name: '本机设置', exact: true }).click();
  await upgraded.page.getByRole('button', { name: '关于与更新', exact: true }).click();
  await upgraded.page.getByText('定制构建 2 · pilot · 协议 20', { exact: true }).waitFor();
  assert.equal(await upgraded.page.getByText('安装尚未确认', { exact: false }).count(), 0);
  evidence.checks.push('login settings expose build 2 and clear pending status');
  // Native capture avoids a Chromium protocol screenshot stalling on an occluded Electron window.
  try {
    const screenshot = await upgraded.application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const capture = window.webContents
        .capturePage()
        .then((image) => image.toPNG().toString('base64'));
      let timer;
      try {
        return await Promise.race([
          capture,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Native capture timed out')), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    writeFileSync(join(directory, 'upgraded.png'), Buffer.from(screenshot, 'base64'));
  } catch (error) {
    evidence.screenshotError = error.message;
  }
  assert(requested > 0);
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS', JSON.stringify(evidence));
} catch (error) {
  writeFileSync(
    join(directory, 'evidence.json'),
    JSON.stringify({ ...evidence, error: error.stack ?? error.message }, null, 2),
  );
  throw error;
} finally {
  for (const application of applications) await application.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  const uninstaller = join(directory, 'installed', `Uninstall ${name}.exe`);
  if (existsSync(uninstaller))
    await promisify(execFile)(uninstaller, ['/S'], { windowsHide: true, timeout: 120000 }).catch(
      () => {},
    );
}
