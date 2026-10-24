import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { createSession, login } from './helpers.ts';

async function settings(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
}

async function samples(page: Page) {
  await page.evaluate(async () => {
    const path = '/test/fixtures/font-samples.tsx';
    (await import(path)).mount();
  });
}

test('interface and code sizes update independently, survive reload, reject unfinished edits and reset', async ({
  page,
}) => {
  await settings(page);
  const ui = page.getByRole('spinbutton', { name: '界面字号', exact: true });
  const code = page.getByRole('spinbutton', { name: '代码字体大小', exact: true });
  await expect(ui).toHaveValue('14');
  await expect(code).toHaveValue('13');
  await samples(page);
  const prose = page.locator('.font-size-samples .message.user p');
  const block = page.locator('.font-size-samples .code-block pre');
  const inline = page.locator('.font-size-samples p code');
  const input = page.locator('.font-size-samples .tool-input');
  await expect(prose).toHaveCSS('font-size', '14px');
  await expect(block).toHaveCSS('font-size', '13px');
  await ui.fill('18');
  await expect(prose).toHaveCSS('font-size', '18px');
  await expect(block).toHaveCSS('font-size', '13px');
  await code.fill('16');
  for (const content of [block, inline, input])
    await expect(content).toHaveCSS('font-size', '16px');
  await expect(prose).toHaveCSS('font-size', '18px');
  await ui.fill('');
  await code.focus();
  await expect(ui).toHaveValue('18');
  await code.fill('99');
  await ui.focus();
  await expect(code).toHaveValue('16');
  await ui.press('ArrowUp');
  await expect(ui).toHaveValue('19');
  await expect(ui).toBeFocused();
  await ui.press('ArrowDown');
  await expect(ui).toHaveValue('18');
  await ui.fill('18.5');
  await ui.press('Escape');
  await expect(ui).toHaveValue('18');
  await ui.fill('21');
  await ui.press('Enter');
  await expect(ui).toHaveValue('18');
  await settings(page);
  await expect(ui).toHaveValue('18');
  await expect(code).toHaveValue('16');
  await samples(page);
  await expect(prose).toHaveCSS('font-size', '18px');
  await expect(block).toHaveCSS('font-size', '16px');
  await page.getByRole('button', { name: '恢复默认字号', exact: true }).click();
  await expect(ui).toHaveValue('14');
  await expect(code).toHaveValue('13');
  await expect(prose).toHaveCSS('font-size', '14px');
  await expect(block).toHaveCSS('font-size', '13px');
});

test('saved font values validate independently and maximum code does not widen a narrow chat', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('font-size-test-seeded')) {
      localStorage.setItem(
        'proxy-prefs',
        JSON.stringify({ fontSizes: { interface: 999, code: 24 } }),
      );
      localStorage.setItem('font-size-test-seeded', 'true');
    }
  });
  await settings(page);
  await expect(page.getByRole('spinbutton', { name: '界面字号', exact: true })).toHaveValue('14');
  await expect(page.getByRole('spinbutton', { name: '代码字体大小', exact: true })).toHaveValue(
    '24',
  );
  await samples(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(page.locator('.font-size-samples .message.user p')).toHaveCSS('font-size', '14px');
  await expect(page.locator('.font-size-samples .code-block pre')).toHaveCSS('font-size', '24px');
  const copy = page
    .locator('.font-size-samples')
    .getByRole('button', { name: '复制代码', exact: true });
  await copy.scrollIntoViewIfNeeded();
  await expect(copy).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('large font settings fit a narrow window in both themes', async ({ page }) => {
  await settings(page);
  await page.getByRole('spinbutton', { name: '界面字号', exact: true }).fill('20');
  await page.getByRole('spinbutton', { name: '代码字体大小', exact: true }).fill('24');
  await page.setViewportSize({ width: 320, height: 800 });
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('radio', { name: theme, exact: true }).click();
    const ui = page.getByRole('spinbutton', { name: '界面字号', exact: true });
    await ui.scrollIntoViewIfNeeded();
    await expect(ui).toBeInViewport();
    await expect(
      page.getByRole('spinbutton', { name: '代码字体大小', exact: true }),
    ).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: resolve(`.local/screenshots/font-sizes-narrow-${theme}.png`) });
  }
});

test('a live interface size change refits a mounted draft without typing or resizing', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '字号草稿');
  const draft = page.getByRole('textbox', { name: '消息', exact: true });
  await draft.fill('现有草稿需要随着界面字号变化重新计算高度，不能被旧的高度遮挡。'.repeat(4));
  const before = await draft.evaluate((box) => box.clientHeight);
  await page.evaluate(async () => {
    const path = '/src/prefs.ts';
    const { setPrefs } = await import(path);
    setPrefs((prefs: import('../src/prefs.ts').Prefs) => ({
      ...prefs,
      fontSizes: { ...prefs.fontSizes, interface: 20 },
    }));
  });
  await expect(draft).toHaveCSS('font-size', '20px');
  await expect.poll(() => draft.evaluate((box) => box.clientHeight)).toBeGreaterThan(before);
  expect(await draft.evaluate((box) => box.scrollHeight - box.clientHeight)).toBeLessThanOrEqual(1);
  await page.evaluate(async () => {
    const path = '/src/prefs.ts';
    const { setPrefs } = await import(path);
    setPrefs((prefs: import('../src/prefs.ts').Prefs) => ({
      ...prefs,
      fontSizes: { ...prefs.fontSizes, interface: 14 },
    }));
  });
  await expect.poll(() => draft.evaluate((box) => box.clientHeight)).toBe(before);
});
