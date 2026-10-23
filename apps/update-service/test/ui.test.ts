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
        'ubuntu-test': createHash('sha256')
          .update('test_node_browser_12345678901234567890')
          .digest('hex'),
      },
    });
    const store = await UpdateStore.open(config.dataDir, config.trustedKeys, config.adminName);
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
          schema: 1,
          nodeId: 'ubuntu-test',
          observedAt: new Date().toISOString(),
          account: { id: 'a'.repeat(64), subscriptionType: 'max' },
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
    await page.getByLabel('管理令牌', { exact: true }).fill(token);
    await page.getByRole('button', { name: '登录管理' }).click();
    await expect(page.getByRole('heading', { name: '当前发布' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '账号监控' })).toBeVisible();
    await expect(
      page.locator('#monitor-nodes').getByText('ubuntu-test', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('#monitor-nodes').getByText('5 小时额度：82%', { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('#monitor-nodes').getByText('数据已过期', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(
      page.locator('#monitor-nodes').getByText('5 小时额度：82%', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('签名索引（JSON）').setInputFiles(signed);
    await page.getByRole('button', { name: '添加候选' }).click();
    await expect(page.getByText('签名索引已验证，候选已添加。')).toBeVisible();
    await page.getByLabel('对应安装包').setInputFiles(artifact);
    await page.getByRole('button', { name: '上传并校验' }).click();
    await expect(page.getByText('安装包校验通过，可以发布。')).toBeVisible();
    await page.getByRole('button', { name: '发布到通道' }).click();
    await expect(page.getByText('通道已更新。')).toBeVisible();
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.getByText(notes, { exact: true }).count(), 2);
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
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('button', { name: '登录管理' })).toBeVisible();
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.deepEqual(scriptErrors, []);
  },
);
