import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { screenshots } from './helpers.ts';

const asked = (page: import('@playwright/test').Page) => page.evaluate(() => window.asked);

test('the changes are listed with their marks and totals, and a diff is read only when opened', async ({
  page,
}) => {
  await page.goto('/test/fixtures/git-changes.html');
  const panel = page.getByRole('region', { name: 'Git 改动' });
  await expect(panel.locator('.git-changes-summary')).toContainText('当前分支 feature');
  await expect(panel.locator('.git-changes-summary')).toContainText('6 个文件');
  await expect(panel.locator('.git-changes-summary')).toContainText('+4−4');
  await expect(panel.locator('.git-changes-summary')).toContainText('1 项未跟踪');
  await expect(panel.locator('.git-status')).toHaveText(['M', 'D', 'R', 'M', 'M', 'U']);
  await expect(panel.locator('.git-change-conflict')).toHaveText(['冲突']);
  await expect(panel.locator('.git-change').nth(2)).toContainText('← old name.md');
  await expect(panel.locator('.git-change').nth(3)).toContainText('二进制');
  expect((await asked(page)).fileDiff).toHaveLength(0);
  const first = panel.getByRole('button', { name: /app\.ts/ });
  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.git-diff .added')).toHaveCount(3);
  await expect(panel.locator('.git-diff .removed')).toHaveText(['−old']);
  expect((await asked(page)).fileDiff).toEqual([
    { root: 'D:\\工作\\仓库', against: 'a'.repeat(40), path: 'src/app.ts' },
  ]);
  await page.screenshot({ path: resolve(screenshots, 'git-changes.png') });
  // Shut and opened again, it is not read again.
  await first.click();
  await first.click();
  expect((await asked(page)).fileDiff).toHaveLength(1);
  await panel.getByRole('button', { name: /笔记\.txt/ }).click();
  await expect(panel.locator('.git-change').nth(5).locator('.added')).toHaveText([
    '+第一行',
    '+第二行',
  ]);
  await panel.getByRole('button', { name: /pic\.png/ }).click();
  await expect(panel.getByText('二进制文件，不显示差异。')).toBeVisible();
});

test('a branch to compare with is chosen by its full ref; nothing offers to stage, commit or discard', async ({
  page,
}) => {
  await page.goto('/test/fixtures/git-changes.html');
  const panel = page.getByRole('region', { name: 'Git 改动' });
  const select = panel.getByRole('combobox', { name: '对比基准' });
  await expect(select.locator('option')).toHaveText([
    'HEAD（未提交的改动）',
    'feature',
    'main',
    'origin/main',
  ]);
  await select.selectOption('refs/remotes/origin/main');
  await expect(panel.locator('.git-status')).toHaveText(['A']);
  expect((await asked(page)).changes.at(-1)).toEqual({
    root: 'D:\\工作\\仓库',
    base: 'refs/remotes/origin/main',
  });
  await expect(
    panel.getByRole('button', { name: /暂存|提交|丢弃|还原|stage|commit|discard/i }),
  ).toHaveCount(0);
});

test('a file opens in the preview by its full path; a deleted one cannot be opened', async ({
  page,
}) => {
  await page.goto('/test/fixtures/git-changes.html');
  const panel = page.getByRole('region', { name: 'Git 改动' });
  await expect(panel.locator('.git-change')).toHaveCount(6);
  await panel.locator('.git-change').nth(0).getByRole('button', { name: '打开' }).click();
  expect((await asked(page)).opened).toEqual(['D:\\工作\\仓库\\src\\app.ts']);
  await expect(
    panel.locator('.git-change').nth(1).getByRole('button', { name: '打开' }),
  ).toHaveCount(0);
});

test('a project on an SSH device is read through its target and offers no opening', async ({
  page,
}) => {
  await page.goto('/test/fixtures/git-changes.html?target=dev-box&ssh=1');
  const panel = page.getByRole('region', { name: 'Git 改动' });
  await expect(panel.locator('.git-change')).toHaveCount(6);
  expect((await asked(page)).changes[0]).toEqual({ root: 'D:\\工作\\仓库', targetId: 'dev-box' });
  await expect(panel.getByRole('button', { name: '打开' })).toHaveCount(0);
});

test('a folder outside a repository says so, and many changes say they are cut short', async ({
  page,
}) => {
  await page.goto('/test/fixtures/git-changes.html?fail=1');
  await expect(page.getByRole('alert')).toHaveText('项目不在 Git 仓库中。');
  await page.goto('/test/fixtures/git-changes.html?truncated=1');
  await expect(page.locator('.git-changes-note')).toContainText('只列出前 6 个文件');
});
