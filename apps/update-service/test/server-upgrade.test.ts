import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { managedServerHandler } from '../../server/src/managed-server-http.ts';
import type { ServerRelease } from '../../../packages/managed-server/src/index.ts';
import { upgradeCommand } from '../src/server-distribution.ts';

const script = readFileSync(new URL('../web/server-upgrade.cjs', import.meta.url));
// A future build/protocol proves the command follows publication, rather than hardcoding Build 3.
const release = {
  build: 7,
  protocol: 37,
  sha256: 'a'.repeat(64),
  appVersion: '0.3.6',
} as ServerRelease;
const command = upgradeCommand(release, script);

test('generated upgrade command uses the actual managed HTTP contract and preserves admission', async (t) => {
  assert.equal(command.split('\n').length, 1);
  assert.match(command, /^sudo python3 -c /);
  const wrapper = Buffer.from(
    /b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(command)![1],
    'base64',
  ).toString();
  assert.doesNotMatch(wrapper, /ba938975|shell=True/);
  const loader = JSON.parse(/^program = (.+)$/m.exec(wrapper)![1]);
  for (const scenario of ['success', 'busy', 'mismatch', 'rollback', 'already-installed']) {
    await t.test(scenario, async () => {
      let activated = false,
        prepared = false;
      const calls: string[] = [];
      const handler = managedServerHandler({
        token: 'synthetic_upgrade_token_1234567890',
        admission: { enter: () => scenario !== 'busy', leave() {} },
        backend: {
          async status() {
            calls.push('status');
            const upgraded =
              scenario === 'already-installed' || (activated && scenario !== 'rollback');
            return {
              schema: 1,
              target: null,
              phase: upgraded ? 'committed' : activated ? 'rolled-back' : 'idle',
              current: { ...release, build: upgraded ? release.build : 2 },
            };
          },
          async check(protocol) {
            calls.push('check');
            assert.equal(protocol, release.protocol);
            return {
              schema: 1,
              current: { ...release, build: 2 },
              index: null,
              compatible: true,
              reason: 'available',
              candidate: {
                ...release,
                sha256: scenario === 'mismatch' ? 'b'.repeat(64) : release.sha256,
              },
            };
          },
          async prepare(input) {
            calls.push('install');
            prepared = true;
            assert.deepEqual(input, {
              clientProtocol: release.protocol,
              confirmed: true,
              build: release.build,
              sha256: release.sha256,
            });
          },
          activate() {
            activated = true;
          },
        },
      });
      const server = createServer((req, res) => {
        if (!handler(req, res)) {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      try {
        const child = spawn(process.execPath, ['--input-type=commonjs', '-e', loader], {
          env: {
            ...process.env,
            PROXY_TOKEN: 'synthetic_upgrade_token_1234567890',
            PROXY_TLS_MODE: 'reverse-proxy',
            PROXY_PORT: String(address.port),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let output = '';
        child.stdout.on('data', (b) => (output += b));
        child.stderr.on('data', (b) => (output += b));
        const code = await new Promise((resolve, reject) => {
          child.on('exit', resolve);
          child.on('error', reject);
        });
        assert.equal(code, ['success', 'already-installed'].includes(scenario) ? 0 : 1, output);
        if (scenario === 'success')
          assert.match(output, /Build 7 \/ protocol 37 is installed and committed/);
        if (scenario === 'busy') assert.match(output, /HTTP 409: busy/);
        if (scenario === 'rollback') assert.match(output, /reported rolled-back/);
        if (scenario === 'mismatch' || scenario === 'busy') assert.equal(prepared, false);
        if (scenario === 'already-installed') assert.deepEqual(calls, ['status']);
        assert.doesNotMatch(output, /synthetic_upgrade_token/);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});

test(
  'download UI distinguishes upgrade from bootstrap and copies the exact target command',
  { skip: process.env.CC_UPDATE_UI_TEST !== '1', timeout: 30000 },
  async (t) => {
    const server = createServer((req, res) => {
      if (req.url === '/style.css') {
        res.setHeader('content-type', 'text/css');
        res.end(readFileSync(new URL('../web/style.css', import.meta.url)));
        return;
      }
      res.setHeader(
        'content-type',
        req.url === '/server-download.js' ? 'text/javascript' : 'text/html',
      );
      res.end(
        req.url === '/server-download.js'
          ? readFileSync(new URL('../web/server-download.js', import.meta.url))
          : '<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><main><section class="card"><h2>配套 Linux 服务端</h2><div id="server-download"></div></section><p id="notice"></p></main>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const browser = await chromium.launch({
      headless: true,
      channel: process.platform === 'win32' ? 'msedge' : undefined,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(async (upgrade) => {
      const modulePath = '/server-download.js';
      const { setupServerDownload } = await import(modulePath);
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            (window as any).copied = text;
          },
        },
      });
      (window as any).statusFixture = {
        published: true,
        expired: false,
        payload: {
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          release: { build: 7, protocol: 37, appVersion: '0.3.6', sha256: 'a'.repeat(64) },
        },
        downloadPath: '/fixture.tar.gz',
        command: 'sudo python3 bootstrap-fixture',
        upgradeCommand: upgrade,
        baseUpgradeCommand: 'sudo python3 cleanup-and-base-upgrade-fixture',
      };
      const ui = setupServerDownload({
        request: async () => (window as any).statusFixture,
        element: (tag: string, text?: string) => {
          const e = document.createElement(tag);
          if (text) e.textContent = text;
          return e;
        },
        notice: (text: string) => {
          document.getElementById('notice')!.textContent = text;
        },
      });
      (window as any).downloadUI = ui;
      await ui.refresh();
    }, command);
    await expect(page.getByLabel('已接入服务端升级命令')).toHaveValue(command);
    await expect(page.getByLabel('首次接入命令')).toHaveValue('sudo python3 bootstrap-fixture');
    await expect(page.getByLabel('清理并升级基础镜像（ubuntu-cc / 02 / 03）命令')).toHaveValue(
      'sudo python3 cleanup-and-base-upgrade-fixture',
    );
    await expect(page.locator('#server-download')).toContainText('升级到 Build 7');
    await expect(page.locator('#server-download')).toContainText(
      '02、03 支持已核对的 Build 5 基础镜像',
    );
    await page
      .getByRole('button', {
        name: '复制清理并升级基础镜像（ubuntu-cc / 02 / 03）命令',
        exact: true,
      })
      .click();
    assert.equal(
      await page.evaluate(() => (window as any).copied),
      'sudo python3 cleanup-and-base-upgrade-fixture',
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.evaluate(async () => {
      (window as any).statusFixture.payload.release.build = 9;
      (window as any).statusFixture.payload.release.protocol = 22;
      await (window as any).downloadUI.refresh();
    });
    await expect(page.locator('#server-download')).toContainText('Build 9 镜像与新审核策略');
    await expect(page.locator('#server-download')).toContainText('04、05、06 本轮不升级');
    await expect(page.locator('#server-download')).toContainText('只审核聊天/终端新发送的消息');
    mkdirSync(new URL('../../../.local/', import.meta.url), { recursive: true });
    await page.screenshot({
      path: new URL(
        '../../../.local/server-upgrade-admin-mobile.png',
        import.meta.url,
      ).pathname.replace(/^\/(\w:)/, '$1'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '复制已接入服务端升级命令', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).copied), command);
    await page.getByRole('button', { name: '复制首次接入命令', exact: true }).click();
    assert.equal(
      await page.evaluate(() => (window as any).copied),
      'sudo python3 bootstrap-fixture',
    );
    await page.evaluate(() => {
      (window as any).statusFixture.payload.expiresAt = new Date(0).toISOString();
    });
    await page.getByRole('button', { name: '复制已接入服务端升级命令', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('签名已过期');
    await expect(page.locator('textarea')).toHaveCount(0);
    await page.evaluate(async () => {
      (window as any).statusFixture.expired = true;
      await (window as any).downloadUI.refresh();
    });
    await expect(page.locator('#server-download')).toContainText('签名索引已过期');
    await expect(page.locator('button')).toHaveCount(0);
    assert.deepEqual(errors, []);
  },
);
