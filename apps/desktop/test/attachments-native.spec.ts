import { expect, test, _electron } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { login, screenshots, sessionAction, settled } from './helpers.ts';

test('Electron chooses real files, generates bounded previews, restores and sends attachment-only drafts', async () => {
  test.skip(process.platform !== 'win32');
  test.setTimeout(60000);
  mkdirSync(resolve('.local/attachments-test'), { recursive: true });
  const directory = mkdtempSync(resolve('.local/attachments-test/run-'));
  const photo = join(directory, '附件图片.png');
  const document = join(directory, 'schema.json');
  copyFileSync(resolve('apps/desktop/electron/icon.png'), photo);
  writeFileSync(document, '{"attachment":true}');
  const application = await _electron.launch({
    args: [
      resolve('apps/desktop'),
      '--smoke-test',
      `--user-data-dir=${join(directory, 'profile')}`,
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    ),
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('button', { name: '本地模拟', exact: true })).toBeVisible();
    await login(page);
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as typeof dialog.showOpenDialog;
    }, directory);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: `新建会话 · ${directory}`, exact: true }).click();
    const title = `附件 ${Date.now()}`;
    await sessionAction(page, '重命名');
    await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(title);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await application.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: paths,
        })) as typeof dialog.showOpenDialog;
      },
      [document, photo],
    );
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    const composer = page.locator('.composer');
    await expect(composer.locator('.attachment-tile')).toHaveCount(2);
    const image = composer.getByAltText('附件图片.png');
    await expect(image).toBeVisible();
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    expect((await image.getAttribute('src'))!.length).toBeLessThan(500000);
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    await expect
      .poll(() => page.evaluate(async () => JSON.stringify(await window.desktop!.loadDrafts())))
      .toContain('schema.json');
    await page.screenshot({
      path: join(screenshots, 'attachments-native.png'),
      animations: 'disabled',
    });
    await page.reload();
    await expect(page.getByRole('button', { name: '本地模拟', exact: true })).toBeVisible();
    await login(page);
    await page.locator('.session-select').filter({ hasText: title }).click();
    await expect(composer.locator('.attachment-tile')).toHaveCount(2);
    await composer.getByRole('button', { name: '移除 schema.json', exact: true }).click();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await settled(page);
    await expect(composer.locator('.attachment-tile')).toHaveCount(0);
    const message = page.locator('.message.user .message-content').last();
    await expect(message.locator('.attachment-tile')).toHaveCount(1);
    await expect(message.getByAltText('附件图片.png')).toBeVisible();
    await expect(message).not.toContainText(directory);
    await expect(message).toHaveAttribute('data-copy-text', `"${photo}"`);
    await message.hover();
    await page
      .locator('.message.user')
      .last()
      .getByRole('button', { name: '编辑重发', exact: true })
      .click();
    await expect(composer.locator('.attachment-tile')).toHaveCount(1);
    await expect(composer.getByAltText('附件图片.png')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeFocused();
    await expect(page.locator('.message.user')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate((file) => window.desktop!.attachmentPreview(file), document),
    ).toBeNull();
    expect(
      await page.evaluate(() => window.desktop!.attachmentPreview('C:\\missing.png')),
    ).toBeNull();
  } finally {
    await application.close();
  }
});
