import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const output = resolve('.local/screenshots/preview-ui');
mkdirSync(output, { recursive: true });
for (const theme of ['light', 'dark'])
  for (const [width, font] of [
    [1240, 14],
    [390, 20],
  ]) {
    test(`preview UI matches shared controls: ${theme}, ${width}px, font ${font}`, async ({
      page,
    }) => {
      for (const [name, button] of [
        ['empty', '展开空栏'],
        ['markdown', '打开文档'],
        ['source', '长文件名'],
        ['error', '错误状态'],
        ['loading', '加载状态'],
        ['image', '图片状态'],
        ['website', '网站错误'],
      ]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/test/fixtures/preview-sidebar.html');
        await page.evaluate(
          ({ theme, font, codeFont }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.fontSize = `${font}px`;
            document.documentElement.style.setProperty('--code-font-size', `${codeFont}px`);
          },
          { theme, font, codeFont: name === 'source' ? 24 : 13 },
        );
        await page.getByRole('button', { name: button, exact: true }).click();
        const pane = page.getByRole('complementary', { name: '文件与网站预览' });
        await expect(pane).toBeVisible();
        if (name === 'error' || name === 'website')
          await expect(pane.getByRole('alert')).toBeVisible();
        if (name === 'loading') {
          await expect(pane.getByRole('status')).toContainText('正在读取');
          await expect(pane.getByRole('button', { name: '源码', exact: true })).toBeDisabled();
        }
        if (name === 'source') {
          await expect(pane.locator('.code-block')).toBeVisible();
          expect(
            await pane
              .locator('.code-block')
              .evaluate((el) => getComputedStyle(el).backgroundColor),
          ).toBe('rgb(23, 23, 22)');
        }
        const geometry = await pane.evaluate((el) => {
          const pane = el.getBoundingClientRect();
          const controls = [
            ...el.querySelectorAll('.preview-heading button,.preview-toolbar button'),
          ].map((button) => button.getBoundingClientRect());
          return {
            left: pane.left,
            right: pane.right,
            viewport: innerWidth,
            buttons: controls.map((r) => ({
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
            })),
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.overflow).toBe(false);
        for (const button of geometry.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(geometry.left);
          expect(button.right).toBeLessThanOrEqual(geometry.right + 1);
          expect(button.height).toBe(28);
        }
        await pane.screenshot({ path: resolve(output, `${name}-${theme}-${width}.png`) });
      }
    });
  }
test('preview tabs reveal long names, keep keyboard focus and restore the opener', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '多个标签', exact: true }).click();
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  const selected = pane.getByRole('tab', { selected: true });
  await expect(selected).toContainText('报告 7');
  const geometry = await selected.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      parent = el.closest('[role="tablist"]')!.getBoundingClientRect();
    return { left: r.left, right: r.right, parentLeft: parent.left, parentRight: parent.right };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft);
  expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight);
  await selected.focus();
  await selected.dispatchEvent('keydown', { key: 'ArrowLeft', altKey: true });
  await expect(selected).toContainText('报告 7');
  await selected.dispatchEvent('keydown', { key: 'Home', ctrlKey: true });
  await expect(selected).toContainText('报告 7');
  const divider = pane.getByRole('separator', { name: '调整预览宽度' });
  await divider.dispatchEvent('keydown', { key: 'ArrowLeft', altKey: true });
  await expect(divider).toHaveAttribute('aria-valuenow', '440');
  await page.keyboard.press('Home');
  await expect(selected).toContainText('报告 0');
  await expect(selected).toBeFocused();
  expect(await selected.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('ArrowLeft');
  await expect(selected).toContainText('报告 7');
  await pane.getByRole('button', { name: /^关闭预览 报告 7/ }).click();
  await expect(selected).toBeFocused();
  await pane.getByRole('button', { name: '收起预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '预览开关', exact: true })).toBeFocused();
});

test('long errors remain scrollable inside a short preview without pushing controls away', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 300 });
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  await page.getByRole('button', { name: '长错误状态', exact: true }).click();
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  await expect(pane.getByRole('alert')).toBeVisible();
  const result = await pane.getByRole('alert').evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    parentBottom: el.closest('aside')!.getBoundingClientRect().bottom,
    scrollable: el.scrollHeight > el.clientHeight,
  }));
  expect(result.bottom).toBeLessThanOrEqual(result.parentBottom);
  expect(result.scrollable).toBe(true);
  await expect(pane.getByRole('button', { name: '刷新预览', exact: true })).toBeInViewport();
  await expect(pane.getByRole('button', { name: '收起预览', exact: true })).toBeInViewport();
});
test('terminal preview controls leave the Windows title bar free and short empty panels scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto('/test/fixtures/preview-sidebar.html?terminal=1');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  const bounds = await pane.locator('.preview-heading-actions').boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(36);
  await pane.screenshot({ path: resolve(output, 'terminal-empty.png') });
  await page.setViewportSize({ width: 390, height: 300 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  await expect(pane.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: '打开文件', exact: true }).scrollIntoViewIfNeeded();
  await expect(pane.getByRole('button', { name: '打开文件', exact: true })).toBeInViewport();
});

test('successful retries clear errors from file selection and system opening', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  await page.evaluate(() => {
    (window as any).fixtureFailPick = true;
  });
  await pane.getByRole('button', { name: '打开本机文件', exact: true }).click();
  await expect(pane.getByRole('alert')).toContainText('模拟文件选择失败');
  await pane.getByRole('button', { name: '打开本机文件', exact: true }).click();
  await expect(pane.locator('.preview-document h1')).toHaveText('项目说明');
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).fixtureFailOpen = true;
  });
  await pane.getByRole('button', { name: '在系统应用中打开', exact: true }).click();
  await expect(pane.getByRole('alert')).toContainText('模拟系统打开失败');
  await pane.getByRole('button', { name: '在系统应用中打开', exact: true }).click();
  await expect(pane.getByRole('alert')).toHaveCount(0);
});
