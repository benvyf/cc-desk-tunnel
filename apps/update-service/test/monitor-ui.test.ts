import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';

test(
  'device-first console keeps snapshots, filtering, account edits and device settings usable',
  {
    skip: process.env.CC_UPDATE_UI_TEST !== '1',
    timeout: 90000,
  },
  async (t) => {
    const browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const now = Date.now();
    const recent = new Date(now - 2 * 60000).toISOString();
    const old = new Date(now - 3600000).toISOString();
    const account = (id: string, email: string, subscriptionType = 'max') => ({
      id,
      email,
      subscriptionType,
      organization: '个人工作空间',
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
    });
    const profile = account('a'.repeat(64), 'benben@example.com');
    const other = account('b'.repeat(64), 'studio@example.com', 'pro');
    const sample = (nodeId: string, profile: any, at: string, used: number) => ({
      nodeId,
      account: profile,
      observedAt: recent,
      receivedAt: recent,
      identity: { state: 'identified', measuredAt: recent },
      quotaStatus: { state: 'ok', measuredAt: at },
      rateLimits: {
        available: true,
        measuredAt: at,
        windows: [
          {
            name: 'five_hour',
            utilization: used,
            resetsAt: new Date(now + 2 * 3600000).toISOString(),
          },
          {
            name: 'seven_day',
            utilization: 62,
            resetsAt: new Date(now + 3 * 86400000).toISOString(),
          },
        ],
      },
      usage: null,
    });
    const current = sample('ubuntu-cc', profile, recent, 35);
    const warning = {
      ...sample('ubuntu-studio', other, old, 93),
      quotaStatus: { state: 'error', measuredAt: recent },
    };
    const signedOut = {
      ...sample('ubuntu-lab', null, old, 0),
      receivedAt: old,
      rateLimits: null,
      identity: { state: 'signed_out', measuredAt: old },
    };
    const former = sample('ubuntu-cc', other, old, 12);
    const data = {
      configuredNodes: ['ubuntu-cc', 'ubuntu-studio', 'ubuntu-lab', 'ubuntu-new'],
      nodes: [current, warning, signedOut],
      accounts: [
        {
          id: profile.id,
          accountNumber: 'CC-001',
          firstSeenAt: old,
          lastSeenAt: recent,
          note: '日常开发 · 主力账号',
          snapshots: [current],
        },
        {
          id: other.id,
          accountNumber: 'CC-002',
          firstSeenAt: old,
          lastSeenAt: recent,
          note: '设计与协作',
          snapshots: [warning, former],
        },
      ],
    };
    const access = {
      nodes: data.configuredNodes.map((id) => ({
        id,
        name: id,
        url: 'wss://fixture.example/ws',
        fingerprint: '',
        credentialSaved: true,
      })),
      users: [
        {
          id: 'u1',
          email: 'owner@example.com',
          enabled: true,
          nodes: ['ubuntu-cc'],
          lastLogin: recent,
        },
      ],
    };
    let reports = 0;
    await page.route('https://console.example/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const reply = (value: unknown) => route.fulfill({ json: value });
      if (path.endsWith('/auth/login')) return reply({ sessionToken: 'fixture-session' });
      if (path.endsWith('/auth/logout')) return route.fulfill({ status: 204 });
      if (path.endsWith('/api/monitor')) {
        reports++;
        return reply(data);
      }
      if (/\/monitor\/accounts\/[^/]+\/note$/.test(path)) {
        data.accounts.find((account) => path.includes(account.id))!.note = route
          .request()
          .postDataJSON().note;
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith('/api/desktop-access')) return reply(access);
      if (path.includes('/desktop-access/nodes/')) {
        const input = route.request().postDataJSON();
        Object.assign(
          access.nodes.find((node) => path.endsWith(node.id))!,
          input,
        );
        return reply(access);
      }
      if (path.includes('/desktop-access/users/')) {
        Object.assign(access.users[0], route.request().postDataJSON());
        return reply(access);
      }
      if (path.endsWith('/api/status')) return reply({ channels: [], candidates: [], audit: [] });
      if (path.endsWith('/api/server')) return reply({ published: false });
      if (path.endsWith('/moderation/config'))
        return reply({
          mode: 'keyword_only',
          keywords: ['example'],
          baseUrl: 'https://api.example.com',
          model: 'model',
          timeoutMs: 10000,
          retentionDays: 30,
          thresholds: {},
          apiKeyConfigured: false,
        });
      if (path.endsWith('/moderation/events')) return reply([]);
      if (path.endsWith('/moderation/usage'))
        return reply({
          startedAt: old,
          requests: 0,
          errorRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          unreportedRequests: 0,
        });
      if (path.includes('/api/')) throw new Error('Unexpected API ' + path);
      const filename = /\.(js|css)$/.test(path) ? path.split('/').at(-1)! : 'index.html';
      return route.fulfill({
        body: await readFile(new URL('../web/' + filename, import.meta.url)),
        contentType: filename.endsWith('.js')
          ? 'text/javascript'
          : filename.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      });
    });
    await page.goto('https://console.example/cc-updates/admin/accounts');
    await expect(page.getByRole('heading', { name: '登录管理中心' })).toBeVisible();
    await mkdir('.local/console-redesign', { recursive: true });
    await page.screenshot({ path: '.local/console-redesign/login.png' });
    await page.getByLabel('管理员密码', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: '登录管理', exact: true }).click();
    await expect(page.locator('.device-card')).toHaveCount(4);
    await expect(page.locator('.stat-value')).toHaveText(['4', '2', '2', '3']);
    const primary = page.locator('[data-node-id="ubuntu-cc"]');
    const flagged = page.locator('[data-node-id="ubuntu-studio"]');
    await expect(primary).toContainText(profile.email);
    await expect(
      primary.getByRole('progressbar', { name: '5 小时额度', exact: true }),
    ).toHaveAttribute('aria-valuenow', '35');
    await expect(flagged).toContainText('数据已过期');
    await expect(flagged).toContainText('最近额度读取失败');
    await expect(page.locator('[data-node-id="ubuntu-lab"]')).toContainText('最近确认已退出登录');
    await expect(page.locator('[data-node-id="ubuntu-new"]')).toContainText('等待首次上报');
    await expect(primary).not.toContainText(other.email);
    await page.screenshot({ path: '.local/console-redesign/monitor-desktop.png', fullPage: true });
    await page.getByLabel('设备状态', { exact: true }).selectOption('attention');
    await expect(page.locator('.device-card')).toHaveCount(3);
    await page.getByLabel('设备状态', { exact: true }).selectOption('waiting');
    await expect(page.locator('.device-card')).toHaveCount(1);
    await page.getByLabel('设备状态', { exact: true }).selectOption('all');
    const search = page.getByLabel('搜索设备或账号', { exact: true });
    await search.fill('ubuntu-studio');
    await expect(page.locator('.device-card')).toHaveCount(1);
    await expect(flagged).toBeVisible();
    await search.fill('studio@example.com');
    await expect(page.locator('.device-card')).toHaveCount(2);
    await search.fill('unmatched');
    await expect(page.locator('#monitor-nodes')).toContainText('没有匹配');
    await search.fill('');
    const originalRates = structuredClone(current.rateLimits);
    for (const kind of ['empty', 'unknown-window', 'unavailable', 'unknown']) {
      current.rateLimits = structuredClone(originalRates);
      current.quotaStatus.state = 'ok';
      if (kind === 'empty') current.rateLimits.windows = [];
      else if (kind === 'unknown-window') (current.rateLimits.windows[0] as any).utilization = null;
      else current.quotaStatus.state = kind;
      await page.getByRole('button', { name: '刷新账号数据' }).click();
      await expect(page.locator('.stat-value').last()).toHaveText('4');
      await page.getByLabel('设备状态', { exact: true }).selectOption('attention');
      await expect(primary).toBeVisible();
    }
    current.rateLimits = originalRates;
    current.quotaStatus.state = 'ok';
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(page.locator('.stat-value').last()).toHaveText('3');
    await page.getByLabel('设备状态', { exact: true }).selectOption('all');
    await page.getByRole('button', { name: '查看详情 ubuntu-cc', exact: true }).click();
    await expect(page.locator('#monitor-overview')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Claude 账号' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('#access-claude .account-record')).toHaveCount(2);
    await expect(page.locator('#access-claude')).not.toContainText('ubuntu-studio');
    await expect(page.locator('#access-claude')).toContainText('历史绑定');
    const owner = page
      .locator('#access-claude .account-record')
      .filter({ has: page.getByRole('heading', { name: profile.email, exact: true }) });
    await owner.getByText('编辑账号备注', { exact: true }).click();
    const note = owner.getByLabel('账号备注');
    await note.fill('改名 <img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(note).toHaveValue('改名 <img src=x onerror=alert(1)>');
    await owner.getByRole('button', { name: '保存备注' }).click();
    await expect(page.locator('#notice')).toContainText('已保存');
    await expect(page.locator('img')).toHaveCount(0);
    await page.getByRole('tab', { name: '连接配置' }).click();
    await page.getByLabel('工作空间名称').fill('我的开发工作站');
    await page.getByText('高级配置 · 传统服务凭据', { exact: true }).click();
    await page.getByLabel('更新服务凭据').fill('unsaved-fixture-credential');
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(page.getByLabel('工作空间名称')).toHaveValue('我的开发工作站');
    await expect(page.getByLabel('更新服务凭据')).toHaveValue('unsaved-fixture-credential');
    await page.getByRole('button', { name: '保存连接配置' }).click();
    await expect(page.locator('#notice')).toContainText('连接配置已保存');
    await page.getByRole('tab', { name: '连接配置' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '登录用户' })).toBeFocused();
    await expect(page.getByRole('tab', { name: '登录用户' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: '编辑 / 重置密码' }).click();
    await page.getByLabel('启用此用户').uncheck();
    await page.getByRole('button', { name: '刷新账号数据' }).click();
    await expect(page.getByLabel('启用此用户')).not.toBeChecked();
    await page.getByRole('button', { name: '保存用户', exact: true }).click();
    await expect(page.getByRole('cell', { name: '已停用' })).toBeVisible();
    await page.getByRole('button', { name: '启用', exact: true }).click();
    await expect(page.getByRole('cell', { name: '已启用' })).toBeVisible();
    await expect(page.locator('#notice')).toHaveText('用户已启用。');
    await page.getByRole('button', { name: '停用', exact: true }).click();
    await expect(page.getByRole('cell', { name: '已停用' })).toBeVisible();
    await expect(page.locator('#notice')).toContainText('原有登录已撤销');
    await page.screenshot({ path: '.local/console-redesign/device-users.png', fullPage: true });
    await page.getByRole('button', { name: '返回账号监控' }).click();
    await expect(primary).toBeVisible();
    await expect(primary.getByRole('button', { name: '查看详情 ubuntu-cc' })).toBeFocused();
    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `no horizontal overflow at ${width}`,
      );
      await page.screenshot({
        path: `.local/console-redesign/monitor-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.locator('#show-updates').click();
    await expect(page.getByRole('heading', { name: '当前发布' })).toBeVisible();
    await page.screenshot({ path: '.local/console-redesign/updates.png', fullPage: true });
    await page.locator('#show-moderation').click();
    await expect(page.getByRole('heading', { name: '审核策略' })).toBeVisible();
    await page.screenshot({ path: '.local/console-redesign/moderation.png', fullPage: true });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.locator('#monitor-nodes')).toBeEmpty();
    await expect(page.locator('#access-claude')).toBeEmpty();
    assert.ok(reports >= 3);
    assert.deepEqual(errors, []);
  },
);
