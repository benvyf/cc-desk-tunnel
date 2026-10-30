import { test, expect } from '@playwright/test';

test('closing a portal tab focuses the remaining tab in the popup document', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html?popup');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开弹出预览', exact: true }).click();
  const popup = await opened;
  await popup.getByRole('button', { name: '打开文档', exact: true }).click();
  await popup.getByRole('button', { name: '图片状态', exact: true }).click();
  await popup.getByRole('button', { name: '关闭预览 趋势图.png', exact: true }).click();
  await expect(popup.getByRole('tab', { name: '说明.md', exact: true })).toBeFocused();
});

test('ending a portal tab drag clears popup drop markers', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html?popup');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开弹出预览', exact: true }).click();
  const popup = await opened;
  await popup.getByRole('button', { name: '打开文档', exact: true }).click();
  await popup.locator('.preview-pane').evaluate((pane) => pane.setAttribute('data-drop', 'true'));
  await popup.locator('.preview-tab').dispatchEvent('dragend');
  await expect(popup.locator('[data-drop]')).toHaveCount(0);
});

test('closing the last tab of a popup pane focuses a tab in the surviving pane', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html?popup');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开弹出预览', exact: true }).click();
  const popup = await opened;
  await popup.getByRole('button', { name: '打开文档', exact: true }).click();
  await popup.getByRole('button', { name: '图片状态', exact: true }).click();
  await popup.getByRole('button', { name: '分栏预览', exact: true }).click();
  await expect(popup.locator('.preview-pane')).toHaveCount(2);
  await popup.getByRole('button', { name: '关闭预览 趋势图.png', exact: true }).click();
  await expect(popup.locator('.preview-pane')).toHaveCount(1);
  await expect(popup.getByRole('tab', { name: '说明.md', exact: true })).toBeFocused();
});

test('locating a portal tree file scrolls within the popup document', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html?popup');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开弹出预览', exact: true }).click();
  const popup = await opened;
  await popup.getByRole('button', { name: '打开文档', exact: true }).click();
  await popup.getByRole('button', { name: '工作区目录', exact: true }).click();
  const selected = popup.getByRole('treeitem', { name: '说明.md', exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await selected.evaluate((item) => {
    const scroll = item.scrollIntoView.bind(item);
    item.scrollIntoView = (options) => {
      item.setAttribute('data-located', 'true');
      scroll(options);
    };
  });
  await popup.getByRole('button', { name: '定位当前文件', exact: true }).click();
  await expect(selected).toHaveAttribute('data-located', 'true');
});

test('locate waits for a collapsed popup directory to load before scrolling its active file', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html?popup');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打开弹出预览', exact: true }).click();
  const popup = await opened;
  await popup.getByRole('button', { name: '打开文档', exact: true }).click();
  await popup.getByRole('button', { name: '工作区目录', exact: true }).click();
  const directory = popup.getByRole('treeitem', { name: 'src', exact: true });
  await directory.click();
  const selected = popup.getByRole('treeitem', { name: 'index.ts', exact: true });
  await selected.click();
  await directory.click();
  await expect(selected).toHaveCount(0);
  await page.evaluate(() => {
    const original = window.desktop!.preview.list;
    window.desktop!.preview.list = async (input) => {
      if (input.path?.endsWith('src')) await new Promise((resolve) => setTimeout(resolve, 150));
      return original(input);
    };
  });
  await popup.evaluate(() => {
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (options) {
      if (this.matches('[role="treeitem"][aria-selected="true"]'))
        this.setAttribute('data-located', 'true');
      original.call(this, options);
    };
  });
  await popup.getByRole('button', { name: '定位当前文件', exact: true }).click();
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toHaveAttribute('data-located', 'true');
});

test('tree selection preserves case for POSIX file paths', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html?case-sensitive');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Case.md', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'Case.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('treeitem', { name: 'case.md', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
});
