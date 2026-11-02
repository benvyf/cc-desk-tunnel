import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The right-hand preview panel follows the side column's rules (phase 3g): tree rows, the blue divider, the
// path row, tabs without clay, the narrow window's overlay and the terminal strip; the empty state stays as it was.
const fixture = '/test/fixtures/preview-sidebar.html';
const pane = (page: Page) => page.getByRole('complementary', { name: '文件与网站预览' });
const settle = (page: Page) =>
  pane(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
const colorOf = (page: Page, token: string) =>
  page.evaluate((token) => {
    const probe = document.createElement('i');
    probe.style.background = `var(${token})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, token);

test('the workspace tree has the side column rows and its own column', async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const aside = pane(page);
  const before = await aside.boundingBox();
  const panesBefore = await aside.locator('.preview-panes').boundingBox();
  await aside.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = aside.getByRole('tree', { name: '工作区文件' });
  await expect(tree).toBeVisible();
  // Opening the tree adds its column: the file keeps its width.
  const after = await aside.boundingBox();
  expect(Math.round(after!.width - before!.width)).toBe(200);
  expect(Math.round((await aside.locator('.preview-panes').boundingBox())!.width)).toBe(
    Math.round(panesBefore!.width),
  );
  // The tree's heading meets the tab row's hairline.
  const head = await aside.locator('.preview-tree > header').boundingBox();
  const row = await aside.locator('.preview-pane-heading').first().boundingBox();
  expect(Math.round(head!.y + head!.height)).toBe(Math.round(row!.y + row!.height));

  await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
  const top = tree.getByRole('treeitem', { name: 'src', exact: true });
  const nested = tree.getByRole('treeitem', { name: 'index.ts', exact: true });
  await expect(nested).toHaveAttribute('aria-level', '2');
  await expect(top).toHaveAttribute('aria-level', '1');
  const [a, b] = [await top.boundingBox(), await nested.boundingBox()];
  // Rows of every level span the tree; only the content moves in, 16px a level.
  expect(b!.x).toBe(a!.x);
  expect(b!.width).toBe(a!.width);
  expect(a!.height).toBeGreaterThanOrEqual(32);
  const iconX = async (item: typeof top) => (await item.locator('svg').boundingBox())!.x;
  expect(Math.round((await iconX(nested)) - (await iconX(top)))).toBe(16);
  const style = await top.evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, size: s.fontSize };
  });
  expect(style).toEqual({ radius: '8px', size: '14px' });

  // The open file is selected with the selected fill and the text colour, not clay.
  const selected = tree.getByRole('treeitem', { name: '说明.md', exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  const fill = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill).toBe(await colorOf(page, '--selected'));
  expect(await selected.evaluate((el) => getComputedStyle(el).color)).toBe(
    await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--text)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }),
  );
  await expect(
    aside.locator('.preview-tree > header').getByRole('button', { name: '定位当前文件' }),
  ).toBeVisible();
});

// benben kept the original empty state (2026-11-02): folder icon, title, one line and an "open file" button.
test('an empty preview keeps its icon, title and open button', async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  const empty = pane(page).locator('.preview-empty');
  await expect(empty.locator('> svg')).toHaveCSS('width', '32px');
  await expect(empty.getByRole('heading', { name: '在这里查看成果' })).toBeVisible();
  await expect(empty.locator('p')).toHaveText('选择目录中的文件，或打开本机文件。');
  await empty.getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(pane(page).getByRole('tab', { name: '说明.md' })).toBeVisible();
});

test('the width divider shows the side column’s blue line on hover and keyboard focus', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const divider = pane(page).getByRole('separator', { name: '调整预览宽度' });
  const line = () =>
    divider.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return { color: s.backgroundColor, width: s.width };
    });
  const blue = await colorOf(page, '--focus');
  expect((await line()).color).toBe('rgba(0, 0, 0, 0)');
  await divider.hover();
  await expect.poll(async () => (await line()).color).toBe(blue);
  expect((await line()).width).toBe('2px');
  await page.mouse.move(5, 5);
  await expect.poll(async () => (await line()).color).toBe('rgba(0, 0, 0, 0)');
  await page.keyboard.press('Shift');
  await divider.focus();
  await expect.poll(async () => (await line()).color).toBe(blue);
  await expect(divider).toHaveCSS('outline-style', 'none');
});

test('the path row names the file and switches preview and source with one control', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const aside = pane(page);
  const path = aside.locator('.preview-path');
  await expect(path).toHaveText('说明.md');
  await expect(path).toHaveAttribute('title', 'C:\\工作\\网站预览\\说明.md');
  const mode = aside.getByRole('group', { name: '显示方式' });
  await expect(mode).toHaveCSS('height', '28px');
  const preview = mode.getByRole('button', { name: '预览', exact: true });
  const source = mode.getByRole('button', { name: '源码', exact: true });
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  await expect(aside.locator('.code-block')).toBeVisible();
  // Choosing the shown mode again leaves it.
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  await preview.click();
  await expect(aside.locator('.preview-markdown')).toBeVisible();
  // The switch comes before the row's icons.
  const [m, r] = [
    await mode.boundingBox(),
    await aside.getByRole('button', { name: '刷新预览' }).boundingBox(),
  ];
  expect(m!.x).toBeLessThan(r!.x);

  // A nested file keeps its name whole; the folders give way.
  await aside.getByRole('button', { name: '工作区目录', exact: true }).click();
  await aside.getByRole('treeitem', { name: 'src', exact: true }).click();
  await aside.getByRole('treeitem', { name: 'index.ts', exact: true }).click();
  await expect(path.locator('.preview-path-folder')).toHaveText('src\\');
  await expect(path.locator('.preview-path-name')).toHaveText('index.ts');
});

test('tabs use the selected fill instead of a clay underline', async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('button', { name: '图片状态', exact: true }).click();
  const tabs = pane(page).locator('.preview-tab');
  await expect(tabs).toHaveCount(2);
  const active = pane(page).locator('.preview-tab.active');
  const look = await active.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fill: s.backgroundColor,
      underline: s.borderBottomWidth,
      radius: s.borderTopLeftRadius,
    };
  });
  expect(look).toEqual({
    fill: await colorOf(page, '--selected'),
    underline: '0px',
    radius: '8px',
  });
  // The other tab's close button waits for the pointer.
  const other = pane(page).locator('.preview-tab:not(.active)');
  await page.mouse.move(5, 5);
  await expect(other.locator('.icon-button')).toHaveCSS('opacity', '0');
  await other.hover();
  await expect(other.locator('.icon-button')).toHaveCSS('opacity', '1');
});

test('a narrow window lays the preview over the page with a shade that puts it away', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const shade = page.locator('.preview-shade');
  await expect(shade).toBeHidden();
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.getByRole('button', { name: '预览开关', exact: true }).click();
  await page.getByRole('button', { name: '预览开关', exact: true }).click();
  await expect(pane(page)).toBeVisible();
  // It slides in from the window's edge.
  const names = await pane(page).evaluate((el) =>
    el.getAnimations().map((a) => (a as CSSAnimation).animationName),
  );
  expect(names).toContain('preview-slide-in');
  await settle(page);
  await expect(shade).toBeVisible();
  const [s, p] = [await shade.boundingBox(), await pane(page).boundingBox()];
  expect(s!.x).toBe(0);
  expect(Math.round(p!.x + p!.width)).toBe(1000);
  await page.mouse.click(100, 400);
  await expect(pane(page)).toHaveCount(0);
  await expect(shade).toHaveCount(0);
});

test('the terminal window keeps the drag strip and moves the controls into the tab row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`${fixture}?terminal=1`);
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const aside = pane(page);
  const heading = aside.locator('.preview-heading');
  await expect(heading).toHaveText('预览');
  await expect(heading.locator('button')).toHaveCount(0);
  await expect(heading.locator('strong')).toHaveCSS('height', '36px');
  const row = aside.locator('.preview-pane-heading');
  await expect(row.getByRole('button', { name: '收起预览', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: '工作区目录', exact: true })).toBeVisible();
  // Three rows: the strip, the tabs, the path.
  const [h, t, b] = [
    await heading.boundingBox(),
    await row.boundingBox(),
    await aside.locator('.preview-toolbar').boundingBox(),
  ];
  expect(Math.round(t!.y)).toBe(Math.round(h!.y + h!.height));
  expect(Math.round(b!.y)).toBe(Math.round(t!.y + t!.height));
  // No shade in the terminal window.
  await expect(page.locator('.preview-shade')).toHaveCount(0);
});
