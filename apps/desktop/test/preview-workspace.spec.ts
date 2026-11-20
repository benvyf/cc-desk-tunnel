import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function waitForStoredLayout(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) =>
            key.startsWith('cc-preview-v1:') &&
            Object.values(JSON.parse(value).boards).some((board: any) => board.tabs.length > 0),
        ),
      ),
    )
    .toBe(true);
}

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
  await expect(page.locator('.preview-code')).toContainText('CC Space');
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
  await waitForStoredLayout(page);
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
  await waitForStoredLayout(page);
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

const geometryCases = (['light', 'dark'] as const).flatMap((theme) =>
  [1440, 1024, 390].flatMap((width) => [14, 20].map((font) => ({ theme, width, font }))),
);
for (const { theme, width, font } of geometryCases) {
  test(`workspace geometry and shared style ${theme} ${width} ${font}px`, async ({ page }) => {
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
    if (width <= 1050) await page.getByRole('button', { name: '收起预览', exact: true }).click();
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
    await page.screenshot({ path: resolve(output, `${theme}-${width}-${font}px.png`) });
  });
}

test('workspace change releases every cached view including inactive websites', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '网站错误', exact: true }).click();
  await waitForStoredLayout(page);
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
  await waitForStoredLayout(page);
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

// VS Code's preview mode: a single click opens the file in a temporary tab, which the next single click takes over.
test('a single click opens a temporary tab that the next one replaces; a double-click keeps it', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = page.getByRole('tree', { name: '工作区文件' });
  const tabs = page.getByRole('tab');
  await tree.getByRole('treeitem', { name: '说明.md', exact: true }).click();
  await expect(tabs).toHaveText(['说明.md']);
  const first = page.getByRole('tab', { name: '说明.md', exact: true });
  await expect(first).toHaveAttribute('aria-description', '临时标签，双击固定');
  await expect(first.locator('span')).toHaveCSS('font-style', 'italic');
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'index.ts', exact: true }).click();
  await expect(tabs).toHaveText(['index.ts']);
  // The replaced tab's view is released as a closed one's is.
  await expect
    .poll(() => page.evaluate(() => new Set((window as any).fixtureReleased ?? []).size))
    .toBe(1);
  await tree.getByRole('treeitem', { name: 'index.ts', exact: true }).dblclick();
  const kept = page.getByRole('tab', { name: 'index.ts', exact: true });
  await expect(kept).not.toHaveAttribute('aria-description');
  await expect(kept.locator('span')).toHaveCSS('font-style', 'normal');
  await tree.getByRole('treeitem', { name: '说明.md', exact: true }).click();
  await expect(tabs).toHaveText(['index.ts', '说明.md']);
  await expect(page.getByRole('tab', { name: '说明.md', exact: true })).toHaveAttribute(
    'aria-description',
    '临时标签，双击固定',
  );
  // A double-click on the tab keeps it too; the next click then opens a new temporary tab.
  await page.getByRole('tab', { name: '说明.md', exact: true }).dblclick();
  await expect(page.getByRole('tab', { name: '说明.md', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await expect(tabs).toHaveText(['index.ts', '说明.md', '长代码.ts']);
  await expect(page.getByRole('tab', { name: '长代码.ts', exact: true })).toHaveAttribute(
    'aria-description',
    '临时标签，双击固定',
  );
  // Following another link to the temporary tab's file goes to it there.
  await page.getByRole('button', { name: '定位代码第20行', exact: true }).click();
  await expect(tabs).toHaveText(['index.ts', '说明.md', '长代码.ts']);
  // Moving the temporary tab to another pane keeps it.
  await page.getByRole('button', { name: '分栏预览', exact: true }).click();
  await expect(page.locator('.preview-pane')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: '长代码.ts', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
});

test('a tab’s menu keeps or closes tabs, and the middle button closes one', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  for (const name of ['打开文档', '图片状态', '长文本', 'GBK 文本'])
    await page.getByRole('button', { name, exact: true }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['说明.md', '趋势图.png', '长阅读.txt', '旧编码.txt']);
  await page.getByRole('tab', { name: '趋势图.png', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '标签 趋势图.png' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    '关闭',
    '关闭其他标签',
    '关闭右侧标签',
    '关闭全部',
  ]);
  await menu.getByRole('menuitem', { name: '关闭右侧标签' }).click();
  await expect(tabs).toHaveText(['说明.md', '趋势图.png']);

  // From the keyboard: Shift+F10 on the selected tab; the tablist's arrows still move between tabs.
  await page.getByRole('button', { name: '长文本', exact: true }).click();
  await page.getByRole('tab', { name: '长阅读.txt', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '趋势图.png', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '标签 趋势图.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '趋势图.png', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: '关闭其他标签' }).click();
  await expect(tabs).toHaveText(['趋势图.png']);
  await expect(page.getByRole('tab', { name: '趋势图.png', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // A temporary tab's menu offers to keep it.
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await expect(tabs).toHaveText(['趋势图.png', '长代码.ts']);
  await page.getByRole('tab', { name: '长代码.ts', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '固定标签' }).click();
  await expect(page.getByRole('tab', { name: '长代码.ts', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
  await page.getByRole('tab', { name: '长代码.ts', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '固定标签' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '趋势图.png', exact: true }).click({ button: 'middle' });
  await expect(tabs).toHaveText(['长代码.ts']);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('tab', { name: '说明.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭全部' }).click();
  await expect(tabs).toHaveCount(0);
});

test('a saved layout keeps temporary tabs, and one saved before them keeps every tab', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await waitForStoredLayout(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) => key.startsWith('cc-preview-v1:') && value.includes('"temporary":true'),
        ),
      ),
    )
    .toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(page.getByRole('tab', { name: '长代码.ts', exact: true })).toHaveAttribute(
    'aria-description',
    '临时标签，双击固定',
  );
  await expect(page.getByRole('tab', { name: '说明.md', exact: true })).not.toHaveAttribute(
    'aria-description',
  );

  await page.goto('/test/fixtures/preview-sidebar.html?connection=old');
  await page.evaluate(() =>
    localStorage.setItem(
      'cc-preview-v1:old:main:fixture',
      JSON.stringify({
        width: 440,
        boards: {
          session: {
            tabs: [{ id: 'old', kind: 'file', target: 'C:\\工作\\网站预览\\趋势图.png' }],
            panes: [{ id: 'primary', tabs: ['old'], active: 'old' }],
            focused: 'primary',
            expanded: true,
            tree: false,
          },
        },
      }),
    ),
  );
  await page.reload();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(page.getByRole('tab', { name: '趋势图.png', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveText(['趋势图.png', '长代码.ts']);
});

test('with all 64 tabs kept an opening says so; a temporary tab is taken over instead', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '填满标签', exact: true }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(64);
  const notice = page.getByRole('alert').filter({ hasText: '预览标签已满（64 个）' });
  await expect(notice).toHaveCount(0);
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await expect(notice).toHaveText('预览标签已满（64 个），请先关闭一些标签。');
  await expect(tabs).toHaveCount(64);
  await page.getByRole('tab', { name: '满 0.json', exact: true }).click({ button: 'middle' });
  await expect(notice).toHaveCount(0);
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await expect(tabs).toHaveCount(64);
  await expect(page.getByRole('tab', { name: '长代码.ts', exact: true })).toBeVisible();
  // Full, a kept opening takes the temporary tab's place rather than being refused.
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await expect(tabs).toHaveCount(64);
  await expect(page.getByRole('tab', { name: '长代码.ts', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '说明.md', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
  await expect(notice).toHaveCount(0);
});

test('a link followed from inside a temporary tab opens beside it and keeps it', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  const tabs = pane.getByRole('tab');
  await page.getByRole('button', { name: '临时链接文档', exact: true }).click();
  await expect(pane.getByRole('tab', { name: '链接.md', exact: true })).toHaveAttribute(
    'aria-description',
    '临时标签，双击固定',
  );
  // A restricted document's folder link stays in the preview, as a new temporary tab.
  await pane.getByRole('link', { name: '文件夹', exact: true }).click();
  await expect(tabs).toHaveText(['链接.md', 'src']);
  await expect(pane.getByRole('tab', { name: '链接.md', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
  await expect(pane.getByRole('tab', { name: 'src', exact: true })).toHaveAttribute(
    'aria-description',
    '临时标签，双击固定',
  );
  await pane.getByRole('tab', { name: 'src', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭全部' }).click();
  await expect(tabs).toHaveCount(0);

  // A temporary page's window.open keeps the page and opens its target beside it.
  await page.getByRole('button', { name: '临时网站', exact: true }).click();
  await expect(tabs).toHaveText(['localhost:5173/']);
  await expect
    .poll(() => page.evaluate(() => (window as any).fixturePreview.counts().nativeShows))
    .toBeGreaterThan(0);
  await page.evaluate(() =>
    (window as any).fixturePreview.openFromPage({
      kind: 'file',
      target: 'C:\\工作\\网站预览\\说明.md',
      root: 'C:\\工作\\网站预览',
    }),
  );
  await expect(tabs).toHaveText(['localhost:5173/', '说明.md']);
  await expect(pane.getByRole('tab', { name: 'localhost:5173/', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
});

test('closing several tabs releases each closed tab’s view', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  for (const name of ['打开文档', '图片状态', '长文本', 'GBK 文本'])
    await page.getByRole('button', { name, exact: true }).click();
  // Releases per key so far; a tab switched away from releases its native view already.
  const counts = () =>
    page.evaluate(() => {
      const counts: Record<string, number> = {};
      for (const key of (window as any).fixtureReleased ?? []) counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    });
  const releasedSince = async (before: Record<string, number>) =>
    Object.entries(await counts()).filter(([key, n]) => n > (before[key] ?? 0)).length;
  let before = await counts();
  await page.getByRole('tab', { name: '说明.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭右侧标签' }).click();
  await expect(page.getByRole('tab')).toHaveText(['说明.md']);
  await expect.poll(() => releasedSince(before)).toBe(3);
  before = await counts();
  await page.getByRole('tab', { name: '说明.md', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '关闭全部' }).click();
  await expect.poll(() => releasedSince(before)).toBe(1);
});

test('the full-strip notice belongs to the session where the opening was refused', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '填满标签', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(64);
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  const notice = page.getByRole('alert').filter({ hasText: '预览标签已满（64 个）' });
  await expect(notice).toBeVisible();
  await page.getByRole('button', { name: '切换预览会话', exact: true }).click();
  await page.getByRole('button', { name: '填满标签', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(64);
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: '切换预览会话', exact: true }).click();
  await expect(notice).toBeVisible();
});

test('the tree row menu opens a file to keep, and Enter on the shown file keeps its tab', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = page.getByRole('tree', { name: '工作区文件' });
  const row = tree.getByRole('treeitem', { name: '说明.md', exact: true });
  await row.focus();
  await page.keyboard.press('Enter');
  const tab = page.getByRole('tab', { name: '说明.md', exact: true });
  await expect(tab).toHaveAttribute('aria-description', '临时标签，双击固定');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(tab).not.toHaveAttribute('aria-description');
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'index.ts', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '打开并固定' }).click();
  await expect(page.getByRole('tab')).toHaveText(['说明.md', 'index.ts']);
  await expect(page.getByRole('tab', { name: 'index.ts', exact: true })).not.toHaveAttribute(
    'aria-description',
  );
  await tree.getByRole('treeitem', { name: 'src', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '打开并固定' })).toHaveCount(0);
});
