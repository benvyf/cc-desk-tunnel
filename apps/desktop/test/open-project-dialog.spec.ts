import { test, expect } from '@playwright/test';
const fixture = '/test/fixtures/open-project-dialog.html';
const calls = (page: import('@playwright/test').Page) =>
  page.evaluate(
    () =>
      (window as unknown as { projectDialogFixture: { calls: unknown[] } }).projectDialogFixture
        .calls,
  );
test('offline target connects then browses and opens exactly one remote session', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  await page.getByLabel('SSH 密码', { exact: true }).fill('secret');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  await page.getByRole('button', { name: 'app', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev/app');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await calls(page)).filter((row) => Array.isArray(row) && row[0] === 'open')).toEqual([
    ['open', 'target-01', '/home/dev/app', true],
  ]);
});
test('local project uses the native picker and caller callback', async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(page.getByLabel('本机项目目录', { exact: true })).toHaveValue('D:\\work\\local');
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  expect(await calls(page)).toContainEqual(['local', 'D:\\work\\local']);
});
test('failed open stays visible and changing typed directory invalidates a late listing', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { setConnected: () => void } }
    ).projectDialogFixture.setConnected(),
  );
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  const path = page.getByLabel('项目绝对路径', { exact: true });
  await expect(path).toHaveValue('/home/dev');
  await path.fill('/slow');
  await page.getByRole('button', { name: '浏览', exact: true }).click();
  await path.fill('/fail');
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { release: () => void } }
    ).projectDialogFixture.release(),
  );
  await expect(path).toHaveValue('/fail');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('打开失败');
  await expect(path).toHaveValue('/fail');
});
test('canceling an in-progress connection never opens a project on late success', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  await page.getByLabel('SSH 密码', { exact: true }).fill('wait');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { release: () => void } }
    ).projectDialogFixture.release(),
  );
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await calls(page)).filter((row) => Array.isArray(row) && row[0] === 'open')).toEqual([]);
  expect(await calls(page)).toContainEqual(['disconnect', 'target-01']);
});
test('new SSH device reuses native identity selection and existing save/connect APIs', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByRole('button', { name: '添加 SSH 设备', exact: true }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('02');
  await page.getByLabel('主机名', { exact: true }).fill('dev@localhost');
  await page.getByRole('button', { name: '选择文件', exact: true }).click();
  await expect(page.getByLabel('身份文件路径', { exact: true })).toHaveValue(
    'C:\\Users\\dev\\.ssh\\id_ed25519',
  );
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  expect((await calls(page)).some((row) => Array.isArray(row) && row[0] === 'save')).toBe(true);
});

test('a successful open is not repeated when the caller must retry initialization', async ({
  page,
}) => {
  await page.goto(fixture + '?callback-fails');
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { setConnected: () => void } }
    ).projectDialogFixture.setConnected(),
  );
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('initialization failed');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await calls(page)).filter((row) => Array.isArray(row) && row[0] === 'open')).toHaveLength(
    1,
  );
});

test('service identity change cancels the dialog and its pending connection', async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  await page.getByLabel('SSH 密码', { exact: true }).fill('wait');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { changeService: () => void } }
    ).projectDialogFixture.changeService(),
  );
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await calls(page)).toContainEqual(['disconnect', 'target-01']);
});

test('older initial list snapshot cannot replace a newer target event', async ({ page }) => {
  await page.goto(fixture + '?stale-list');
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { setConnected: () => void } }
    ).projectDialogFixture.setConnected(),
  );
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  await page.evaluate(() =>
    (
      window as unknown as { projectDialogFixture: { release: () => void } }
    ).projectDialogFixture.release(),
  );
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
});

test('retry after a lost remote open response reuses the creation identity', async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => (window as any).projectDialogFixture.setConnected());
  await page.getByRole('button', { name: '打开01', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  await page.getByLabel('项目绝对路径', { exact: true }).fill('/retry');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('response lost');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const attempts = (await calls(page)).filter(
    (row): row is string[] => Array.isArray(row) && row[0] === 'creation',
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0][1]).toBeTruthy();
  expect(attempts[0][1]).toBe(attempts[1][1]);
});
