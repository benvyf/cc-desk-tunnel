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
    await expect(link).toHaveAttribute('data-link', encodeURIComponent(`${folder}\\${name}`));
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
    encodeURIComponent('C:\\其他目录\\记录.txt'),
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
    await expect(page.locator('.message.assistant').nth(1).locator('code')).toHaveCount(4);
    await expect(page.locator('.message.assistant').nth(1).locator('code a')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as any).fileMentionFixture.inspected.length))
      .toBe(0);
  });

test('relative references, literal percent filenames and line positions reach the correct sidebar target', async ({
  page,
}) => {
  await page.goto('/test/fixtures/file-mentions.html?edge');
  const answer = page.locator('.message.assistant');
  for (const [label, path, line, column] of [
    ['out/report.pdf', 'C:\\项目\\out\\report.pdf'],
    ['report.pdf', 'C:\\成果.v2\\report.pdf'],
    ['100%2520完成.ts', 'C:\\成果.v2\\100%2520完成.ts'],
    ['README', 'C:\\成果.v2\\README'],
    ['C:\\成果.v2\\100%2520完成.ts:12:3', 'C:\\成果.v2\\100%2520完成.ts', 12, 3],
  ] as const) {
    await answer.getByRole('link', { name: label, exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).fileMentionFixture.followed.at(-1)))
      .toEqual({
        kind: 'path',
        path,
        ...(line ? { line, column } : {}),
      });
    await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toContainText(
      `预览内容：${path}`,
    );
  }
  await expect(answer.getByRole('link', { name: 'C:\\成果.v2', exact: true })).toHaveCount(0);
});

test('a late file inspection cannot replace the link of the current message', async ({ page }) => {
  const oldPath = 'C:\\成果.v2\\first.pdf';
  const nextPath = 'C:\\成果.v2\\second.pdf';
  await page.goto('/test/fixtures/file-mentions.html?race');
  await expect
    .poll(() => page.evaluate(() => (window as any).fileMentionFixture.inspected))
    .toContain(oldPath);
  await page.evaluate(
    (path) => (window as any).fileMentionFixture.reply('`' + path + '`'),
    nextPath,
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).fileMentionFixture.inspected))
    .toContain(nextPath);
  await page.evaluate((path) => (window as any).fileMentionFixture.resolve(path), nextPath);
  const answer = page.locator('.message.assistant');
  await expect(answer.getByRole('link', { name: nextPath, exact: true })).toBeVisible();
  await page.evaluate((path) => (window as any).fileMentionFixture.resolve(path), oldPath);
  await answer.getByRole('link', { name: nextPath, exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fileMentionFixture.reads))
    .toEqual([nextPath]);
});

test('file inspection failures leave readable code without broken links or unhandled errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/test/fixtures/file-mentions.html?inspection-error');
  const answer = page.locator('.message.assistant');
  await expect(answer.locator('code')).toHaveText('C:\\成果.v2\\first.pdf');
  await expect
    .poll(() => page.evaluate(() => (window as any).fileMentionFixture.inspected.length))
    .toBeGreaterThan(0);
  await expect(answer.getByRole('link')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('directory scope ends with its file list or section, even when the wrong sibling exists', async ({
  page,
}) => {
  await page.goto('/test/fixtures/file-mentions.html?edge');
  for (const boundary of [
    '\n\n## Source changes\n\n',
    '\n\n- `report.pdf`\n\n',
    '：`report.pdf`。\n\n',
  ]) {
    await page.evaluate(
      (boundary) =>
        (window as any).fileMentionFixture.reply('文件在 `C:\\成果.v2\\`' + boundary + '`app.ts`'),
      boundary,
    );
    const link = page
      .locator('.message.assistant')
      .getByRole('link', { name: 'app.ts', exact: true });
    await expect(link).toHaveAttribute('data-link', encodeURIComponent('C:\\项目\\src\\app.ts'));
    await link.click();
    await expect
      .poll(() => page.evaluate(() => (window as any).fileMentionFixture.followed.at(-1)?.path))
      .toBe('C:\\项目\\src\\app.ts');
  }
});

test('an existing reference file is not used as a directory, and missing directories do not redirect', async ({
  page,
}) => {
  await page.goto('/test/fixtures/file-mentions.html?edge');
  await page.evaluate(() =>
    (window as any).fileMentionFixture.reply('查看 `C:\\docs\\guide.pdf`，生成 `README`。'),
  );
  const answer = page.locator('.message.assistant');
  const readme = answer.getByRole('link', { name: 'README', exact: true });
  await expect(readme).toHaveAttribute('data-link', encodeURIComponent('C:\\成果.v2\\README'));
  await readme.click();
  await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toContainText(
    '预览内容：C:\\成果.v2\\README',
  );
  await page.evaluate(() =>
    (window as any).fileMentionFixture.reply('文件在 `C:\\不存在的目录`：`README`。'),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).fileMentionFixture.inspected))
    .toContain('C:\\不存在的目录');
  await expect(answer.getByRole('link', { name: 'README', exact: true })).toHaveCount(0);
});
