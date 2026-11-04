import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SshTarget } from '../src/desktop.d.ts';

test('SSH settings use manual connection and project paths with the existing settings UI', async ({
  page,
}) => {
  await page.goto('/test/fixtures/ssh-settings.html');
  const nav = page.getByRole('navigation', { name: '设置分类' });
  await expect(nav.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await expect(page.getByText('尚未添加 SSH 连接', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 SSH 连接' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('未发现 SSH 连接', { exact: true })).toHaveCount(0);
  await dialog.getByLabel('显示名称', { exact: true }).fill('实验室 Ubuntu');
  await dialog.getByLabel('主机名', { exact: true }).fill('10.0.0.20');
  await dialog.getByLabel('用户名', { exact: true }).fill('dev');
  await dialog.getByRole('button', { name: '选择文件', exact: true }).click();
  await expect(dialog.getByLabel('身份文件路径', { exact: true })).toHaveValue(
    'C:\\Users\\dev\\.ssh\\id_ed25519',
  );
  await mkdir(resolve('.local/screenshots/ssh'), { recursive: true });
  await page.screenshot({
    path: resolve('.local/screenshots/ssh/add-light.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: '保存并连接', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.ssh-detail')).toContainText('已连接');
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await page.getByLabel('项目绝对路径', { exact: true }).fill('/home/dev/project');
  await page.getByRole('dialog').getByRole('button', { name: '打开项目', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { sshFixture: { calls: string[] } }).sshFixture.calls,
      ),
    )
    .toContain('/home/dev/project');
  await page.getByRole('button', { name: '继续上次', exact: true }).click();
  await expect(page.locator('.ssh-detail')).toContainText('最近项目：/home/dev/project');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { sshFixture: { calls: string[] } }).sshFixture.calls,
      ),
    )
    .toContain('open-existing-session');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({
    path: resolve('.local/screenshots/ssh/list-dark.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(page.locator('.shell')).toHaveClass(/side-closed/);
  await page.screenshot({
    path: resolve('.local/screenshots/ssh/list-narrow.png'),
    animations: 'disabled',
  });
  await expect(page.getByRole('button', { name: '打开项目', exact: true })).toBeInViewport();
  await page.getByRole('switch', { name: '连接 实验室 Ubuntu', exact: true }).click();
  await expect(page.locator('.ssh-detail')).toContainText('已断开');
});

test('remote directory navigation stays on the target and ignores a canceled listing', async ({
  page,
}) => {
  await page.goto('/test/fixtures/ssh-settings.html');
  await page.evaluate(() =>
    (
      window as unknown as { sshFixture: { setEntries: (entries: SshTarget[]) => void } }
    ).sshFixture.setEntries([
      {
        id: crypto.randomUUID(),
        name: 'Linux target',
        host: '10.0.0.20',
        port: 22,
        username: 'dev',
        auth: 'key',
        available: true,
        status: 'connected',
        stage: 'ready',
        error: '',
        projects: [],
      },
    ]),
  );
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '打开远程项目' });
  await dialog.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(dialog.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  await mkdir(resolve('.local/screenshots/ssh'), { recursive: true });
  await page.screenshot({
    path: resolve('.local/screenshots/ssh/directory-browser-light.png'),
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: resolve('.local/screenshots/ssh/directory-browser-dark.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 640, height: 760 });
  await expect(dialog.getByRole('button', { name: '上一级目录', exact: true })).toBeInViewport();
  await page.screenshot({
    path: resolve('.local/screenshots/ssh/directory-browser-narrow.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'project', exact: true }).click();
  await expect(dialog.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev/project');
  await expect(dialog.getByText('此目录下没有可浏览的文件夹，可直接打开当前目录。')).toBeVisible();
  await dialog.getByRole('button', { name: '上一级目录', exact: true }).click();
  await expect(dialog.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/home/dev');
  await dialog.getByLabel('项目绝对路径', { exact: true }).fill('/denied');
  await dialog.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('无法浏览目录');
  await dialog.getByLabel('项目绝对路径', { exact: true }).fill('/slow');
  await dialog.getByRole('button', { name: '浏览', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('正在读取');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '打开远程项目' });
  await page.evaluate(() =>
    (
      window as unknown as { sshFixture: { releaseDirectories: () => void } }
    ).sshFixture.releaseDirectories(),
  );
  await expect(dialog.getByLabel('项目绝对路径', { exact: true })).toHaveValue('');
  await dialog.getByLabel('项目绝对路径', { exact: true }).fill('/home/dev/manual');
  await dialog.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '继续上次', exact: true })).toBeVisible();
});

test('SSH page matches existing setting typography and handles long errors and narrow password dialogs', async ({
  page,
}) => {
  await mkdir(resolve('.local/screenshots/ssh'), { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.goto('/test/fixtures/ssh-settings.html');
    const navigation = page.getByRole('navigation', { name: '设置分类' });
    await navigation.getByRole('button', { name: '通知', exact: true }).click();
    const titleStyle = await page.locator('.page-title').evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.fontFamily, style.fontSize, style.fontWeight, style.color];
    });
    const rowStyle = await page
      .locator('.setting-row')
      .last()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.paddingTop, style.paddingBottom, style.borderBottomColor];
      });
    await navigation.getByRole('button', { name: '连接', exact: true }).click();
    expect(
      await page.locator('.page-title').evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.color];
      }),
    ).toEqual(titleStyle);
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { sshFixture: { setEntries: (entries: SshTarget[]) => void } }
      ).sshFixture;
      fixture.setEntries([
        {
          id: crypto.randomUUID(),
          name: 'LongConnectionName'.repeat(6),
          host: 'remote-development.example.test',
          port: 2222,
          username: 'developer',
          auth: 'password',
          projects: [],
          available: true,
          status: 'failed',
          error: 'SSH 主机指纹已变化，请核实后添加新的连接。',
        },
      ]);
    });
    const row = page.locator('.ssh-row');
    expect(
      await row.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.paddingTop, style.paddingBottom, style.borderBottomColor];
      }),
    ).toEqual(rowStyle);
    expect(
      await row.locator('.error-text').evaluate((element) => getComputedStyle(element).color),
    ).not.toEqual(
      await row.locator('.ssh-address').evaluate((element) => getComputedStyle(element).color),
    );
    await page.setViewportSize({ width: 640, height: 760 });
    await expect(page.locator('.shell')).toHaveClass(/side-closed/);
    expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve(`.local/screenshots/ssh/error-${colorScheme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '添加', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加 SSH 连接' });
    await dialog.getByRole('button', { name: '密码', exact: true }).click();
    await expect(dialog.getByLabel('身份文件路径', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel(/^SSH 密码/)).toBeVisible();
    await page.screenshot({
      path: resolve(`.local/screenshots/ssh/password-${colorScheme}.png`),
      animations: 'disabled',
    });
    await expect(dialog.getByRole('button', { name: '保存并连接', exact: true })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
});
