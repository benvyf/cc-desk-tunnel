import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { screenshots } from './helpers.ts';

// A file's changes in its preview tab (PreviewDiff.tsx), with the project's Git stubbed (?git in the fixture).
const fixture = '/test/fixtures/preview-sidebar.html?git';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const pane = (page: Page) => page.getByRole('complementary', { name: '文件与网站预览' });
const modes = (page: Page) => pane(page).getByRole('group', { name: '显示方式' });
const rows = (page: Page) => pane(page).locator('.preview-diff-chunk > span');
const asked = (page: Page) => page.evaluate(() => (window as any).fixtureGit);

test('only a file with changes offers 改动, beside its other views', async ({ page }) => {
  await page.goto(fixture);
  await button(page, '长代码').click();
  await expect(modes(page).getByRole('button')).toHaveText(['源码', '改动']);
  expect((await asked(page)).changes[0]).toEqual({ root: 'C:\\工作\\网站预览' });
  // Nothing is read of the diff until it is shown.
  expect((await asked(page)).fileDiff).toHaveLength(0);
  await button(page, '打开文档').click();
  await expect(modes(page).getByRole('button')).toHaveText(['预览', '源码', '改动']);
  await button(page, '图片状态').click();
  await expect(modes(page).getByRole('button')).toHaveText(['预览', '改动']);
  // A file with no changes shows itself only.
  await button(page, 'GBK 文本').click();
  await expect(pane(page).locator('.preview-code pre code')).toContainText('中文测试');
  await expect(modes(page)).toHaveCount(0);
});

test('the diff shows each side’s line numbers in colour, goes from change to change, and opens the source at a line', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长代码').click();
  await modes(page).getByRole('button', { name: '改动' }).click();
  await expect(rows(page)).toHaveCount(13);
  expect((await asked(page)).fileDiff).toEqual([
    { root: 'C:\\工作\\网站预览', against: 'a'.repeat(40), path: '长代码.ts' },
  ]);
  const added = pane(page).locator('.preview-diff-chunk > .added');
  const removed = pane(page).locator('.preview-diff-chunk > .removed');
  await expect(added).toHaveCount(3);
  await expect(removed).toHaveCount(2);
  // The headers before the first hunk are left out; each line has its number on each side it is on.
  await expect(rows(page).first()).toHaveClass('hunk');
  const numbers = (index: number) =>
    rows(page)
      .nth(index)
      .locator('.preview-diff-number')
      .evaluateAll((cells) => cells.map((cell) => cell.textContent));
  expect(await numbers(1)).toEqual(['10', '10']);
  expect(await numbers(3)).toEqual(['12', '']);
  expect(await numbers(4)).toEqual(['', '12']);
  expect(await numbers(6)).toEqual(['13', '14']);
  const background = (locator: import('@playwright/test').Locator) =>
    locator.first().evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await background(added)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await background(removed)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await background(added)).not.toBe(await background(removed));
  await expect(pane(page).locator('.preview-diff-position')).toHaveText('2 处改动');
  await page.screenshot({ path: resolve(screenshots, 'preview-diff.png') });

  // The buttons, and F7 / Shift+F7 or Alt+↓ / Alt+↑ in the diff, go from hunk to hunk.
  await button(page, '下一处改动').click();
  await expect(pane(page).locator('.preview-diff-position')).toHaveText('第 2 / 2 处改动');
  await expect(rows(page).nth(8)).toHaveAttribute('aria-current', 'true');
  // Not disabled at the ends, so that the focus and the keys stay.
  await expect(button(page, '下一处改动')).toHaveAttribute('aria-disabled', 'true');
  await pane(page).getByLabel('改动内容').focus();
  await page.keyboard.press('Shift+F7');
  await expect(pane(page).locator('.preview-diff-position')).toHaveText('第 1 / 2 处改动');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(pane(page).locator('.preview-diff-position')).toHaveText('第 2 / 2 处改动');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(button(page, '上一处改动')).toHaveAttribute('aria-disabled', 'true');
  await expect(pane(page).getByLabel('改动内容')).toBeFocused();
  // Enter opens the current change's first new line in the source.
  await page.keyboard.press('Enter');
  await expect(page.locator('.preview-code-highlight[data-line="12"]')).toBeVisible();
  await modes(page).getByRole('button', { name: '改动' }).click();
  // Chosen from the control, the diff takes the keys.
  await expect(pane(page).getByLabel('改动内容')).toBeFocused();

  // A number of the file as it is opens its source there.
  await rows(page).nth(5).getByRole('button', { name: '13' }).click();
  await expect(modes(page).getByRole('button', { name: '源码' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.preview-code-highlight[data-line="13"]')).toBeVisible();
  await expect(pane(page).getByRole('textbox', { name: '跳转到行' })).toHaveValue('13');
});

test('a long diff is laid out in chunks and its later hunks are reached', async ({ page }) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await modes(page).getByRole('button', { name: '改动' }).click();
  await expect(pane(page).locator('.preview-diff-chunk')).toHaveCount(7);
  await expect(rows(page)).toHaveCount(1204);
  await button(page, '下一处改动').click();
  const far = rows(page).nth(1201);
  await expect(far).toHaveAttribute('aria-current', 'true');
  await expect(far).toBeInViewport();
});

test('the diff wraps as the tab does, and a binary or cut-short diff says so', async ({ page }) => {
  await page.goto(fixture);
  await button(page, '长代码').click();
  await modes(page).getByRole('button', { name: '改动' }).click();
  const body = pane(page).getByLabel('改动内容');
  await expect(body).not.toHaveClass(/wraps/);
  await button(page, '自动换行').click();
  await expect(body).toHaveClass(/wraps/);
  await modes(page).getByRole('button', { name: '源码' }).click();
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'true');

  await button(page, '图片状态').click();
  await modes(page).getByRole('button', { name: '改动' }).click();
  await expect(pane(page).getByText('二进制文件，无法显示差异')).toBeVisible();
  await button(page, '大日志').click();
  await modes(page).getByRole('button', { name: '改动' }).click();
  await expect(pane(page).locator('.preview-notice')).toHaveText(
    '差异超过 512 KB，只显示了开头部分。',
  );
  await expect(pane(page).locator('.preview-diff-chunk > .added .preview-diff-text')).toHaveText([
    'log line 2',
  ]);
});

test('the changes panel’s 打开 lands on the first change; the view is kept across a reload', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '展开空栏').click();
  await button(page, 'Git 改动').click();
  const panel = page.getByRole('region', { name: 'Git 改动' });
  const row = panel.locator('.git-change').filter({ hasText: '长代码.ts' });
  await row.getByRole('button', { name: '打开' }).click();
  await expect(modes(page).getByRole('button', { name: '改动' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
  await expect(pane(page).getByRole('tab', { name: '长代码.ts' })).toBeVisible();
  // Scrolled on and opened again, it goes back to the first change.
  await button(page, '下一处改动').click();
  await row.getByRole('button', { name: '打开' }).click();
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');

  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await button(page, '展开空栏').click();
  await expect(modes(page).getByRole('button', { name: '改动' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows(page)).toHaveCount(13);
  await modes(page).getByRole('button', { name: '源码' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await button(page, '展开空栏').click();
  await expect(modes(page).getByRole('button', { name: '源码' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a deleted file opens as its changes only', async ({ page }) => {
  await page.goto(fixture);
  await button(page, '展开空栏').click();
  await button(page, 'Git 改动').click();
  const panel = page.getByRole('region', { name: 'Git 改动' });
  await panel
    .locator('.git-change')
    .filter({ hasText: '删除.txt' })
    .getByRole('button', { name: '打开' })
    .click();
  await expect(pane(page).locator('.preview-diff-chunk > .removed .preview-diff-text')).toHaveText([
    '第一行',
    '第二行',
  ]);
  await expect(modes(page)).toHaveCount(0);
  await expect(pane(page).locator('.preview-error')).toHaveCount(0);
  // Nothing of it is there to go to.
  await expect(pane(page).locator('button.preview-diff-number')).toHaveCount(0);
});

test('Git is asked once for many changes on disk, and once for a run’s end across panes and the panel', async ({
  page,
}) => {
  await page.goto(fixture);
  const calls = async () => (await asked(page)).changes.length;
  await button(page, '长代码').click();
  await modes(page).getByRole('button', { name: '改动' }).click();
  await expect(rows(page)).toHaveCount(13);
  await page.waitForTimeout(300);
  let before = await calls();
  // Changes on disk while the changes are shown: one read at once, then one after the last, 2.5 s on.
  for (let index = 0; index < 6; index++) {
    await page.evaluate(() => (window as any).fixturePreview.emit('长代码.ts'));
    await page.waitForTimeout(100);
  }
  await expect.poll(calls, { timeout: 6000 }).toBe(before + 2);
  await page.waitForTimeout(3000);
  expect(await calls()).toBe(before + 2);
  // Not shown, a change on disk waits for them to be.
  await modes(page).getByRole('button', { name: '源码' }).click();
  before = await calls();
  await page.evaluate(() => (window as any).fixturePreview.emit('长代码.ts'));
  await page.waitForTimeout(3000);
  expect(await calls()).toBe(before);
  await modes(page).getByRole('button', { name: '改动' }).click();
  await expect.poll(calls).toBe(before + 1);

  // Two panes showing changes and the changes panel: a run's end is one read.
  await button(page, '打开文档').click();
  await modes(page).last().getByRole('button', { name: '改动' }).click();
  await button(page, '分栏预览').click();
  await expect(pane(page).locator('.preview-diff')).toHaveCount(2);
  await button(page, 'Git 改动').click();
  await expect(page.getByRole('region', { name: 'Git 改动' }).locator('.git-change')).toHaveCount(
    7,
  );
  await page.waitForTimeout(3500);
  before = await calls();
  await button(page, '模拟运行').click();
  await button(page, '模拟运行').click();
  await expect.poll(calls).toBe(before + 1);
  await page.waitForTimeout(1000);
  expect(await calls()).toBe(before + 1);
});

test('a restricted tab outside its workspace asks no Git, and a private file offers no changes', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '受限外部文件').click();
  await expect(pane(page).getByRole('tab', { name: '外部.txt' })).toBeVisible();
  await page.waitForTimeout(500);
  expect((await asked(page)).changes).toHaveLength(0);
  await button(page, '私有文件').click();
  await expect(pane(page).locator('.preview-code pre code')).toContainText('CC Space');
  await expect.poll(async () => (await asked(page)).changes.length).toBe(1);
  await expect(modes(page)).toHaveCount(0);
  expect((await asked(page)).fileDiff).toHaveLength(0);
});
