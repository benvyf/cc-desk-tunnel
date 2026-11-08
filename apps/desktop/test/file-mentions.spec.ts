import { test, expect } from '@playwright/test';

const folder = 'C:\\Users\\benben\\Documents\\CC SPACE\\2026-10-29\\001601';
test('generated inline files open the real sidebar, retaining paths and turn boundaries', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/test/fixtures/file-mentions.html');
  const answers = page.locator('.message.assistant');
  const first = answers.nth(0);
  const second = answers.nth(1);
  for (const extension of ['docx', 'pdf']) {
    const name = `婚礼主持稿_新流程.${extension}`;
    const link = first.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('data-link', `${folder}\\${name}`);
    await link.focus();
    await page.keyboard.press('Enter');
    const sidebar = page.getByRole('complementary', { name: '文件与网站预览' });
    await expect(sidebar.getByRole('tab', { name, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(sidebar).toContainText(`预览内容：${folder}\\${name}`);
  }
  await expect(second.getByRole('link', { name: '记录.txt', exact: true })).toHaveAttribute(
    'data-link',
    'C:\\其他目录\\记录.txt',
  );
  await second.getByRole('link', { name: '记录.txt', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toContainText(
    '预览内容：C:\\其他目录\\记录.txt',
  );
  await expect(first.locator('pre a')).toHaveCount(0);
  await expect(first.locator('code a')).toHaveCount(2);
  await expect(first.locator('a code')).toHaveCount(1); // preserve the existing Markdown link
  await expect(second.locator('code a')).toHaveCount(1); // no ambiguous, failed, or previous-turn names
  await first.getByRole('link', { name: '普通文件链接', exact: true }).click();
  expect(errors).toEqual([]);
});

for (const mode of ['browser', 'remote'])
  test(`inline file mentions do not inspect inaccessible files: ${mode}`, async ({ page }) => {
    await page.goto(`/test/fixtures/file-mentions.html?${mode}`);
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.locator('.message.assistant').nth(1).locator('code a')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).fileMentionFixture.inspected.length))
      .toBe(0);
  });
