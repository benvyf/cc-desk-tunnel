import { test, expect } from '@playwright/test';

for (const transition of ['run', 'disabled-start', 'disabled-end'])
  test(`IME state survives ${transition} shortcut lifecycle changes`, async ({ page }) => {
    await page.goto('/test/fixtures/stop-shortcut.html');
    const box = page.getByRole('textbox', { name: '消息', exact: true });
    await box.focus();
    const change = async (name: string) =>
      page
        .getByRole('button', { name, exact: true })
        .evaluate((el: HTMLButtonElement) => el.click());
    if (transition === 'disabled-start') {
      await change('禁用停止');
      await box.dispatchEvent('compositionstart');
      await change('启用停止');
    } else {
      await box.dispatchEvent('compositionstart');
      if (transition === 'run') await change('替换运行');
      else {
        await change('禁用停止');
        await box.dispatchEvent('compositionend');
        await change('启用停止');
      }
    }
    if (transition !== 'disabled-end') {
      await box.press('Escape');
      await box.press('Escape');
      await expect(page.getByLabel('停止记录', { exact: true })).toHaveText('');
      await box.dispatchEvent('compositionend');
    }
    await box.press('Escape');
    await expect(page.getByLabel('停止记录', { exact: true })).toHaveText('');
    await box.press('Escape');
    await expect(page.getByLabel('停止记录', { exact: true })).toHaveText(
      transition === 'run' ? 'B' : 'A',
    );
  });

test('a terminal picker listbox outside the focused conversation does not own its Escape', async ({
  page,
}) => {
  await page.goto('/test/fixtures/stop-shortcut.html?terminal-list');
  await expect(page.getByRole('listbox', { name: '终端结果', exact: true })).toBeVisible();
  const box = page.getByRole('textbox', { name: '消息', exact: true });
  await box.focus();
  await box.press('Escape');
  await expect(page.getByLabel('停止记录', { exact: true })).toHaveText('');
  await box.press('Escape');
  await expect(page.getByLabel('停止记录', { exact: true })).toHaveText('A');
});

for (const action of ['替换运行', '禁用停止'])
  test(`Escape cannot use stale eligibility while committing ${action}`, async ({ page }) => {
    await page.goto('/test/fixtures/stop-shortcut.html');
    const box = page.getByRole('textbox', { name: '消息', exact: true });
    await box.focus();
    await box.press('Escape');
    // Change state without a pointer/focus event, as happens when a remote run changes.
    await page
      .getByRole('button', { name: action, exact: true })
      .evaluate((el: HTMLButtonElement) => el.click());
    await expect(page.getByLabel('停止记录', { exact: true })).toHaveText('');
    if (action === '替换运行') {
      await box.press('Escape');
      expect(await page.getByLabel('停止记录', { exact: true }).textContent()).toBe('');
      await box.press('Escape');
      await expect(page.getByLabel('停止记录', { exact: true })).toHaveText('B');
    }
  });
