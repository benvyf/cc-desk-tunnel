// Run against a freshly packaged Windows client in an isolated profile. Account HTTP is synthetic.
import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const exe =
  process.env.CC_TERMINAL_PACKAGE || resolve('artifacts/windows/win-unpacked/CC SPACE.exe');
const profile = mkdtempSync(join(tmpdir(), 'cc-window-review-'));
const app = await electron.launch({
  executablePath: exe,
  args: ['--smoke-test', '--user-data-dir=' + profile],
});
const childProcess = app.process();
try {
  const owner = await app.firstWindow();
  await owner.waitForLoadState();
  await owner.evaluate(() => {
    const w = window.open('about:blank', 'cc-native-terminal', 'popup');
    w.document.title = 'CC SPACE · 原生终端';
  });
  for (let i = 0; i < 100 && app.windows().length !== 2; i++)
    await new Promise((r) => setTimeout(r, 30));
  assert.equal(app.windows().length, 2);
  const ownerVisible = await app.evaluate(({ BrowserWindow, app }) => {
    app.emit('activate');
    return BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() !== 'CC SPACE · 原生终端')
      .isVisible();
  });
  assert.equal(ownerVisible, true, 'Tray/activate must show primary window, not the terminal');
  const path = await owner.evaluate(async () => {
    window.scheduleNotifications = [];
    window.desktop.onSchedulesChanged((text) => window.scheduleNotifications.push(text));
    return (await window.desktop.loadSchedules('')).path;
  });
  const text = '[ ] Offline review fixture ' + Date.now();
  writeFileSync(path, text);
  for (let i = 0; i < 100; i++) {
    if (await owner.evaluate((text) => window.scheduleNotifications.includes(text), text)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(
    await owner.evaluate((text) => window.scheduleNotifications.includes(text), text),
    'Schedule changes must reach primary renderer',
  );
  await app.evaluate(({ net }) => {
    net.fetch = async (url) => ({
      ok: String(url).endsWith('/login'),
      status: String(url).endsWith('/login') ? 200 : 401,
      json: async () =>
        String(url).endsWith('/login')
          ? { email: 'fixture@example.invalid', token: 'offline-fixture', workspaces: [] }
          : { error: 'offline session expired' },
    });
  });
  await owner.evaluate(async () => {
    window.expiredMessages = [];
    window.desktop.access.onExpired((message) => window.expiredMessages.push(message));
    await window.desktop.access.login({
      email: 'fixture@example.invalid',
      password: 'synthetic',
      remember: false,
    });
    await window.desktop.access.ticket('fixture-node');
  });
  for (let i = 0; i < 100; i++) {
    if (await owner.evaluate(() => window.expiredMessages.length)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(await owner.evaluate(() => window.expiredMessages), ['offline session expired']);
  console.log('PASS: primary restore, schedule updates, account expiry routing with terminal open');
} finally {
  await app.close().catch(() => {});
  if (childProcess.exitCode === null) childProcess.kill();
}
