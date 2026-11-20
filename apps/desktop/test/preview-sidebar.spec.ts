import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// A document's link to a folder, or to a file the preview cannot show, goes to the file manager; one in a
// restricted document stays in the preview, which keeps it inside its workspace, and is never handed to the system.
test('links in a previewed document to a folder or an archive follow the document’s restriction', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  await page.getByRole('button', { name: '受限链接文档', exact: true }).click();
  await pane.getByRole('link', { name: '文件夹', exact: true }).click();
  await expect(pane.getByRole('tab', { name: /^src/ })).toBeVisible();
  await pane.getByRole('tab', { name: /链接\.md/ }).click();
  await pane.getByRole('link', { name: '压缩包', exact: true }).click();
  await expect(pane.getByRole('tab', { name: /a\.zip/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).fixtureActs)).toBeUndefined();

  // Again, in a layout of its own (the first is saved as the page goes).
  await page.goto('/test/fixtures/preview-sidebar.html?connection=unrestricted');
  await page.getByRole('button', { name: '链接文档', exact: true }).click();
  await pane.getByRole('link', { name: '文件夹', exact: true }).click();
  await pane.getByRole('link', { name: '压缩包', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fixtureActs))
    .toEqual([
      ['open', 'C:\\工作\\网站预览\\src'],
      ['reveal', 'C:\\工作\\网站预览\\a.zip'],
    ]);
  await expect(pane.getByRole('tab', { name: /^src|a\.zip/ })).toHaveCount(0);
});

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
        // Narrow windows slide the preview in over the page, wide ones open its column (the shell's transition);
        // measure where it comes to rest.
        await pane.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getTiming().iterations !== Infinity)
              .map((a) => a.finished),
          ),
        );
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
          ).toBe('rgb(29, 28, 26)');
        }
        const geometry = await pane.evaluate((el) => {
          const pane = el.getBoundingClientRect();
          // The preview / source switch is one 28px control; its two buttons sit inside it.
          const controls = [
            ...el.querySelectorAll(
              '.preview-heading button,.preview-toolbar button:not(.segmented button),.preview-toolbar .segmented',
            ),
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

test('a text in another encoding names it, and a large file says only its beginning is shown', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  await page.getByRole('button', { name: 'GBK 文本', exact: true }).click();
  await expect(pane.locator('.preview-code')).toContainText('中文测试');
  await expect(pane.locator('.preview-encoding')).toHaveText('GBK');
  await expect(pane.locator('.preview-encoding')).toHaveAttribute('title', '以 GBK 编码显示');
  await expect(pane.locator('.preview-notice')).toHaveCount(0);

  await page.getByRole('button', { name: '大日志', exact: true }).click();
  const notice = pane.locator('.preview-notice');
  await expect(notice).toContainText('文件较大（12.5 MB），只显示前 4 MB');
  await expect(pane.locator('.preview-encoding')).toHaveCount(0);
  await notice.getByRole('button', { name: '在系统应用中打开', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fixtureActs))
    .toEqual([['open', 'C:\\工作\\网站预览\\大日志.log']]);
  // Just over the limit, the notice does not claim a size that reads the same as the limit.
  await page.evaluate(() => {
    (window as any).fixturePreview.configure('大日志.log', { size: 4 * 1024 * 1024 + 10 });
    (window as any).fixturePreview.emit('大日志.log');
  });
  await expect(notice).toContainText('文件超过 4 MB，只显示前 4 MB');
  // A line past the shown part goes to its end and says why.
  await pane.getByLabel('跳转到行', { exact: true }).fill('5000');
  await pane.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(pane.locator('.preview-code-note')).toHaveText(
    '第 5000 行不在已显示的部分，已跳到显示部分的末尾。',
  );
  await expect(pane.locator('.preview-code-highlight')).toHaveAttribute('data-line', '301');
});

test('an automatic refresh keeps the shown text until the new read is in', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await expect(pane.locator('.preview-markdown')).toContainText('项目说明');
  const before = await page.evaluate(() => (window as any).fixturePreview.counts().completedReads);
  await page.evaluate(() => {
    (window as any).fixturePreview.configure('说明.md', { delayMs: 800 });
    (window as any).fixturePreview.emit('说明.md');
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).fixturePreview.counts().reads))
    .toBe(before + 1);
  // The re-read is still pending: the document stays, with no loading placeholder in between.
  for (let i = 0; i < 5; i++) {
    await expect(pane.locator('.preview-markdown')).toContainText('项目说明');
    await expect(pane.getByText('正在读取文件…')).toHaveCount(0);
    await page.waitForTimeout(100);
  }
  expect(await page.evaluate(() => (window as any).fixturePreview.counts().completedReads)).toBe(
    before,
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).fixturePreview.counts().completedReads))
    .toBe(before + 1);
  await expect(pane.locator('.preview-markdown')).toContainText('项目说明');

  // A failed refresh replaces the content with its error.
  await page.evaluate(() => {
    (window as any).fixturePreview.configure('说明.md', { fail: true });
    (window as any).fixturePreview.emit('说明.md');
  });
  await expect(pane.getByRole('alert')).toHaveText('模拟读取失败，请刷新重试。');
  await expect(pane.locator('.preview-markdown')).toHaveCount(0);
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

// The tree's open folders are the session's, kept with its layout (preview.ts setFolders): a refresh reads them
// again without shutting them, and they outlast the Git changes, the tree put away, the preview put away, another
// session and a reload. A remembered folder that is gone is forgotten.
test('the workspace tree keeps its open folders', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html?git');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = page.getByRole('tree', { name: '工作区文件' });
  const src = tree.getByRole('treeitem', { name: 'src', exact: true });
  const nested = tree.getByRole('treeitem', { name: 'index.ts', exact: true });
  await src.click();
  await expect(nested).toBeVisible();
  const lists = () => page.evaluate(() => (window as any).fixturePreview.counts().lists);
  const before = await lists();
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  // Both shown folders read again; src stays open.
  await expect.poll(lists).toBe(before + 2);
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await expect(nested).toBeVisible();

  await page.getByRole('button', { name: 'Git 改动', exact: true }).click();
  await expect(tree).toHaveCount(0);
  await page.getByRole('button', { name: 'Git 改动', exact: true }).click();
  await expect(nested).toBeVisible();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  await expect(tree).toHaveCount(0);
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  await expect(nested).toBeVisible();
  await page.getByRole('button', { name: '预览开关', exact: true }).click();
  await expect(tree).toHaveCount(0);
  await page.getByRole('button', { name: '预览开关', exact: true }).click();
  await expect(nested).toBeVisible();
  // Another session has a tree of its own, shut; this one's comes back open.
  await page.getByRole('button', { name: '切换预览会话', exact: true }).click();
  await expect(nested).toHaveCount(0);
  await page.getByRole('button', { name: '切换预览会话', exact: true }).click();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(nested).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await expect(nested).toBeVisible();
  await expect(src).toHaveAttribute('aria-expanded', 'true');

  // src is deleted: the next reading forgets it, so that once it is back it is shut.
  await page.evaluate(() => ((window as any).fixtureNoSrc = true));
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(src).toHaveCount(0);
  await page.evaluate(() => ((window as any).fixtureNoSrc = false));
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await expect(src).toHaveAttribute('aria-expanded', 'false');
  await expect(nested).toHaveCount(0);
});

test('重试 after the desktop could not watch a folder watches it again', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.evaluate(() => ((window as any).fixtureFailWatch = true));
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = page.getByRole('tree', { name: '工作区文件' });
  await expect(tree.getByRole('alert')).toContainText('本机目录监听最多支持 128 个目录。');
  await page.evaluate(() => ((window as any).fixtureFailWatch = false));
  await tree.getByRole('button', { name: '重试', exact: true }).click();
  await expect(tree.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).fixturePreview.counts().activeWatches))
    .toBe(1);
  // The folder refreshes itself again on a change.
  const lists = () => page.evaluate(() => (window as any).fixturePreview.counts().lists);
  const before = await lists();
  await page.evaluate(() => (window as any).fixturePreview.emit('网站预览'));
  await expect.poll(lists).toBe(before + 1);
});

test('a file found by its name opens in the temporary tab, or kept with Ctrl+Enter', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.getByRole('button', { name: '展开空栏', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const button = page.getByRole('button', { name: '按名称打开文件', exact: true });
  const box = page.getByRole('dialog', { name: '按名称打开文件' });
  const input = box.getByRole('combobox', { name: '文件名或路径' });
  const options = box.getByRole('option');
  await button.click();
  await expect(input).toBeFocused();
  await expect(options).toHaveCount(4);
  // The name beginning with what is typed comes first, before a path holding it.
  await input.fill('READ');
  await expect(options).toHaveText(['readme.mdsrc', 'a.mdreadme-tools']);
  // Letters in order are enough.
  await input.fill('idxts');
  await expect(options).toHaveText(['index.tssrc']);
  await input.press('Enter');
  await expect(box).toHaveCount(0);
  await expect(button).toBeFocused();
  const temporary = page.getByRole('tab', { name: 'index.ts', exact: true });
  await expect(temporary).toHaveAttribute('aria-description', '临时标签，双击固定');

  await button.click();
  await input.fill('read');
  await input.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await input.press('Control+Enter');
  const kept = page.getByRole('tab', { name: 'a.md', exact: true });
  await expect(kept).toBeVisible();
  await expect(kept).not.toHaveAttribute('aria-description');
  await expect(page.getByRole('tab')).toHaveText(['index.ts', 'a.md']);

  // Escape shuts the box and gives the focus back.
  await button.click();
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(page.getByRole('tab')).toHaveCount(2);

  // An index that reached its bounds says so.
  await page.evaluate(() => ((window as any).fixtureIndexTruncated = true));
  await button.click();
  await expect(box.getByRole('status').filter({ hasText: '只索引了部分文件' })).toBeVisible();
  await expect(input).toHaveAttribute('aria-haspopup', 'listbox');
  await page.keyboard.press('Escape');
  // Listed once per opening of the box.
  expect(await page.evaluate(() => (window as any).fixturePreview.counts().indexes)).toBe(4);
});

test('the tree has one tab stop, goes left to a folder, and a typed letter finds a row', async ({
  page,
}) => {
  await page.goto('/test/fixtures/preview-sidebar.html?big');
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  await page.getByRole('button', { name: '工作区目录', exact: true }).click();
  const tree = page.getByRole('tree', { name: '工作区文件' });
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  await expect(row('说明.md')).toBeVisible();
  // Only the selected row is in the Tab order.
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await expect(row('说明.md')).toHaveAttribute('tabindex', '0');
  await expect(row('src')).toHaveAttribute('tabindex', '-1');

  await row('src').click();
  // Right on an open folder goes to its first row.
  await row('src').focus();
  await page.keyboard.press('ArrowRight');
  await expect(row('index.ts')).toBeFocused();
  await expect(row('index.ts')).toHaveAttribute('tabindex', '0');
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  // Left from a file goes to its folder; from an open folder shuts it; from a shut top folder stays.
  await page.keyboard.press('ArrowLeft');
  await expect(row('src')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(row('src')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(row('src')).toBeFocused();

  // A typed letter goes to the next row beginning with it, round to the first.
  await page.keyboard.press('b');
  await expect(row('big')).toBeFocused();
  await page.keyboard.press('S');
  await expect(row('src')).toBeFocused();
  await page.keyboard.press('b');
  await expect(row('big')).toBeFocused();

  // A folder past 2000 entries shows the first 2000 and says so.
  await row('big').click();
  await expect(tree.getByText('此文件夹有 2345 项，只显示前 2000 项')).toBeVisible();
  await expect(row('条目 2000.txt')).toHaveCount(1);
  await expect(tree.getByRole('alert')).toHaveCount(0);
});
