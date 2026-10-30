import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('lazy tree opens a local file, refreshes and reports missing directories', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = page.getByRole('tree', { name: '工作区文件' });
  await expect(tree.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'index.ts', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'index.ts', exact: true })).toBeVisible();
  await expect(page.locator('.preview-code')).toContainText('CC SPACE');
});

test('split, drag between panes, float/dock and restore persist only metadata', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('button', { name: '图片状态', exact: true }).click();
  await page.getByRole('button', { name: '分栏预览', exact: true }).click();
  await expect(page.locator('.preview-pane')).toHaveCount(2);
  await page
    .getByRole('tab', { name: '说明.md', exact: true })
    .dragTo(page.locator('.preview-pane').last().locator('.preview-tabs'));
  await expect(page.locator('.preview-pane')).toHaveCount(1);
  await page
    .getByRole('tab', { name: '说明.md', exact: true })
    .dragTo(page.getByRole('tab', { name: '趋势图.png', exact: true }));
  await expect(page.getByRole('tab')).toHaveText(['说明.md', '趋势图.png']);
  await page.getByRole('button', { name: '分栏预览', exact: true }).click();
  await expect(page.locator('.preview-pane')).toHaveCount(2);

  const floating = page.getByRole('button', { name: '浮动预览', exact: true }).last();
  await floating.click();
  await expect(page.locator('.preview-pane-floating')).toHaveCount(1);
  const heading = page.locator('.preview-pane-floating .preview-pane-heading');
  const start = await heading.boundingBox();
  await page.mouse.move(start!.x + 20, start!.y + 10);
  await page.mouse.down();
  await page.mouse.move(1200, 750);
  await page.mouse.up();
  await page.setViewportSize({ width: 640, height: 700 });
  await expect
    .poll(async () => {
      const rect = await page.locator('.preview-pane-floating').boundingBox();
      return rect!.x + rect!.width;
    })
    .toBeLessThanOrEqual(640);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: '停靠预览', exact: true }).click();
  await expect(page.locator('.preview-pane-floating')).toHaveCount(0);
  await page.waitForTimeout(200);
  const saved = await page.evaluate(
    () => Object.entries(localStorage).find(([key]) => key.startsWith('cc-preview-v1:'))?.[1] ?? '',
  );
  expect(saved).toContain('说明.md');
  expect(saved).not.toContain('在这里查看生成的文件');
  await page.reload();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(page.getByRole('tab', { name: '说明.md', exact: true })).toBeVisible();
});

test('restored websites require a user click before any native request', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '网站错误', exact: true }).click();
  await page.waitForTimeout(200);
  await page.reload();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '加载此预览', exact: true })).toBeVisible();
  await expect(page.locator('.preview-native')).toHaveCount(0);
});

test('PDF renders locally with page and zoom controls', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: 'PDF 状态', exact: true }).click();
  await expect(page.locator('.preview-pdf canvas')).toBeVisible();
  await expect(page.locator('.preview-pdf-pages')).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(() =>
      page.locator('.preview-pdf canvas').evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const pixels = canvas
          .getContext('2d')!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 180 && pixels[i + 3] > 0) ink++;
        return ink;
      }),
    )
    .toBeGreaterThan(10);

  await expect(page.getByLabel('PDF 页码')).toHaveValue('1');
  await page.getByRole('button', { name: '放大 PDF', exact: true }).click();
  await expect(page.locator('.preview-pdf')).toContainText('125%');
});

for (const [theme, width, font] of [
  ['light', 1440, 14],
  ['dark', 1440, 14],
  ['dark', 390, 20],
] as const) {
  test(`workspace geometry and shared style ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/test/fixtures/preview-sidebar.html');
    await page.evaluate(
      ({ theme, font }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.fontSize = `${font}px`;
      },
      { theme, font },
    );
    await page.getByRole('button', { name: '打开文档', exact: true }).click();
    if (width < 700) await page.getByRole('button', { name: '收起预览', exact: true }).click();
    await page.getByRole('button', { name: '图片状态', exact: true }).click();
    await page.getByRole('button', { name: '分栏预览', exact: true }).click();
    await page.getByRole('button', { name: '工作区目录', exact: true }).click();
    if (width > 700) await page.getByRole('button', { name: '放大预览', exact: true }).click();
    for (const pane of await page.locator('.preview-pane').all()) {
      const rect = await pane.boundingBox();
      expect(rect!.width).toBeGreaterThan(150);
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
    }
    const output = resolve('.local/screenshots/preview-workspace');
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
  });
}

test('workspace change releases every cached view including inactive websites', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '网站错误', exact: true }).click();
  await page.waitForTimeout(200);
  const webId = await page.evaluate(() => {
    const value = Object.entries(localStorage).find(([k]) => k.startsWith('cc-preview-v1:'))![1];
    return JSON.parse(value).boards.session.tabs.find((t: any) => t.kind === 'web').id;
  });
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('button', { name: '切换预览工作区', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).fixtureReleased)).toContain(webId);
});

test('restored HTML behind a text alias still needs explicit activation', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.waitForTimeout(200);
  const storedAlias = await page.evaluate(() => {
    const [key, value] = Object.entries(localStorage).find(([k]) =>
      k.startsWith('cc-preview-v1:'),
    )!;
    const layout = JSON.parse(value);
    layout.boards.session.tabs[0].target = 'C:\\work\\alias.txt';
    return { key, value: JSON.stringify(layout) };
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), storedAlias);
  await page.reload();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '加载此预览', exact: true })).toBeVisible();
  await expect(page.locator('.preview-native')).toHaveCount(0);
  await page.getByRole('button', { name: '加载此预览', exact: true }).click();
  await expect(page.locator('.preview-native')).toHaveCount(1);
});
