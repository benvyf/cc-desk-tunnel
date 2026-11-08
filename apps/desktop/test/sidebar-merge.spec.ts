import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { connection, contrast, createSession, login } from './helpers.ts';

// The side column and the rail are one thing in two forms: open, the column carries the pages as rows and the
// account at its foot; closed, it folds to the 52px rail. These follow it through both forms and every page.

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

test('the open column carries search, the schedules and the account; the rail and the title bar pill are gone', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const side = page.locator('.sidebar');
  await expect(page.locator('.rail')).toBeHidden();
  expect(
    await page.locator('.shell').evaluate((shell) => getComputedStyle(shell).gridTemplateColumns),
  ).toMatch(/^0px /);
  // The title bar no longer tells the connection; the account at the column's foot does.
  await expect(page.locator('.titlebar .connection-status')).toHaveCount(0);
  await expect(page.locator('.titlebar')).not.toContainText('已连接');
  // The heading keeps only the brand and the notices: search is a row now.
  await expect(page.locator('.sidebar-brand').getByRole('button', { name: '搜索' })).toHaveCount(0);
  const rows = ['新建会话', '搜索', '定时任务'].map((name) =>
    side.getByRole('button', { name, exact: true }),
  );
  const tops = [];
  for (const row of rows) {
    await expect(row).toBeVisible();
    const { y, height } = (await row.boundingBox())!;
    expect(height).toBe(34);
    tops.push(y);
  }
  expect(tops[0]).toBeLessThan(tops[1]);
  expect(tops[1]).toBeLessThan(tops[2]);
  expect(tops[2] + 34).toBeLessThanOrEqual((await box(page, '.session-list')).y);

  // The account: the mark on ink, who is signed in, and the connection; it opens the menu above itself.
  const account = page.getByRole('button', { name: '设置与账号', exact: true });
  await expect(account).toHaveCount(1);
  await expect(account).toHaveAttribute('aria-haspopup', 'menu');
  await expect(account).toHaveAccessibleDescription(/已连接/);
  await expect(account.locator('.connection-dot')).toHaveClass(/online/);
  await expect(page.locator('.sidebar-account')).toHaveCSS('height', '56px');
  const avatar = account.locator('.side-avatar');
  await expect(avatar).toHaveCSS('width', '30px');
  await expect(avatar).toHaveCSS('border-radius', '50%');
  await expect(avatar.locator('svg.account-mark')).toBeVisible();
  const foot = await box(page, '.sidebar-account');
  const column = await box(page, '.sidebar');
  expect(foot.y + foot.height).toBe(column.y + column.height);
  await account.click();
  const menu = page.getByRole('menu', { name: '设置与账号' });
  await expect(menu).toBeVisible();
  const opened = (await menu.boundingBox())!;
  expect(opened.y + opened.height).toBeLessThanOrEqual((await account.boundingBox())!.y);
  await expect(menu.getByRole('menuitem', { name: '设置', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Readable in both themes, at rest and under the pointer.
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.mouse.move(900, 400);
    for (const text of [account.locator('strong'), account.locator('.connection-status')])
      expect(await contrast(text), theme).toBeGreaterThanOrEqual(4.5);
    await account.hover();
    expect(await contrast(account.locator('strong')), `${theme} hover`).toBeGreaterThanOrEqual(4.5);
  }
});

test('search turns its row into the field in place and back, and nothing below it moves', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '原位搜索');
  const side = page.locator('.sidebar');
  const row = side.getByRole('button', { name: '搜索', exact: true });
  const field = page.getByLabel('搜索会话', { exact: true });
  const listTop = (await box(page, '.session-list')).y;
  const schedulesTop = (await side.getByRole('button', { name: '定时任务' }).boundingBox())!.y;
  // The shortcut shows on the row under the pointer.
  const hint = row.locator('kbd');
  await expect(hint).toHaveText('Ctrl+K');
  await expect(hint).toHaveCSS('opacity', '0');
  await row.hover();
  await expect(hint).toHaveCSS('opacity', '1');
  await expect(row).toHaveAccessibleName('搜索');

  const icon = (await row.locator('svg').boundingBox())!;
  await row.click();
  await expect(field).toBeFocused();
  await expect(row).toHaveCount(0);
  // The magnifier stays where it was.
  const fieldIcon = (await page.locator('.side-nav .session-search > svg').boundingBox())!;
  expect(fieldIcon.x).toBe(icon.x);
  expect((await field.boundingBox())!.height).toBe(34);
  expect((await box(page, '.session-list')).y).toBe(listTop);
  expect((await side.getByRole('button', { name: '定时任务' }).boundingBox())!.y).toBe(
    schedulesTop,
  );
  await field.fill(title);
  await expect(page.locator('.session-row')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(page.locator('.session-row').filter({ hasText: title })).toHaveCount(1);
  expect((await box(page, '.session-list')).y).toBe(listTop);

  // A search with words in it stays when the focus leaves; an empty one goes back to being a row.
  await row.click();
  await field.fill('原位');
  await page.locator('.workspace').click({ position: { x: 400, y: 300 } });
  await expect(field).toHaveValue('原位');
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await expect(field).toHaveCount(0);
  await row.click();
  await page.locator('.workspace').click({ position: { x: 400, y: 300 } });
  await expect(field).toHaveCount(0);
  await expect(row).toBeVisible();
});

test('Ctrl+K opens the search from any page and from the folded column, and is a shortcut like the others', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const field = page.getByLabel('搜索会话', { exact: true });
  await page.locator('.sidebar').getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('定时任务');
  await page.keyboard.press('Control+KeyK');
  await expect(field).toBeFocused();
  await expect(page.locator('.titlebar h1')).not.toHaveText('定时任务');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+KeyB');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.keyboard.press('Control+KeyK');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+KeyB');
  await page
    .getByRole('navigation', { name: '页面' })
    .getByRole('button', { name: '搜索' })
    .click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Comma');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '修改快捷键：搜索会话', exact: true })).toHaveText(
    'Ctrl+K',
  );
});

test('folded, the column is a 52px rail: new session, search, the pages, and the account', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  // A project to make new sessions in.
  await createSession(page, '图标栏');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const rail = page.getByRole('navigation', { name: '页面', exact: true });
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(rail).toBeVisible();
  expect((await rail.boundingBox())!.width).toBe(52);
  expect(
    await rail
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
  ).toEqual(['新建会话', '搜索', '会话', '定时任务', '设置与账号']);
  const create = rail.getByRole('button', { name: '新建会话', exact: true });
  await expect(create).toHaveCSS('width', '32px');
  await expect(create).toHaveCSS('border-radius', '50%');
  await expect(create).toHaveCSS('background-color', 'rgb(198, 97, 63)');
  for (const name of ['搜索', '会话', '定时任务']) {
    const button = rail.getByRole('button', { name, exact: true });
    await expect(button).toHaveCSS('width', '32px');
    await expect(button).toHaveCSS('border-radius', '8px');
    await expect(button.locator('svg')).toHaveCSS('width', '20px');
  }
  await expect(rail.getByRole('button', { name: '会话', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const avatar = rail.getByRole('button', { name: '设置与账号', exact: true });
  await expect(avatar).toHaveCSS('width', '30px');
  await expect(avatar.locator('.connection-dot')).toHaveClass(/online/);
  const railBox = (await rail.boundingBox())!;
  const avatarBox = (await avatar.boundingBox())!;
  expect(avatarBox.y + avatarBox.height).toBeGreaterThan(railBox.y + railBox.height - 50);
  // The account menu opens beside the rail.
  await avatar.click();
  const menu = page.getByRole('menu', { name: '设置与账号' });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.x).toBeGreaterThanOrEqual(railBox.x + railBox.width);
  await page.keyboard.press('Escape');

  await rail.getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(rail.getByRole('button', { name: '定时任务', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.titlebar h1')).toHaveText('定时任务');
  // A new session from another page goes to the conversations with it.
  await create.click();
  await expect(page.locator('.titlebar h1')).toHaveText('新会话');
  await expect(rail.getByRole('button', { name: '会话', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  await expect(rail).toBeHidden();
});

test('schedules and settings open their column with the way back, and keep the account', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('Control+Comma');
  // Before signing in, this computer's settings stand alone: the way back is to the login, with no account.
  await expect(page.getByRole('button', { name: '返回登录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回会话', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar-account')).toHaveCount(0);
  await expect(page.locator('.sidebar-resize')).toHaveCount(0);
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await login(page);

  const back = page.getByRole('button', { name: '返回会话', exact: true });
  await page.locator('.sidebar').getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page.locator('.sidebar-brand')).toHaveText('定时任务');
  const backBox = (await back.boundingBox())!;
  expect(backBox.y).toBeLessThan((await box(page, '.sidebar-brand')).y);
  await expect(page.locator('.sidebar-account')).toBeVisible();
  await expect(page.locator('.sidebar-resize')).toHaveCount(1);
  await back.click();
  await expect(page.locator('.sidebar').getByRole('button', { name: '搜索' })).toBeVisible();

  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.locator('.sidebar-brand')).toHaveText('设置');
  await expect(page.getByRole('button', { name: '设置与账号', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The settings' search is the same field as the conversations'.
  const search = page.getByLabel('搜索设置', { exact: true });
  await expect(search).toHaveCSS('height', '34px');
  await expect(page.locator('.session-search')).toHaveCount(1);
  await back.click();
  await expect(page.locator('.sidebar').getByRole('button', { name: '新建会话' })).toBeVisible();
});

test('the account tells whether the connection holds, open and folded', async ({ page }) => {
  let hold = false;
  const routes: WebSocketRoute[] = [];
  await page.routeWebSocket(connection().serverUrl, (route) => {
    // While held, every attempt to reconnect is refused.
    if (hold) {
      void route.close();
      return;
    }
    route.connectToServer();
    routes.push(route);
  });
  await page.goto('/');
  await login(page);
  const status = page.locator('.sidebar-account .connection-status');
  await expect(status).toContainText('已连接');
  hold = true;
  await routes.at(-1)!.close();
  await expect(status).toContainText('重连中');
  await expect(status.locator('.connection-dot')).not.toHaveClass(/online/);
  await expect(page.locator('.titlebar')).not.toContainText('重连中');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const avatar = page
    .getByRole('navigation', { name: '页面' })
    .getByRole('button', { name: '设置与账号', exact: true });
  await expect(avatar).toHaveAttribute('title', '设置与账号 · 重连中');
  await expect(avatar.locator('.connection-dot')).not.toHaveClass(/online/);
  hold = false;
  await expect(avatar.locator('.connection-dot')).toHaveClass(/online/, { timeout: 20000 });
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await expect(status).toContainText('已连接');
});

test('on a narrow window the column opens over the page from the edge, over the rail', async ({
  page,
}) => {
  await page.setViewportSize({ width: 680, height: 800 });
  await page.goto('/');
  await login(page);
  const rail = page.getByRole('navigation', { name: '页面', exact: true });
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(rail).toBeVisible();
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(rail).toBeHidden();
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.x).toBe(0);
  await expect(page.locator('.sidebar-account')).toBeInViewport();
  await page.locator('.sidebar-shade').click({ position: { x: 300, y: 300 } });
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(rail).toBeVisible();
});
