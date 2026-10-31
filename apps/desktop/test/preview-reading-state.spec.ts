import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const fixture = '/test/fixtures/preview-sidebar.html';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const doc = (page: Page) =>
  page.locator('.preview-document').filter({
    has: page.locator('.preview-code, .preview-markdown, .preview-loading, .preview-unavailable'),
  });
const offset = (element: Locator) => element.evaluate((node) => node.scrollTop);
async function at(element: Locator, top: number, left?: number) {
  await expect.poll(async () => Math.abs((await offset(element)) - top)).toBeLessThanOrEqual(2);
  if (left !== undefined)
    await expect.poll(() => element.evaluate((node) => node.scrollLeft)).toBe(left);
}
async function scroll(element: Locator, top: number, left?: number) {
  // Model reader intent even when these deterministic offsets beat the initial settling frames.
  await element.dispatchEvent('wheel', { deltaY: 1 });
  await element.evaluate(
    (node, position) => {
      node.scrollTop = position.top;
      if (position.left !== undefined) node.scrollLeft = position.left;
    },
    { top, left },
  );
  await at(element, top, left);
}
async function change(page: Page, suffix: string, options: Record<string, unknown>) {
  await page.evaluate(
    ({ suffix, options }) => {
      (window as any).fixturePreview.configure(suffix, options);
      (window as any).fixturePreview.emit(suffix);
    },
    { suffix, options },
  );
}
async function counts(page: Page) {
  return page.evaluate(() => (window as any).fixturePreview.counts());
}
async function restart(page: Page) {
  await page.reload();
  await button(page, '展开空栏').click();
}
async function textReady(page: Page) {
  await expect(doc(page)).toContainText('Reading paragraph 360');
}
async function cloneTabToOtherSession(page: Page) {
  const copy = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    const [key, value] = Object.entries(localStorage).find(([key]) => key.endsWith(':fixture'))!;
    const layout = JSON.parse(value);
    layout.boards['other-session'] = structuredClone(layout.boards.session);
    return { key, value: JSON.stringify(layout) };
  });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), copy);
  await restart(page);
}

test('blocked local storage access keeps preview reading usable in memory', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage access blocked', 'SecurityError');
      },
    }),
  );
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 700);
  await button(page, '图片状态').click();
  await page.getByRole('tab', { name: '长阅读.txt', exact: true }).click();
  await textReady(page);
  await at(doc(page), 700);
  expect(errors).toEqual([]);
});

test('PDF page input normalizes fractional values before rendering and saving', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  const pages = page.locator('.preview-pdf-pages');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('PDF 页码').fill('2.75');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('2');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.preview-pdf canvas')).toBeVisible();
  await expect(page.locator('.preview-pdf canvas')).toHaveAttribute('aria-label', 'PDF 第 2 页');
  await expect(page.locator('.preview-pdf [role="alert"]')).toHaveCount(0);
  await button(page, '下一页').click();
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await restart(page);
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
});

test('text reading position survives switching tabs, float/dock and normal reload', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 700);
  await button(page, '图片状态').click();
  await page.getByRole('tab', { name: '长阅读.txt', exact: true }).click();
  await textReady(page);
  await at(doc(page), 700);
  await button(page, '浮动预览').click();
  await expect(page.locator('.preview-pane-floating')).toHaveCount(1);
  await at(doc(page), 700);
  await button(page, '停靠预览').click();
  await at(doc(page), 700);
  await restart(page);
  await textReady(page);
  await at(doc(page), 700);
  const saved = await page.evaluate(
    () => Object.entries(localStorage).find(([key]) => key.startsWith('cc-preview-v1:'))![1],
  );
  expect(saved).not.toContain('Reading paragraph');
  expect(await counts(page)).toMatchObject({ reads: 1, nativeShows: 0 });
});

test('code restores outer vertical and actual code-pre horizontal scroll positions', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长代码').click();
  await expect(doc(page)).toContainText('readingRow360');
  const pre = page.locator('.preview-code pre');
  await expect
    .poll(() => pre.evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeGreaterThan(400);
  await scroll(doc(page), 900);
  await pre.evaluate((node) => {
    node.scrollLeft = 360;
  });
  await button(page, '图片状态').click();
  await page.getByRole('tab', { name: '长代码.ts', exact: true }).click();
  await expect(doc(page)).toContainText('readingRow360');
  await at(doc(page), 900);
  await expect.poll(() => pre.evaluate((node) => node.scrollLeft)).toBe(360);
  await restart(page);
  await at(doc(page), 900);
  await expect.poll(() => pre.evaluate((node) => node.scrollLeft)).toBe(360);
});

for (const exit of ['pagehide', 'beforeunload']) {
  test(`${exit} samples the last DOM offset before the persistence handler flushes`, async ({
    page,
  }) => {
    await page.goto(fixture);
    await button(page, '长文本').click();
    await textReady(page);
    await scroll(doc(page), 700);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const value = Object.entries(localStorage).find(([key]) =>
            key.startsWith('cc-preview-v1:'),
          )?.[1];
          if (!value) return false;
          const saved = JSON.parse(value);
          const tab = saved.boards.session?.tabs.find((tab: any) =>
            tab.target.endsWith('长阅读.txt'),
          );
          return saved.reading?.sessions.session?.[tab?.id]?.top === 700;
        }),
      )
      .toBe(true);
    const savedPosition = await page.evaluate((exit) => {
      // No scroll event or animation frame can run between this mutation and the exit flush.
      document.querySelector('.preview-document')!.scrollTop = 1700;
      window.dispatchEvent(new Event(exit));
      const value = Object.entries(localStorage).find(([key]) =>
        key.startsWith('cc-preview-v1:'),
      )![1];
      const saved = JSON.parse(value);
      const tab = saved.boards.session.tabs.find((tab: any) => tab.target.endsWith('长阅读.txt'));
      return saved.reading?.sessions.session[tab.id]?.top;
    }, exit);
    expect(savedPosition).toBe(1700);
    await restart(page);
    await textReady(page);
    await at(doc(page), 1700);
  });
}

test('Markdown preview and source retain separate positions and selected mode', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长 Markdown').click();
  await expect(page.locator('.preview-markdown')).toContainText('Section 100');
  await scroll(doc(page), 800);
  await button(page, '源码').click();
  await expect(page.locator('.preview-code')).toContainText('section100');
  await scroll(doc(page), 1400);
  await page.locator('.preview-code pre').evaluate((node) => {
    node.scrollLeft = 220;
  });
  await button(page, '预览').click();
  await at(doc(page), 800);
  await button(page, '源码').click();
  await at(doc(page), 1400);
  await expect
    .poll(() => page.locator('.preview-code pre').evaluate((node) => node.scrollLeft))
    .toBe(220);
  await restart(page);
  await expect(button(page, '预览')).toBeVisible();
  await at(doc(page), 1400);
  await button(page, '预览').click();
  await at(doc(page), 800);
});

test('delayed automatic refresh placeholder preserves reading position without extra reads', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 1100);
  const before = await counts(page);
  await change(page, '长阅读.txt', { delayMs: 800 });
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await textReady(page);
  await at(doc(page), 1100);
  expect(await counts(page)).toMatchObject({
    reads: before.reads + 1,
    activeWatches: 1,
    activeChangedListeners: 1,
  });
});

test('shortened file clamps once and accepts its reachable end after rebuilding', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 2000);
  await change(page, '长阅读.txt', { short: true });
  await expect(doc(page)).not.toContainText('Reading paragraph 360');
  await expect(doc(page)).toContainText('Reading paragraph 35');
  const end = await doc(page).evaluate((node) => node.scrollHeight - node.clientHeight);
  expect(end).toBeLessThan(2000);
  await at(doc(page), end);
  await change(page, '长阅读.txt', {});
  await textReady(page);
  await at(doc(page), end);
  expect((await counts(page)).reads).toBe(3);
});

test('deletion and failed refresh retain position for reconstruction and explicit retry', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 1200);
  await change(page, '长阅读.txt', { missing: true });
  await expect(page.getByRole('alert')).toContainText('文件已删除');
  await expect(doc(page)).toContainText('暂时无法预览此文件');
  await change(page, '长阅读.txt', {});
  await textReady(page);
  await at(doc(page), 1200);
  await change(page, '长阅读.txt', { fail: true });
  await expect(page.getByRole('alert')).toContainText('模拟读取失败');
  await page.evaluate(() => (window as any).fixturePreview.configure('长阅读.txt', {}));
  await button(page, '刷新预览').click();
  await textReady(page);
  await at(doc(page), 1200);
  expect((await counts(page)).reads).toBe(5);
});

test('user wheel input while restore is pending preempts automatic positioning', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 1500);
  await change(page, '长阅读.txt', { delayMs: 1000 });
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await doc(page).hover();
  await page.mouse.wheel(0, -200);
  await textReady(page);
  await at(doc(page), 0);
  await button(page, '图片状态').click();
  await page.getByRole('tab', { name: '长阅读.txt', exact: true }).click();
  await textReady(page);
  await at(doc(page), 0);
});

test('user wheel input during delayed PDF refresh preempts the recreated PDF restore', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  const pages = page.locator('.preview-pdf-pages');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('PDF 页码').fill('3');
  await button(page, '放大 PDF').click();
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await scroll(pages, 350, 50);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = Object.entries(localStorage).find(([key]) => key.endsWith(':fixture'))?.[1];
        if (!value) return -1;
        const saved = JSON.parse(value);
        const tab = saved.boards.session?.tabs.find((tab: any) =>
          tab.target.endsWith('多页报告.pdf'),
        );
        return saved.reading?.sessions.session?.[tab?.id]?.top ?? -1;
      }),
    )
    .toBe(350);
  await change(page, '多页报告.pdf', { delayMs: 1000 });
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await doc(page).hover();
  await page.mouse.wheel(0, -200);
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await at(pages, 0, 0);
  await button(page, '图片状态').click();
  await page.getByRole('tab', { name: '多页报告.pdf', exact: true }).click();
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await at(pages, 0, 0);
});

test('same tab identity in another session and workspace keeps independent reading state', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 700);
  await restart(page);
  await at(doc(page), 700);
  const clonedScope = await page.evaluate(() => {
    const [key, value] = Object.entries(localStorage).find(([key]) => key.endsWith(':fixture'))!;
    const layout = JSON.parse(value);
    layout.boards['other-session'] = structuredClone(layout.boards.session);
    const other = { width: layout.width, boards: { session: layout.boards.session } };
    return { key, value: JSON.stringify(layout), other: JSON.stringify(other) };
  });
  await page.addInitScript(({ key, value, other }) => {
    localStorage.setItem(key, value);
    localStorage.setItem(key.replace(/:fixture$/, ':other'), other);
  }, clonedScope);
  await restart(page);
  await button(page, '切换预览会话').click();
  await textReady(page);
  await at(doc(page), 0);
  await scroll(doc(page), 1300);
  await button(page, '切换预览会话').click();
  await textReady(page);
  await at(doc(page), 700);
  await button(page, '切换预览工作区').click();
  await textReady(page);
  await at(doc(page), 0);
  await scroll(doc(page), 1900);
  await button(page, '切换预览工作区').click();
  await textReady(page);
  await at(doc(page), 700);
});

test('late read from a released workspace cannot replace the new workspace reading position', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 700);
  await change(page, '长阅读.txt', { delayMs: 1000, short: true });
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await button(page, '切换预览工作区').click();
  await page.evaluate(() => (window as any).fixturePreview.configure('长阅读.txt', {}));
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 1800);
  await expect.poll(async () => (await counts(page)).completedReads).toBe(3);
  await textReady(page);
  await at(doc(page), 1800);
  await button(page, '切换预览工作区').click();
  await textReady(page);
  await at(doc(page), 700);
});

test('closing a document removes its reading position before opening a new tab', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长文本').click();
  await textReady(page);
  await scroll(doc(page), 1100);
  await button(page, '关闭预览 长阅读.txt').click();
  await button(page, '长文本').click();
  await textReady(page);
  await at(doc(page), 0);
  expect(await counts(page)).toMatchObject({ activeWatches: 1, activeChangedListeners: 1 });
});

test('twenty UI lifecycle cycles release watches, listeners and reading entries', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(fixture);
  const textDocument = page
    .getByRole('tabpanel', { name: '长阅读.txt', exact: true })
    .locator('.preview-document');
  for (let cycle = 0; cycle < 20; cycle++) {
    await button(page, '长文本').click();
    await expect(textDocument).toContainText('Reading paragraph 360');
    await scroll(textDocument, 700);
    await button(page, '长代码').click();
    await expect(page.locator('.preview-code')).toContainText('readingRow360');
    await page.getByRole('tab', { name: '长阅读.txt', exact: true }).click();
    await at(textDocument, 700);
    await button(page, '分栏预览').click();
    await expect(page.locator('.preview-pane')).toHaveCount(2);
    await at(textDocument, 700);
    expect(await counts(page)).toMatchObject({
      activeWatches: 2,
      activeChangedListeners: 2,
      activeStateListeners: 2,
    });
    const textPane = page.locator('.preview-pane').filter({ has: textDocument });
    await textPane.getByRole('button', { name: '移动到下一窗格', exact: true }).click();
    await expect(page.locator('.preview-pane')).toHaveCount(1);
    await at(textDocument, 700);
    await button(page, '浮动预览').click();
    await expect(page.locator('.preview-pane-floating')).toHaveCount(1);
    await at(textDocument, 700);
    expect(await counts(page)).toMatchObject({
      activeWatches: 2,
      activeChangedListeners: 2,
      activeStateListeners: 2,
    });
    await button(page, '停靠预览').click();
    await expect(page.locator('.preview-pane-floating')).toHaveCount(0);
    await at(textDocument, 700);
    expect(await counts(page)).toMatchObject({
      activeWatches: 1,
      activeChangedListeners: 1,
      activeStateListeners: 1,
    });
    const activeReading = await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      const value = Object.entries(localStorage).find(([key]) => key.endsWith(':fixture'))![1];
      const saved = JSON.parse(value);
      return {
        entries: Object.keys(saved.reading?.sessions.session ?? {}).length,
        bytes: new TextEncoder().encode(JSON.stringify(saved.reading ?? {})).length,
      };
    });
    expect(activeReading.entries).toBe(2);
    expect(activeReading.bytes).toBeLessThan(2048);
    await button(page, '关闭预览 长代码.ts').click();
    await button(page, '关闭预览 长阅读.txt').click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect.poll(async () => (await counts(page)).activeWatches).toBe(0);
    const current = await counts(page);
    expect(current).toMatchObject({
      activeChangedListeners: 0,
      activeStateListeners: 0,
      activeTokens: [],
    });
    expect(current.listenerAdds - current.listenerRemoves).toBe(0);
    expect(current.watchCalls - current.unwatchCalls).toBe(0);
    expect(current.reads).toBeLessThanOrEqual((cycle + 1) * 10);
    const readingEntries = await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      const value = Object.entries(localStorage).find(([key]) => key.endsWith(':fixture'))![1];
      const saved = JSON.parse(value);
      return Object.values(saved.reading?.sessions ?? {}).flatMap((tabs: any) => Object.keys(tabs))
        .length;
    });
    expect(readingEntries).toBe(0);
  }
});

for (const action of ['close', 'workspace'] as const) {
  test(`late token-bearing PDF read after ${action} releases each resource once without resurrecting reading state`, async ({
    page,
  }) => {
    await page.goto(fixture);
    await button(page, '多页 PDF').click();
    const pages = page.locator('.preview-pdf-pages');
    await expect(pages).toHaveAttribute('aria-busy', 'false');
    await scroll(pages, 100);
    await change(page, '多页报告.pdf', { delayMs: 800 });
    await expect(page.getByRole('status')).toContainText('正在读取文件');
    if (action === 'close') {
      await button(page, '关闭预览 多页报告.pdf').click();
      await expect(page.getByRole('tab')).toHaveCount(0);
    } else {
      await button(page, '切换预览工作区').click();
      await button(page, '长文本').click();
      await textReady(page);
      await scroll(doc(page), 700);
    }
    await expect
      .poll(async () => (await counts(page)).completedReads)
      .toBe(action === 'close' ? 2 : 3);
    await expect.poll(async () => (await counts(page)).activeTokens).toEqual([]);
    const resources = await counts(page);
    expect(resources.issuedTokens).toHaveLength(2);
    expect(Object.values(resources.releasedTokens)).toEqual([1, 1]);
    expect(resources.releaseFiles).toBe(2);
    const saved = await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return Object.fromEntries(
        Object.entries(localStorage)
          .filter(([key]) => key.startsWith('cc-preview-v1:'))
          .map(([key, value]) => [key, JSON.parse(value)]),
      );
    });
    const original = Object.entries(saved).find(([key]) => key.endsWith(':fixture'))![1] as any;
    if (action === 'close') {
      expect(original.boards.session.tabs).toHaveLength(0);
      expect(Object.keys(original.reading?.sessions.session ?? {})).toHaveLength(0);
      expect(resources).toMatchObject({
        activeWatches: 0,
        activeChangedListeners: 0,
        activeStateListeners: 0,
      });
    } else {
      await at(doc(page), 700);
      const other = Object.entries(saved).find(([key]) => key.endsWith(':other'))![1] as any;
      expect(Object.values(other.reading.sessions.session)).toEqual([
        { kind: 'text', top: 700, left: 0 },
      ]);
      expect(Object.values(original.reading.sessions.session)).toEqual([
        { kind: 'pdf', page: 1, zoom: 1, top: 100, left: 0 },
      ]);
      expect(resources).toMatchObject({
        activeWatches: 1,
        activeChangedListeners: 1,
        activeStateListeners: 1,
      });
    }
  });
}

test('same Markdown tab and pane ids across sessions retain independent selected modes', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长 Markdown').click();
  await expect(page.locator('.preview-markdown')).toContainText('Section 100');
  await button(page, '源码').click();
  await scroll(doc(page), 1400);
  await cloneTabToOtherSession(page);
  await expect(button(page, '预览')).toBeVisible();
  await at(doc(page), 1400);
  await button(page, '切换预览会话').click();
  await expect(page.locator('.preview-markdown')).toContainText('Section 100');
  await expect(button(page, '源码')).toBeVisible();
  await at(doc(page), 0);
  await scroll(doc(page), 800);
  await button(page, '切换预览会话').click();
  await expect(page.locator('.preview-code')).toContainText('section100');
  await expect(button(page, '预览')).toBeVisible();
  await at(doc(page), 1400);
});

for (const [name, query] of [
  ['main and terminal', '?terminal'],
  ['two connections', '?connection=other'],
]) {
  test(`same file reading positions are isolated between ${name}`, async ({ page }) => {
    await page.goto(fixture);
    await button(page, '长文本').click();
    await textReady(page);
    await scroll(doc(page), 700);
    await page.goto(fixture + query);
    await button(page, '长文本').click();
    await textReady(page);
    await at(doc(page), 0);
    await scroll(doc(page), 1300);
    await page.goto(fixture);
    await button(page, '展开空栏').click();
    await textReady(page);
    await at(doc(page), 700);
    await page.goto(fixture + query);
    await button(page, '展开空栏').click();
    await textReady(page);
    await at(doc(page), 1300);
  });
}

test('same PDF tab and pane ids across sessions retain independent page and zoom', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  const pages = page.locator('.preview-pdf-pages');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('PDF 页码').fill('3');
  await button(page, '放大 PDF').click();
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await scroll(pages, 350, 50);
  await cloneTabToOtherSession(page);
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await button(page, '切换预览会话').click();
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('1');
  await expect(page.locator('.preview-pdf')).toContainText('100%');
  await at(pages, 0, 0);
  await page.getByLabel('PDF 页码').fill('2');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await button(page, '切换预览会话').click();
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await at(pages, 350, 50);
});

test('failed PDF current-page rendering preserves page, zoom and offset until a valid refresh', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  const pages = page.locator('.preview-pdf-pages');
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('PDF 页码').fill('3');
  await button(page, '放大 PDF').click();
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await scroll(pages, 350, 50);
  await change(page, '多页报告.pdf', { badPage: 3 });
  await expect(page.getByRole('alert')).toContainText('PDF 页面无法显示');
  const saved = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    const value = Object.entries(localStorage).find(([key]) => key.endsWith(':fixture'))![1];
    const layout = JSON.parse(value);
    const tab = layout.boards.session.tabs.find((tab: any) => tab.target.endsWith('多页报告.pdf'));
    return layout.reading.sessions.session[tab.id];
  });
  expect(saved).toMatchObject({ kind: 'pdf', page: 3, zoom: 1.25, top: 350, left: 50 });
  await change(page, '多页报告.pdf', {});
  await expect(pages).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await at(pages, 350, 50);
  expect((await counts(page)).reads).toBe(3);
});

test('multi-page PDF restores page three at 125 percent and scroll after float/dock and reload', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '图片状态').click();
  await button(page, '多页 PDF').click();
  const pages = page.locator('.preview-pdf-pages');
  const ready = () => expect(pages).toHaveAttribute('aria-busy', 'false');
  await ready();
  await page.getByLabel('PDF 页码').fill('3');
  await button(page, '放大 PDF').click();
  await ready();
  await expect(page.locator('.preview-pdf canvas')).toHaveAttribute('aria-label', 'PDF 第 3 页');
  await scroll(pages, 350, 50);
  await button(page, '分栏预览').click();
  await expect(page.locator('.preview-pane')).toHaveCount(2);
  await ready();
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await page
    .locator('.preview-pane')
    .filter({ has: page.locator('.preview-pdf') })
    .getByRole('button', { name: '浮动预览', exact: true })
    .click();
  await ready();
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await button(page, '停靠预览').click();
  await ready();
  await scroll(pages, 350, 50);
  await restart(page);
  await ready();
  await expect(page.getByLabel('PDF 页码')).toHaveValue('3');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await at(pages, 350, 50);
  await change(page, '多页报告.pdf', { pages: 2, delayMs: 500 });
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await ready();
  await expect(page.getByLabel('PDF 页码')).toHaveValue('2');
  await expect(page.locator('.preview-pdf')).toContainText('125%');
  await at(pages, 350, 50);
  await button(page, '上一页').click();
  await ready();
  await at(pages, 0, 0);
  expect((await counts(page)).reads).toBe(2);
});
