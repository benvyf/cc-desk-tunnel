import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { signIndex } from '../../../packages/managed-updates/src/index.ts';
import { validateConfig } from '../src/config.ts';
import { createUpdateServer } from '../src/http.ts';
import { UpdateStore } from '../src/store.ts';
import { PasswordAuth } from '../src/password-auth.ts';

test(
  'real browser logs in, uploads, publishes, withdraws and renders notes as text over test TLS',
  { skip: process.env.CC_UPDATE_UI_TEST !== '1', timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cc-update-ui-'));
    const keys = generateKeyPairSync('ed25519');
    const token = 'temporary_browser_admin_token_1234567890';
    let backendPort = 0;
    // Existing explicitly public TLS fixture, trusted only by this isolated test context.
    const proxy = httpsServer(defaultCertificate, (req, res) => {
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode!, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `https://127.0.0.1:${address.port}`;
    const config = validateConfig({
      origin,
      dataDir: join(root, 'data'),
      port: 8817,
      adminName: 'browser-test',
      adminTokenSha256: createHash('sha256').update(token).digest('hex'),
      trustedKeys: { test: keys.publicKey.export({ type: 'spki', format: 'pem' }) },
      monitorNodes: {
        'ubuntu-pending': createHash('sha256')
          .update('test_pending_browser_12345678901234567890')
          .digest('hex'),
        'ubuntu-test': createHash('sha256')
          .update('test_node_browser_12345678901234567890')
          .digest('hex'),
      },
    });
    const store = await UpdateStore.open(config.dataDir, config.trustedKeys, config.adminName);
    const enrollmentDir = join(config.dataDir, 'private/enrollment');
    await mkdir(enrollmentDir, { recursive: true });
    const enrollmentBundle = Buffer.from('synthetic enrollment test fixture');
    await writeFile(join(enrollmentDir, 'ubuntu-test.tar.gz'), enrollmentBundle);
    await writeFile(
      join(enrollmentDir, 'packages.json'),
      JSON.stringify({
        'ubuntu-test': {
          sha256: createHash('sha256').update(enrollmentBundle).digest('hex'),
          tokenSha256: config.monitorNodes!['ubuntu-test'],
          version: '0.3.6',
        },
      }),
    );
    const server = await createUpdateServer(store, config);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const backend = server.address();
    assert.ok(backend && typeof backend !== 'string');
    backendPort = backend.port;
    t.after(async () => {
      proxy.closeAllConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    const browser = await chromium.launch({
      headless: true,
      channel:
        process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1100 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copiedDownload: string }).copiedDownload = text;
          },
        },
      });
    });
    await page.clock.install();
    const scriptErrors: string[] = [];
    page.on('pageerror', (e) => scriptErrors.push(e.message));
    const bytes = Buffer.from('browser installer fixture');
    const notes = '<img src=x onerror=alert(1)>';
    function index(revision: number, empty: boolean) {
      return signIndex(
        {
          schema: 1,
          product: 'cc-desk-tunnel-managed',
          channel: 'pilot',
          platform: 'win32',
          arch: 'x64',
          revision,
          issuedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          state: empty ? 'empty' : 'published',
          release: empty
            ? null
            : {
                build: 1,
                appVersion: '0.3.6',
                protocol: 20,
                sourceCommit: 'a'.repeat(40),
                notes,
                filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
                size: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
        },
        'test',
        keys.privateKey,
      );
    }
    const signed = join(root, 'index.json');
    const artifact = join(root, 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe');
    await writeFile(signed, index(1, false));
    await writeFile(artifact, bytes);
    const sampledAt = new Date(Date.now() - 3600000).toISOString();
    const reportResponse = await fetch(
      `http://127.0.0.1:${backendPort}/cc-updates/admin/api/monitor/report`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test_node_browser_12345678901234567890',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schema: 2,
          nodeId: 'ubuntu-test',
          observedAt: new Date().toISOString(),
          account: {
            id: createHash('sha256').update('owner@example.invalid').digest('hex'),
            email: 'owner@example.invalid',
            organization: '工作组甲',
            authMethod: 'oauth_token',
            apiProvider: 'firstParty',
            subscriptionType: 'max',
          },
          identity: { state: 'identified', measuredAt: sampledAt },
          quotaStatus: { state: 'error', measuredAt: sampledAt },
          rateLimits: {
            available: true,
            measuredAt: sampledAt,
            windows: [
              {
                name: 'five_hour',
                utilization: 82,
                resetsAt: new Date(Date.now() + 3600000).toISOString(),
              },
            ],
          },
          usage: null,
        }),
      },
    );
    assert.equal(reportResponse.status, 204);
    await page.goto(origin + '/cc-updates/admin/');
    const pageReads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/admin/api/'))
        pageReads.push(new URL(request.url()).pathname.split('/api/')[1]!);
    });
    await page.getByText('使用旧管理令牌', { exact: true }).click();
    await page.getByLabel('管理令牌', { exact: true }).fill(token);
    await page.getByRole('button', { name: '使用令牌登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号监控' })).toBeVisible();
    await expect(page.locator('#show-accounts')).toHaveAttribute('aria-current', 'page', {
      timeout: 1000,
    });
    await expect(page).toHaveURL(origin + '/cc-updates/admin/accounts');
    await expect(page.locator('#updates-panel')).toBeHidden();
    await expect(page.locator('#moderation-panel')).toBeHidden();
    assert.deepEqual(pageReads, ['monitor']);
    await page.getByRole('button', { name: '一键接入', exact: true }).click();
    await expect(page.getByLabel('选择接入节点')).toHaveValue('ubuntu-test');
    await expect(page.locator('#enrollment-node option[value="ubuntu-pending"]')).toBeDisabled();
    await page.getByRole('button', { name: '生成接入命令', exact: true }).click();
    await expect(page.getByLabel('Ubuntu 安装命令')).toHaveValue(/^sudo python3 -c /);
    await expect(page.locator('#enrollment-expiry')).toContainText('仅能领取一次');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.ok(
      await page.evaluate(
        () =>
          document.querySelector('nav')!.getBoundingClientRect().bottom <=
          document.querySelector('#monitor-panel')!.getBoundingClientRect().top,
      ),
    );
    await page.locator('#show-updates').click();
    await expect(page.locator('#downloads a')).toHaveCount(0);
    await expect(page).toHaveURL(origin + '/cc-updates/admin/updates');
    await expect(page.locator('#monitor-panel')).toBeHidden();
    await expect(page.getByRole('heading', { name: '当前发布' })).toBeVisible();
    assert.equal(pageReads.at(-1), 'status');
    await expect(page.locator('body')).not.toHaveClass(/pending/);
    const updateReads = [...pageReads];
    await page.clock.runFor(30001);
    assert.deepEqual(pageReads, updateReads, 'hidden account page must not poll');
    await page.goBack();
    await expect(page).toHaveURL(origin + '/cc-updates/admin/accounts');
    await expect(page.getByRole('heading', { name: '账号监控' })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { name: '当前发布' })).toBeVisible();
    await page.locator('#show-accounts').click();
    await expect(page.locator('body')).not.toHaveClass(/pending/);
    const monitorReads = pageReads.filter((path) => path === 'monitor').length;
    await page.clock.runFor(30001);
    await expect
      .poll(() => pageReads.filter((path) => path === 'monitor').length)
      .toBeGreaterThan(monitorReads);
    await expect(
      page.getByRole('heading', { name: 'owner@example.invalid', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#monitor-node-status')).toContainText(
      'ubuntu-pending：等待首次上报',
    );
    await expect(page.locator('#monitor-nodes')).toContainText('工作组甲');
    await expect(page.locator('#monitor-nodes')).toContainText('最近额度读取失败');
    await expect(
      page.locator('#monitor-nodes').getByText('ubuntu-test', { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator('#monitor-nodes')
        .getByText('5 小时额度：已用 82% · 剩余约 18%', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('#monitor-nodes').getByText('数据已过期', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(
      page
        .locator('#monitor-nodes')
        .getByText('5 小时额度：已用 82% · 剩余约 18%', { exact: true }),
    ).toBeVisible();
    const accountNote = '主力账号 <img src=x onerror=alert(1)>';
    await page.getByLabel('账号备注').fill(accountNote);
    let releasePage!: () => void;
    const holdPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    await page.route('**/admin/api/status', async (route) => {
      await holdPage;
      await route.continue();
    });
    await page.locator('#show-updates').click();
    await expect(page.locator('#monitor-panel')).toBeHidden();
    await page.goBack();
    releasePage();
    await expect(page.locator('body')).not.toHaveClass(/pending/);
    await page.unroute('**/admin/api/status');
    await expect(page).toHaveURL(origin + '/cc-updates/admin/accounts');
    await expect(page.locator('#updates-panel')).toBeHidden();
    await expect(page.getByLabel('账号备注')).toHaveValue(accountNote);
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(page.getByLabel('账号备注')).toHaveValue(accountNote);
    let releaseNote!: () => void;
    const holdNote = new Promise<void>((resolve) => {
      releaseNote = resolve;
    });
    await page.route('**/monitor/accounts/*/note', async (route) => {
      await holdNote;
      await route.continue();
    });
    await page.getByRole('button', { name: '保存备注' }).click();
    await page.getByLabel('账号备注').fill(accountNote + '（未保存的新修改）');
    releaseNote();
    await expect(page.getByText('账号备注已保存。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('账号备注')).toHaveValue(accountNote + '（未保存的新修改）');
    await page.unroute('**/monitor/accounts/*/note');
    await page.getByLabel('账号备注').fill(accountNote);
    await page.getByLabel('搜索账号').fill('no-matching-account');
    await expect(page.locator('#monitor-nodes')).toContainText('没有匹配的账号');
    await page.getByLabel('搜索账号').fill('主力账号');
    await expect(
      page.getByRole('heading', { name: 'owner@example.invalid', exact: true }),
    ).toBeVisible();
    await page.getByLabel('搜索账号').fill('');
    const ownerCard = page
      .locator('#monitor-nodes article')
      .filter({ has: page.getByRole('heading', { name: 'owner@example.invalid', exact: true }) });
    const changedAt = new Date(Date.now() + 10).toISOString();
    const changed = await fetch(
      `http://127.0.0.1:${backendPort}/cc-updates/admin/api/monitor/report`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test_node_browser_12345678901234567890',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schema: 2,
          nodeId: 'ubuntu-test',
          observedAt: changedAt,
          account: {
            id: createHash('sha256').update('second@example.invalid').digest('hex'),
            email: 'second@example.invalid',
            subscriptionType: 'pro',
            organization: null,
            authMethod: null,
            apiProvider: null,
          },
          identity: { state: 'identified', measuredAt: changedAt },
          quotaStatus: { state: 'unknown', measuredAt: null },
          rateLimits: null,
          usage: null,
        }),
      },
    );
    assert.equal(changed.status, 204);
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(
      page.getByRole('heading', { name: 'second@example.invalid', exact: true }),
    ).toBeVisible();
    await expect(ownerCard).toContainText('历史绑定');
    await expect(ownerCard.getByLabel('账号备注')).toHaveValue(accountNote);
    await expect(page.locator('#monitor-count')).toContainText('已记录 2 个账号');
    await page.screenshot({
      path: fileURLToPath(new URL('../../../.local/admin-accounts-desktop.png', import.meta.url)),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({
      path: fileURLToPath(new URL('../../../.local/admin-accounts-mobile.png', import.meta.url)),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('#show-updates').click();
    await page.getByLabel('签名索引（JSON）').setInputFiles(signed);
    await page.getByRole('button', { name: '添加候选' }).click();
    await expect(page.getByText('签名索引已验证，候选已添加。')).toBeVisible();
    await page.getByLabel('对应安装包').setInputFiles(artifact);
    await page.getByRole('button', { name: '上传并校验' }).click();
    await expect(page.getByText('安装包校验通过，可以发布。')).toBeVisible();
    await page.getByRole('button', { name: '发布到通道' }).click();
    await expect(page.getByText('通道已更新。')).toBeVisible();
    const download = page.locator('#downloads').getByRole('link', { name: '下载完整安装包' });
    const downloadPath = '/cc-updates/v1/artifacts/1/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe';
    await expect(download).toHaveAttribute('href', downloadPath);
    await expect(page.locator('#downloads')).toContainText('v0.3.6 · Build 1');
    await expect(page.locator('#downloads')).toContainText('协议 20');
    await page.getByRole('button', { name: '复制下载链接', exact: true }).click();
    assert.equal(
      await page.evaluate(() => (window as unknown as { copiedDownload: string }).copiedDownload),
      origin + downloadPath,
    );
    await page.clock.fastForward(2 * 86400000);
    await expect(page.locator('#downloads a')).toHaveCount(0);
    await expect(page.locator('#downloads')).toContainText('已过期');
    await page.clock.setSystemTime(new Date());
    await page.locator('#refresh').click();
    await expect(download).toBeVisible();
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.getByText(notes, { exact: true }).count(), 3);
    await mkdir(new URL('../../../.local/', import.meta.url), { recursive: true });
    await page.screenshot({
      path: fileURLToPath(new URL('../../../.local/update-service-desktop.png', import.meta.url)),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({
      path: fileURLToPath(new URL('../../../.local/update-service-mobile.png', import.meta.url)),
      fullPage: true,
    });
    await writeFile(signed, index(2, true));
    await page.getByLabel('签名索引（JSON）').setInputFiles(signed);
    await page.getByRole('button', { name: '添加候选' }).click();
    await expect(page.getByRole('button', { name: '确认撤回' })).toBeVisible();
    await page.getByRole('button', { name: '确认撤回' }).click();
    await expect(page.locator('#channels').getByText('已撤回发布')).toBeVisible();
    await expect(page.locator('#downloads a')).toHaveCount(0);
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByLabel('Ubuntu 安装命令')).toHaveValue('');
    await expect(page.getByRole('button', { name: '登录管理' })).toBeVisible();
    await expect(page.locator('#downloads')).toBeEmpty();
    await page.getByLabel('管理令牌', { exact: true }).fill(token);
    await page.getByRole('button', { name: '使用令牌登录', exact: true }).click();
    await page.locator('#show-accounts').click();
    await expect(ownerCard.getByLabel('账号备注')).toHaveValue(accountNote);
    await page.getByRole('button', { name: '退出登录' }).click();
    const setupToken = await new PasswordAuth(join(root, 'data/private')).issueSetup();
    await page.goto('about:blank');
    await page.goto(origin + '/cc-updates/admin/#setup=' + setupToken);
    await page.getByLabel('新管理员密码', { exact: true }).fill('synthetic browser password');
    await page.getByLabel('确认管理员密码', { exact: true }).fill('synthetic browser password');
    await page.getByRole('button', { name: '保存密码并登录', exact: true }).click();
    await expect(ownerCard.getByLabel('账号备注')).toHaveValue(accountNote);
    await page.locator('#show-moderation').click();
    await expect(page).toHaveURL(origin + '/cc-updates/admin/moderation');
    await expect(page.locator('#monitor-panel')).toBeHidden();
    await expect(page.locator('#updates-panel')).toBeHidden();
    await expect(page.locator('#moderation-mode')).toBeVisible();
    await expect(page.locator('#jev-usage')).not.toContainText('读取用量中');
    await page.reload();
    await expect(page.getByRole('button', { name: '登录管理', exact: true })).toBeVisible();
    pageReads.length = 0;
    await page.getByLabel('管理员密码', { exact: true }).fill('synthetic browser password');
    await page.getByRole('button', { name: '登录管理', exact: true }).click();
    await expect(page.locator('#moderation-mode')).toBeVisible();
    await expect(page.locator('#jev-usage')).not.toContainText('读取用量中');
    assert.deepEqual(pageReads, ['moderation/config', 'moderation/events', 'moderation/usage']);
    await expect(page.locator('#monitor-panel')).toBeHidden();
    await page.screenshot({
      path: fileURLToPath(new URL('../../../.local/admin-moderation-mobile.png', import.meta.url)),
      fullPage: true,
    });
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('管理员密码', { exact: true }).fill('synthetic browser password');
    await page.getByRole('button', { name: '登录管理', exact: true }).click();
    await page.locator('#show-accounts').click();
    await expect(ownerCard.getByLabel('账号备注')).toHaveValue(accountNote);
    await page.getByRole('button', { name: '退出登录' }).click();
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(scriptErrors, []);
  },
);
