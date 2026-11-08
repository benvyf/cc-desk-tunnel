import { test, expect } from '@playwright/test';

test('page teardown flushes the latest layout before the debounce expires', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.entries(localStorage).find(([key]) => key.startsWith('cc-preview-v1:'))?.[1] ?? '',
      ),
    )
    .toContain('说明.md');
  const saved = await page.evaluate(async () => {
    [...document.querySelectorAll('button')].find((b) => b.textContent === '图片状态')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event('pagehide'));
    return (
      Object.entries(localStorage).find(([key]) => key.startsWith('cc-preview-v1:'))?.[1] ?? ''
    );
  });
  expect(saved).toContain('趋势图.png');
});
