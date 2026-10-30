import { test, expect } from '@playwright/test';

test('Markdown navigation retains the selected tree scope', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  await page.getByRole('treeitem', { name: '说明.md', exact: true }).click();
  await page.getByRole('link', { name: '项目外文档', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = Object.entries(localStorage).find(([key]) =>
          key.startsWith('cc-preview-v1:'),
        )?.[1];
        return saved
          ? JSON.parse(saved).boards.session.tabs.find((tab: any) =>
              tab.target.endsWith('outside.md'),
            )?.restricted
          : undefined;
      }),
    )
    .toBe(true);
});
