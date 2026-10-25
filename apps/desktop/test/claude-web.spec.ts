import { test, expect, _electron } from '@playwright/test';
import { login, createSession } from './helpers.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createProxyServer } from '../../server/src/server.ts';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { custom } from '../../server/test/fixtures/web-certificates.ts';
import { ownedBrowserService } from './fixtures/owned-browser-service.ts';

test('Chat/Coding occupies the old logo area and preserves the Coding draft without site requests', async ({
  page,
}) => {
  const sites: string[] = [];
  await page.route(/https?:\/\/.*(?:claude\.ai|claude\.com|anthropic\.com)/, (route) => {
    sites.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '保留编程草稿');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('尚未发送的中文草稿');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('请在桌面客户端打开Claude网页')).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/claude-web-chat.png' });
  await page.getByRole('tab', { name: 'Coding', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '尚未发送的中文草稿',
  );
  expect(sites).toEqual([]);
  await page.screenshot({ path: '.local/screenshots/claude-web-coding.png' });
});

test('narrow Chat releases the Coding sidebar shade and keeps notices below its wrapped toolbar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.sidebar-shade')).not.toBeVisible({ timeout: 1500 });
  await page.setViewportSize({ width: 380, height: 560 });
  const toolbar = await page.locator('.claude-web-toolbar').boundingBox();
  const notice = await page.locator('.claude-web-notice').boundingBox();
  expect(notice!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', { name: 'Coding', exact: true }).click({ timeout: 2000 });
  await expect(page.getByRole('region', { name: 'Claude网页' })).not.toBeVisible();
});

test('Electron Chat uses the v2 gate and keeps Coding available without opening a website', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance');
  const directory = mkdtempSync(resolve('.local/ui-test/browser-v2-'));
  const token = 'offline-personal-browser-service-token';
  const service = createProxyServer({
    token,
    dataDir: join(directory, 'server'),
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
  });
  const address = await service.listen(0);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && name !== 'ELECTRON_RUN_AS_NODE',
    ),
  ) as Record<string, string>;
  const application = await _electron.launch({
    args: [
      resolve('apps/desktop'),
      '--smoke-test',
      `--user-data-dir=${join(directory, 'profile')}`,
    ],
    env,
  });
  try {
    const page = await application.firstWindow();
    await page.getByLabel('服务地址').fill(address.replace('https:', 'wss:') + '/ws');
    await page.getByLabel('服务凭据').fill(token);
    await page.getByText('高级连接选项', { exact: true }).click();
    await page
      .getByLabel('服务证书指纹', { exact: true })
      .fill(new X509Certificate(defaultCertificate.cert).fingerprint256);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: '打开Claude网页', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('管理员尚未启用网页代理');
    expect(await page.evaluate(() => typeof window.desktop!.browser.bounds)).toBe('function');
    expect(await page.evaluate(() => typeof window.desktop!.browser.onState)).toBe('function');
    expect(
      await application.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .some((contents) => contents.getURL().startsWith('https://claude.ai')),
      ),
    ).toBe(false);
    await page.getByRole('tab', { name: 'Coding', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Claude网页' })).not.toBeVisible();
    await page.screenshot({ path: '.local/screenshots/claude-web-v2-gate.png' });
  } finally {
    await application.close();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Electron Chat opens the real local view through v2 and hides it for Coding and login maintenance', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop acceptance');
  const directory = mkdtempSync(resolve('.local/ui-test/browser-enabled-'));
  const token = 'owned-integrated-browser-token';
  const service = await ownedBrowserService(join(directory, 'server'), token);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && name !== 'ELECTRON_RUN_AS_NODE',
    ),
  ) as Record<string, string>;
  const application = await _electron.launch({
    args: [
      resolve('apps/desktop'),
      '--smoke-test',
      `--user-data-dir=${join(directory, 'profile')}`,
    ],
    env,
  });
  try {
    const page = await application.firstWindow();
    // Test-only owned URL and exact test certificate: no production URL option,
    // credential extraction, global certificate bypass or real Claude request.
    await application.evaluate(({ app, session }, pin) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(app.getAppPath() + '/package.json');
      const { X509Certificate } = require('node:crypto');
      const module = require(
        require('node:path').join(app.getAppPath(), 'electron/browser-view.cjs'),
      );
      const original = module.createBrowserView;
      module.createBrowserView = (options: { partition: string }) => {
        session
          .fromPartition(options.partition)
          .setCertificateVerifyProc((request, callback) =>
            callback(
              request.hostname === 'default.example.test' &&
                new X509Certificate(request.certificate.data).fingerprint256 === pin
                ? 0
                : -3,
            ),
          );
        return original({ ...options, url: 'https://default.example.test/' });
      };
    }, new X509Certificate(custom.cert).fingerprint256);
    await page.getByLabel('服务地址').fill(service.url);
    await page.getByLabel('服务凭据').fill(token);
    await page.getByText('高级连接选项', { exact: true }).click();
    await page
      .getByLabel('服务证书指纹', { exact: true })
      .fill(new X509Certificate(defaultCertificate.cert).fingerprint256);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: '打开Claude网页', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已打开Claude网页');
    const website = application
      .context()
      .pages()
      .find((item) => item.url().startsWith('https://default.example.test/'))!;
    await expect(website.getByLabel('测试输入')).toBeVisible();
    await expect
      .poll(() =>
        application.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].contentView.children[0]?.getBounds().height ?? 0,
        ),
      )
      .toBeGreaterThan(100);
    const bounds = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds(),
    );
    const toolbar = (await page.locator('.claude-web-toolbar').boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(Math.floor(toolbar.y + toolbar.height));
    expect(bounds.width).toBeGreaterThan(500);
    await website.getByLabel('测试输入').fill('本地中文内容');
    expect(await website.evaluate(() => typeof (window as Window).desktop)).toBe('undefined');
    await page.screenshot({ path: '.local/screenshots/claude-web-v2-enabled.png' });
    await website.screenshot({ path: '.local/screenshots/claude-web-v2-owned-page.png' });
    const viewVisible = () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()),
      );
    await page.getByRole('tab', { name: 'Coding', exact: true }).click();
    await expect.poll(viewVisible).toBe(false);
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect.poll(viewVisible).toBe(true);
    await expect(website.getByLabel('测试输入')).toHaveValue('本地中文内容');
    await page.getByRole('button', { name: '登录需要处理', exact: true }).click();
    await expect(page.getByText('已暂停网页操作，请管理员在此客户端人工重新登录。')).toBeVisible();
    await expect.poll(viewVisible).toBe(false);
    await page.getByRole('button', { name: '管理员重新登录', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已打开Claude网页');
    await page.evaluate(() => window.desktop!.disconnectProxy());
    await expect.poll(viewVisible).toBe(false);
  } finally {
    await application.close();
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
