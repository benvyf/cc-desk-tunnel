import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

// Phase 3l: the account page while its values are still being read, and the settings pages' smaller fixes —
// the about page's version and release notes, the help page's contents, the shortcuts' keycaps, and the note under
// the new-session defaults.
const url = 'ws://127.0.0.1:18920/ws';
async function connect(page: Page) {
  await page.routeWebSocket(url, (route) => {
    const send = (value: object) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'device') return;
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        // Signed in, the plan known; no account number, no catalogue and no figures yet.
        send({
          type: 'account.state',
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'test@example.com',
          subscriptionType: 'Max',
          login: null,
        });
        return;
      }
      if (command.requestId) send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('settings-pages-test-token-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
}
const section = (page: Page, name: string) =>
  page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name, exact: true });

test('terminal prediction defaults on, persists locally and reports storage failure', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await section(page, '常规').click();
  const toggle = page.getByRole('switch', { name: '终端输入预测（实验性）', exact: true });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('proxy-prefs')!).terminalPredictiveEcho,
    ),
  ).toBe(false);
  await page.reload();
  expect(
    await page.evaluate(async () => {
      const path = '/src/prefs.ts';
      return (await import(path)).getPrefs().terminalPredictiveEcho;
    }),
  ).toBe(false);
  await connect(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await section(page, '常规').click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'proxy-prefs')
        throw new DOMException('storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await toggle.click();
  await expect(
    page.getByRole('alert').filter({ hasText: '无法保存终端输入预测设置' }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('terminal display defaults to the scroll mode and explains it is not about the window', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await section(page, '常规').click();
  const group = page.getByRole('radiogroup', { name: '终端显示方式' });
  await expect(group.getByRole('radio', { name: '滚动模式' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const row = page.locator('.setting-row').filter({ has: group });
  await expect(row).toContainText('与窗口是否最大化无关');
  await expect(row).toContainText('没有网络等待');
  await group.getByRole('radio', { name: '整屏模式' }).click();
  await expect(row).toContainText('选中文字需按住 Shift');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-prefs')!).terminalDisplay),
  ).toBe('screen');
});

test('invalid terminal prediction preference stays off', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ terminalPredictiveEcho: 'true' })),
  );
  await page.goto('/');
  expect(
    await page.evaluate(async () => {
      const path = '/src/prefs.ts';
      return (await import(path)).getPrefs().terminalPredictiveEcho;
    }),
  ).toBe(false);
});

test('the account page shows grey bars while reading, the column’s avatar, and lines up with the other pages', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: /^账号/ }).click();
  const account = page.getByRole('region', { name: '账号信息' });
  await expect(account).toHaveAttribute('aria-busy', 'true');
  await expect(account.locator('.account-identity h2 .skeleton')).toBeVisible();
  await expect(account.locator('.account-identity p')).toHaveText('Max');
  await expect(account.locator('.quota-pending')).toHaveCount(3);
  await expect(account).not.toContainText(/尚未读取|未读取|未提供|等待读取|原生/);
  await expect(account).toContainText('按 API 价格估算');
  await expect(account.locator('.account-avatar svg.account-mark')).toBeVisible();
  // The refresh button sits in the title's row.
  const title = (await account.getByRole('heading', { level: 1 }).boundingBox())!;
  const refresh = (await account.getByRole('button', { name: '刷新账号信息' }).boundingBox())!;
  expect(Math.abs(refresh.y + refresh.height / 2 - (title.y + title.height / 2))).toBeLessThan(4);
  // Its title starts where the other settings pages' titles start.
  await section(page, '常规').click();
  const general = (await page
    .locator('.workspace')
    .getByRole('heading', { level: 1, name: '常规' })
    .boundingBox())!;
  expect(Math.abs(general.x - title.x)).toBeLessThanOrEqual(1);
  // E2: the note under the new-session defaults keeps its distance from the last row.
  const note = page.locator('.page-body .card + p.muted').first();
  const gap = await note.evaluate(
    (node) =>
      node.getBoundingClientRect().top -
      node.previousElementSibling!.getBoundingClientRect().bottom,
  );
  expect(gap).toBeGreaterThanOrEqual(12);
});

test('about names the web version and opens the release notes; help has contents; shortcuts are keycaps', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await section(page, '关于与更新').click();
  const about = page.getByRole('region', { name: '关于与更新' });
  await expect(about.locator('.setting-row').filter({ hasText: '客户端版本' })).toContainText(
    '网页版',
  );
  // Only the desktop client looks for its own updates.
  await expect(about.getByRole('button', { name: '检查更新' })).toHaveCount(0);
  await about
    .locator('.setting-row')
    .filter({ hasText: '版本说明' })
    .getByRole('button', { name: '查看', exact: true })
    .click();
  const notes = page.getByRole('dialog', { name: '0.3.7 的更新内容' });
  await expect(notes).toBeVisible();
  // The notes stay in the window: no button or link to GitHub.
  await expect(notes).not.toContainText(/GitHub/i);
  await expect(notes).not.toContainText(/(?:上游\s*)?#\d+/);
  await expect(notes.locator('a[href*="github.com"]')).toHaveCount(0);
  await expect(notes.getByRole('button')).toHaveText(['', '关闭']);
  await notes.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(notes).toHaveCount(0);

  await section(page, '帮助').click();
  const contents = page.getByRole('navigation', { name: '帮助目录' }).getByRole('button');
  // One link per topic, the keys last.
  await expect(contents).toHaveCount(await page.locator('.page-heading[id^="help-"]').count());
  expect(await contents.count()).toBeGreaterThan(8);
  await expect(contents.last()).toHaveText('按键');
  await contents.filter({ hasText: '常见问题' }).click();
  await expect(page.getByRole('heading', { name: '常见问题', exact: true })).toBeInViewport();

  await section(page, '快捷键').click();
  const stop = page.locator('.setting-row').filter({ hasText: '停止当前回答' });
  await expect(stop.locator('kbd.keycap')).toHaveText(['Esc', 'Esc']);
  // “恢复默认组合键” starts where the rows' titles start.
  const reset = page.getByRole('button', { name: '恢复默认组合键', exact: true });
  const words = await reset.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().left;
  });
  const row = (await page
    .locator('.setting-row strong')
    .filter({ hasText: '后退' })
    .boundingBox())!;
  expect(Math.abs(words - row.x)).toBeLessThanOrEqual(1);
});
