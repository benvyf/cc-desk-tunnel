import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const fixture = '/test/fixtures/preview-sidebar.html';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const code = (page: Page) => page.locator('.preview-code pre code');
const doc = (page: Page) => page.locator('.preview-document');
const highlight = (page: Page, line: number) =>
  page.locator(`.preview-code-highlight[data-line="${line}"]`);
const counts = (page: Page) => page.evaluate(() => (window as any).fixturePreview.counts());
const contrast = (foreground: string, background: string) => {
  const luminance = (color: string) => {
    const values = color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

async function openCode(page: Page) {
  await page.goto(fixture);
  await button(page, '长代码').click();
  await expect(code(page)).toContainText('readingRow360');
}

async function scroll(element: Locator, top: number, left?: number) {
  await element.dispatchEvent('wheel', { deltaY: 1 });
  await element.evaluate(
    (node, position) => {
      node.scrollTop = position.top;
      if (position.left !== undefined) node.scrollLeft = position.left;
    },
    { top, left },
  );
  await expect.poll(() => element.evaluate((node) => node.scrollTop)).toBe(top);
  if (left !== undefined)
    await expect.poll(() => element.evaluate((node) => node.scrollLeft)).toBe(left);
}

async function targetVisible(page: Page, line: number) {
  const target = highlight(page, line);
  await expect(target).toBeVisible();
  await expect
    .poll(async () => {
      const [area, row] = await Promise.all([doc(page).boundingBox(), target.boundingBox()]);
      return !!area && !!row && row.y >= area.y && row.y + row.height <= area.y + area.height;
    })
    .toBe(true);
}

test('code shows accessible hidden line numbers and starts without wrapping', async ({ page }) => {
  await openCode(page);
  const first = page.locator('.preview-line-number[data-line="1"]');
  await expect(first).toHaveText('1');
  await expect(first).toHaveAttribute('aria-hidden', 'true');
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() =>
      page.locator('.preview-code pre').evaluate((node) => node.scrollWidth - node.clientWidth),
    )
    .toBeGreaterThan(400);
});

test('syntax colors preserve the original text node, copying and line positioning', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(fixture);
  const text = 'const alpha = "<img src=x onerror=alert(1)>";\n// 第二行\nconst beta = 2;\n';
  await page.evaluate(
    (codeText) => (window as any).fixturePreview.configure('长代码.ts', { codeText }),
    text,
  );
  await button(page, '长代码').click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('cc-syntax-keyword')?.size ?? 0))
    .toBeGreaterThan(0);
  await expect(code(page)).toHaveText(text);
  expect(await code(page).evaluate((node) => node.childNodes.length)).toBe(1);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const colors = await code(page).evaluate((node) => ({
      ink: getComputedStyle(node, '::highlight(cc-syntax-keyword)').color,
      background: getComputedStyle(node.closest('pre')!).backgroundColor,
    }));
    expect(contrast(colors.ink, colors.background)).toBeGreaterThanOrEqual(4.5);
  }
  await expect(code(page).locator('img')).toHaveCount(0);
  await button(page, '复制代码').click();
  expect(await page.evaluate(() => (window as any).fixtureCopied)).toEqual([text]);
  await page.getByLabel('跳转到行').fill('3');
  await page.getByLabel('跳转到行').press('Enter');
  await targetVisible(page, 3);
});

test('Windows CRLF sources retain syntax colors and exact clipboard bytes', async ({ page }) => {
  await page.goto(fixture);
  const text = 'const alpha = 1;\r\n// 中文\r\nconst beta = "value";\r\n';
  await page.evaluate(
    (codeText) => (window as any).fixturePreview.configure('长代码.ts', { codeText }),
    text,
  );
  await button(page, '长代码').click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('cc-syntax-keyword')?.size ?? 0))
    .toBeGreaterThan(0);
  expect(await code(page).textContent()).toBe(text);
  await button(page, '复制代码').click();
  expect(await page.evaluate(() => (window as any).fixtureCopied)).toEqual([text]);
  await page.getByLabel('跳转到行').fill('3');
  await page.getByLabel('跳转到行').press('Enter');
  await targetVisible(page, 3);
});

test('syntax ranges are owned by each pane and released when its source closes', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.evaluate(() =>
    (window as any).fixturePreview.configure('长代码.ts', {
      codeText: 'function greet() { return 1; }',
    }),
  );
  await button(page, '长代码').click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('cc-syntax-title')?.size ?? 0))
    .toBeGreaterThan(0);
  await button(page, '定位 HTML 文件源码').click();
  await button(page, '分栏预览').click();
  await expect(page.locator('.preview-code pre code')).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('cc-syntax-title')?.size ?? 0))
    .toBeGreaterThanOrEqual(3);
  await button(page, '关闭预览 长代码.ts').click();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('cc-syntax-keyword')?.size ?? 0))
    .toBe(0);
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('cc-syntax-title')?.size ?? 0))
    .toBeGreaterThan(0);
  await button(page, '关闭预览 index.html').click();
  await expect
    .poll(() =>
      page.evaluate(
        () => [...CSS.highlights.keys()].filter((name) => name.startsWith('cc-syntax-')).length,
      ),
    )
    .toBe(0);
});

test('copy preserves LF and trailing newline, and mouse selection excludes the gutter', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(fixture);
  const source = 'const alpha = 1;\nconst beta = 2;\n';
  await page.evaluate(
    (codeText) => (window as any).fixturePreview.configure('长代码.ts', { codeText }),
    source,
  );
  await button(page, '长代码').click();
  await expect(code(page)).toHaveText(source);
  await button(page, '复制代码').click();
  expect(await page.evaluate(() => (window as any).fixtureCopied)).toEqual([source]);
  const geometry = await code(page).evaluate((element) => {
    const node = element.firstChild!;
    const range = document.createRange();
    const firstEnd = element.textContent!.indexOf('\n');
    const secondEnd = element.textContent!.indexOf('\n', firstEnd + 1);
    range.setStart(node, 0);
    range.setEnd(node, firstEnd);
    const first = range.getBoundingClientRect();
    range.setStart(node, firstEnd + 1);
    range.setEnd(node, secondEnd);
    const second = range.getBoundingClientRect();
    return {
      start: { x: first.left - 25, y: first.top + first.height / 2 },
      end: { x: second.right + 2, y: second.top + second.height / 2 },
    };
  });
  await page.mouse.move(geometry.start.x, geometry.start.y);
  await page.mouse.down();
  await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 12 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()!.toString());
  expect(selected).toBe('const alpha = 1;\nconst beta = 2;');
  await page.keyboard.press('Control+c');
  // Windows' native clipboard stores CRLF even when the browser selection contains LF.
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n')),
    )
    .toBe(selected);
  await expect(page.locator('.quote-selection-toolbar')).toHaveCount(0);
});

test('wrap preference belongs to its file tab and survives moving and reloading', async ({
  page,
}) => {
  await openCode(page);
  await button(page, '自动换行').click();
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page.locator('.preview-code pre').evaluate((node) => node.scrollWidth - node.clientWidth),
    )
    .toBeLessThanOrEqual(1);
  await button(page, '长文本').click();
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: '长代码.ts', exact: true }).click();
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'true');
  await button(page, '浮动预览').click();
  await expect(
    page
      .getByRole('tabpanel', { name: '长代码.ts', exact: true })
      .getByRole('button', { name: '自动换行', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await button(page, '停靠预览').click();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await button(page, '展开空栏').click();
  await expect(code(page)).toContainText('readingRow360');
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tab', { name: '长阅读.txt', exact: true }).click();
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'false');
});

test('unwrapped code preserves its horizontal reading offset across tab switches and reload', async ({
  page,
}) => {
  await openCode(page);
  const pre = page.locator('.preview-code pre');
  await scroll(doc(page), 900);
  await pre.evaluate((node) => {
    node.scrollLeft = 360;
  });
  await expect.poll(() => pre.evaluate((node) => node.scrollLeft)).toBe(360);
  await button(page, '图片状态').click();
  await page.getByRole('tab', { name: '长代码.ts', exact: true }).click();
  await expect.poll(() => doc(page).evaluate((node) => node.scrollTop)).toBe(900);
  await expect.poll(() => pre.evaluate((node) => node.scrollLeft)).toBe(360);
  await page.reload();
  await button(page, '展开空栏').click();
  await expect.poll(() => doc(page).evaluate((node) => node.scrollTop)).toBe(900);
  await expect.poll(() => pre.evaluate((node) => node.scrollLeft)).toBe(360);
});

test('manual jump highlights a clamped source line without taking input focus or reading again', async ({
  page,
}) => {
  await openCode(page);
  const before = await counts(page);
  const input = page.getByLabel('跳转到行', { exact: true });
  await input.fill('12');
  await input.press('Enter');
  await targetVisible(page, 12);
  await expect(input).toBeFocused();
  await input.fill('999999');
  await button(page, '跳转').click();
  await targetVisible(page, 360);
  await expect(input).toHaveValue('360');
  for (const invalid of ['0', '-1', '1.5', 'not a line', '']) {
    await input.fill(invalid);
    await input.press('Enter');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('status')).toContainText('正整数');
  }
  expect((await counts(page)).reads).toBe(before.reads);
});

test('colon and hash line links navigate repeatedly without rereading or replaying on restore', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await targetVisible(page, 12);
  await scroll(doc(page), 3000);
  await page.getByRole('link', { name: '长代码.ts:12', exact: true }).click();
  await targetVisible(page, 12);
  await page.getByRole('link', { name: '长代码.ts#L20', exact: true }).click();
  await targetVisible(page, 20);
  await page.locator('.preview-code pre').evaluate((node) => {
    node.scrollLeft = 300;
  });
  await page.getByRole('link', { name: '长代码.ts:360:10', exact: true }).click();
  await targetVisible(page, 360);
  expect(
    await code(page).evaluate((element) => {
      const offset = element.textContent!.lastIndexOf('\n') + 10;
      const range = document.createRange();
      range.setStart(element.firstChild!, offset);
      range.setEnd(element.firstChild!, offset + 1);
      const character = range.getBoundingClientRect();
      const viewport = element.closest('pre')!.getBoundingClientRect();
      return character.left >= viewport.left && character.right <= viewport.right;
    }),
  ).toBe(true);
  expect((await counts(page)).reads).toBe(1);
  await scroll(doc(page), 1700);
  await button(page, '浮动预览').click();
  await expect.poll(() => doc(page).evaluate((node) => node.scrollTop)).toBe(1700);
  await button(page, '停靠预览').click();
  await page.reload();
  await button(page, '展开空栏').click();
  await expect.poll(() => doc(page).evaluate((node) => node.scrollTop)).toBe(1700);
  await expect(page.locator('.preview-code-highlight')).toHaveCount(0);
});

test('line navigation switches Markdown to source and does not navigate its rendered heading', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长 Markdown').click();
  await expect(page.locator('.preview-markdown')).toContainText('Section 100');
  await button(page, '定位 Markdown 第300行').click();
  await expect(page.locator('.preview-markdown')).toHaveCount(0);
  await expect(code(page)).toContainText('# Reading handbook');
  await targetVisible(page, 300);
  await expect(button(page, '预览')).toBeVisible();
  expect((await counts(page)).reads).toBe(1);
});

test('HTML source navigation and restored aliases never activate a native page implicitly', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '定位 HTML 源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  await expect(page.locator('.preview-native')).toHaveCount(0);
  expect((await counts(page)).nativeShows).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await button(page, '展开空栏').click();
  await expect(page.locator('.preview-native')).toHaveCount(0);
  expect((await counts(page)).nativeShows).toBe(0);
  await button(page, '定位 HTML 源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  expect((await counts(page)).nativeShows).toBe(0);
  const preview = button(page, '预览');
  if (await preview.count()) await preview.click();
  await expect(button(page, '加载此预览')).toBeVisible();
  expect((await counts(page)).nativeShows).toBe(0);
});

test('two panes keep independent wrap controls and source selection', async ({ page }) => {
  await openCode(page);
  await button(page, '自动换行').click();
  await button(page, '长文本').click();
  await button(page, '分栏预览').click();
  const codePane = page
    .locator('.preview-pane')
    .filter({ has: page.getByRole('tab', { name: '长代码.ts', exact: true }) });
  const textPane = page
    .locator('.preview-pane')
    .filter({ has: page.getByRole('tab', { name: '长阅读.txt', exact: true }) });
  await expect(codePane.getByRole('button', { name: '自动换行', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(textPane.getByRole('button', { name: '自动换行', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await textPane.getByRole('button', { name: '自动换行', exact: true }).click();
  await codePane.getByRole('button', { name: '自动换行', exact: true }).click();
  await expect(codePane.getByRole('button', { name: '自动换行', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(textPane.getByRole('button', { name: '自动换行', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('source navigation arriving during a normal HTML read never starts its native page', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.evaluate(() =>
    (window as any).fixturePreview.configure('alias.txt', { delayMs: 800 }),
  );
  await button(page, '普通 HTML 别名').click();
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await button(page, '定位 HTML 源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  await targetVisible(page, 1);
  expect((await counts(page)).nativeShows).toBe(0);
  expect((await counts(page)).reads).toBe(1);
});

test('a restored HTML extension opens source on a line request and still confirms page execution', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '定位 HTML 文件源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  await page.reload();
  await button(page, '展开空栏').click();
  await expect(button(page, '加载此预览')).toBeVisible();
  expect((await counts(page)).nativeShows).toBe(0);
  await button(page, '定位 HTML 文件源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  await targetVisible(page, 1);
  // An unrelated application render must not put the still read-only source behind the gate again.
  await page.getByLabel('测试输入', { exact: true }).fill('keep source visible');
  await expect(code(page)).toBeVisible();
  expect((await counts(page)).nativeShows).toBe(0);
  await button(page, '预览').click();
  await expect(button(page, '加载此预览')).toBeVisible();
  expect((await counts(page)).nativeShows).toBe(0);
  await button(page, '加载此预览').click();
  await expect.poll(async () => (await counts(page)).nativeShows).toBe(1);
});

test('source intent survives a watched alias changing from Markdown to HTML', async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() =>
    (window as any).fixturePreview.configure('alias.txt', { aliasMarkdown: true }),
  );
  await button(page, '普通 HTML 别名').click();
  await expect(page.locator('.preview-markdown')).toContainText('Former Markdown alias');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = Object.entries(localStorage).find(([key]) =>
          key.startsWith('cc-preview-v1:'),
        )?.[1];
        return (
          raw &&
          Object.values(JSON.parse(raw).reading?.sessions?.session ?? {}).some(
            (value: any) => value.kind === 'markdown',
          )
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    (window as any).fixturePreview.configure('alias.txt', { delayMs: 800 });
    (window as any).fixturePreview.emit('alias.txt');
  });
  await expect(page.getByRole('status')).toContainText('正在读取文件');
  await button(page, '定位 HTML 源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  await targetVisible(page, 1);
  await page
    .getByLabel('测试输入', { exact: true })
    .fill('keep explicit source after the resolved kind changes');
  await expect(code(page)).toBeVisible();
  expect((await counts(page)).nativeShows).toBe(0);
});

test('HTML source remains read-only across tab switches and float remounts until preview is chosen', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '定位 HTML 源码').click();
  await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
  await targetVisible(page, 1);
  await button(page, '长文本').click();
  await page.getByRole('tab', { name: 'alias.txt', exact: true }).click();
  const alias = page
    .locator('.preview-pane')
    .filter({ has: page.getByRole('tab', { name: 'alias.txt', exact: true }) });
  await expect(alias.locator('.preview-code pre code')).toHaveText('<h1>HTML alias</h1>');
  expect((await counts(page)).nativeShows).toBe(0);
  await alias.getByRole('button', { name: '浮动预览', exact: true }).click();
  await expect(page.locator('.preview-pane-floating .preview-code pre code')).toHaveText(
    '<h1>HTML alias</h1>',
  );
  expect((await counts(page)).nativeShows).toBe(0);
  await button(page, '停靠预览').click();
  await expect(alias.locator('.preview-code pre code')).toHaveText('<h1>HTML alias</h1>');
  await alias.getByRole('button', { name: '预览', exact: true }).click();
  await expect.poll(async () => (await counts(page)).nativeShows).toBeGreaterThan(0);
  await alias.getByRole('button', { name: '源码', exact: true }).click();
  await button(page, '长文本').click();
  await page.getByRole('tab', { name: 'alias.txt', exact: true }).click();
  await expect(alias.locator('.preview-code pre code')).toBeVisible();
  await button(page, '关闭预览 alias.txt').click();
  await button(page, '普通 HTML 别名').click();
  await expect(alias.locator('.preview-native')).toBeVisible();
});

for (const htmlSource of [false, true]) {
  test(`Markdown mode stays independent from a former HTML ${htmlSource ? 'source' : 'page'} choice`, async ({
    page,
  }) => {
    await page.goto(fixture);
    await button(page, '定位 HTML 源码').click();
    await expect(code(page)).toHaveText('<h1>HTML alias</h1>');
    await targetVisible(page, 1);
    if (!htmlSource) {
      await button(page, '预览').click();
      await expect(page.locator('.preview-native')).toBeVisible();
    }
    await page.evaluate(() => {
      (window as any).fixturePreview.configure('alias.txt', { aliasMarkdown: true });
      (window as any).fixturePreview.emit('alias.txt');
    });
    if (htmlSource) {
      await expect(code(page)).toHaveText('# Former Markdown alias');
      await button(page, '预览').click();
    } else {
      await expect(page.locator('.preview-markdown')).toContainText('Former Markdown alias');
      await button(page, '源码').click();
    }
    await expect
      .poll(() =>
        page.evaluate((source) => {
          const raw = Object.entries(localStorage).find(([key]) =>
            key.startsWith('cc-preview-v1:'),
          )?.[1];
          return (
            raw &&
            Object.values(JSON.parse(raw).reading?.sessions?.session ?? {}).some(
              (value: any) => value.kind === 'markdown' && value.source === source,
            )
          );
        }, !htmlSource),
      )
      .toBe(true);
    await button(page, '长文本').click();
    await page.getByRole('tab', { name: 'alias.txt', exact: true }).click();
    if (htmlSource)
      await expect(page.locator('.preview-markdown')).toContainText('Former Markdown alias');
    else await expect(code(page)).toHaveText('# Former Markdown alias');
  });
}

test('large code keeps DOM and unrelated typing work bounded', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(fixture);
  await page.evaluate(() =>
    (window as any).fixturePreview.configure('长代码.ts', {
      codeText: Array.from(
        { length: 10_500 },
        (_, index) => `export const readingRow${index + 1} = "${'wide code '.repeat(12)}";`,
      ).join('\n'),
    }),
  );
  const started = Date.now();
  await button(page, '长代码').click();
  await expect(code(page)).toContainText('readingRow10500');
  const openMs = Date.now() - started;
  console.log('large-code-open', JSON.stringify({ openMs }));
  const before = await counts(page);
  const stableCode = await code(page).elementHandle();
  await page
    .getByLabel('测试输入', { exact: true })
    .pressSequentially('typing while reviewing generated code', { delay: 4 });
  const after = await counts(page);
  expect(after.renders).toBeGreaterThan(before.renders);
  for (const key of ['reads', 'watchCalls', 'listenerAdds', 'listenerRemoves', 'nativeShows'])
    expect(after[key]).toBe(before[key]);
  expect(await stableCode!.evaluate((node) => node.isConnected)).toBe(true);
  expect(await code(page).evaluate((node) => node.childNodes.length)).toBe(1);
  if (process.env.CC_PREVIEW_CODE_PROFILE)
    await page.evaluate(() => {
      const metrics = { calls: 0, ms: 0, mutations: 0, changes: {} as Record<string, number> };
      (window as any).codeRangeMetrics = metrics;
      new MutationObserver((records) => {
        metrics.mutations += records.length;
        for (const record of records) {
          const name = record.target instanceof Element ? record.target.className : '#text';
          metrics.changes[String(name)] = (metrics.changes[String(name)] ?? 0) + 1;
        }
      }).observe(document.querySelector('.preview-code')!, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      for (const method of ['getClientRects', 'getBoundingClientRect'] as const) {
        const original = Range.prototype[method] as (this: Range) => DOMRect | DOMRectList;
        (Range.prototype as any)[method] = function (this: Range) {
          const started = performance.now();
          const value = original.call(this);
          metrics.calls++;
          metrics.ms += performance.now() - started;
          return value;
        };
      }
    });
  const input = page.getByLabel('跳转到行', { exact: true });
  await input.fill('10000');
  const profiler = process.env.CC_PREVIEW_CODE_PROFILE
    ? await page.context().newCDPSession(page)
    : null;
  let initialMetrics: any;
  if (profiler) {
    await profiler.send('Performance.enable');
    initialMetrics = await profiler.send('Performance.getMetrics');
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
  }
  await input.press('Enter');
  const jump = await page.evaluate(async () => {
    const frameStarted = performance.now();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const area = document.querySelector('.preview-document')!;
    const mark = document.querySelector('.preview-code-highlight')!;
    return {
      area: area.getBoundingClientRect().toJSON(),
      mark: mark.getBoundingClientRect().toJSON(),
      top: area.scrollTop,
      height: area.scrollHeight,
      frameMs: performance.now() - frameStarted,
      ranges: (window as any).codeRangeMetrics,
    };
  });
  console.log('large-code-jump', jump);
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    const finalMetrics = await profiler.send('Performance.getMetrics');
    await mkdir('.local/preview-code-pdf', { recursive: true });
    await writeFile('.local/preview-code-pdf/code-cpu.cpuprofile', JSON.stringify(profile));
    const durations = new Map<number, number>();
    for (let index = 0; index < (profile.samples?.length ?? 0); index++)
      durations.set(
        profile.samples![index],
        (durations.get(profile.samples![index]) ?? 0) + (profile.timeDeltas?.[index] ?? 0),
      );
    const hottest = profile.nodes
      .map((node) => ({
        name: node.callFrame.functionName,
        url: node.callFrame.url,
        line: node.callFrame.lineNumber + 1,
        ms: (durations.get(node.id) ?? 0) / 1000,
      }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 16);
    console.log('code-cpu-hottest', JSON.stringify(hottest));
    const metrics = finalMetrics.metrics
      .filter((entry) =>
        [
          'ScriptDuration',
          'LayoutDuration',
          'RecalcStyleDuration',
          'TaskDuration',
          'Nodes',
          'JSHeapUsedSize',
        ].includes(entry.name),
      )
      .map((entry) => ({
        name: entry.name,
        delta:
          entry.value -
          initialMetrics.metrics.find((initial: any) => initial.name === entry.name)!.value,
      }));
    console.log('code-performance-metrics', JSON.stringify(metrics));
    await profiler.detach();
  }
  expect(jump.frameMs).toBeLessThan(1000);
  await targetVisible(page, 10000);
  expect(await page.locator('.preview-line-number').count()).toBeLessThanOrEqual(256);
  expect(await page.locator('.preview-code *').count()).toBeLessThan(300);
  console.log(
    'large-code',
    JSON.stringify({
      lines: 10_500,
      openMs,
      gutterNodes: await page.locator('.preview-line-number').count(),
      before,
      after,
    }),
  );
  expect(openMs).toBeLessThan(5000);
  const wrapStarted = Date.now();
  await button(page, '自动换行').click();
  await input.fill('9500');
  await input.press('Enter');
  await targetVisible(page, 9500);
  expect(await page.locator('.preview-line-number').count()).toBeLessThanOrEqual(256);
  console.log('large-code-wrapped-jump', JSON.stringify({ elapsedMs: Date.now() - wrapStarted }));
});

test('empty and trailing blank source lines retain valid gutter and jump geometry', async ({
  page,
}) => {
  await page.goto(fixture);
  for (const source of ['alpha\n', '\n\n', '', '\r\n']) {
    await page.evaluate((codeText) => {
      (window as any).fixturePreview.configure('长代码.ts', { codeText });
      (window as any).fixturePreview.emit('长代码.ts');
    }, source);
    if (!(await code(page).count())) await button(page, '长代码').click();
    await expect.poll(() => code(page).textContent()).toBe(source);
    const line = source.split('\n').length;
    await page.getByLabel('跳转到行', { exact: true }).fill(String(line));
    await button(page, '跳转').click();
    await targetVisible(page, line);
    const number = page.locator(`.preview-line-number[data-line="${line}"]`);
    await expect(number).toHaveText(String(line));
    const [mark, gutter] = await Promise.all([
      highlight(page, line).boundingBox(),
      number.boundingBox(),
    ]);
    expect(Math.abs(mark!.y - gutter!.y)).toBeLessThanOrEqual(1);
    await button(page, '复制代码').click();
    expect(await page.evaluate(() => (window as any).fixtureCopied.at(-1))).toBe(source);
  }
});

test('wrapped CR-only text keeps its terminal source line below the previous line', async ({
  page,
}) => {
  await page.goto(fixture);
  const text = 'first\rsecond\r';
  await page.evaluate(
    (codeText) => (window as any).fixturePreview.configure('长代码.ts', { codeText }),
    text,
  );
  await button(page, '长代码').click();
  await expect.poll(() => code(page).textContent()).toBe(text);
  await button(page, '自动换行').click();
  await page.getByLabel('跳转到行', { exact: true }).fill('3');
  await button(page, '跳转').click();
  await targetVisible(page, 3);
  const previous = page.locator('.preview-line-number[data-line="2"]');
  const terminal = page.locator('.preview-line-number[data-line="3"]');
  await expect(terminal).toBeVisible();
  const [before, after, mark] = await Promise.all([
    previous.boundingBox(),
    terminal.boundingBox(),
    highlight(page, 3).boundingBox(),
  ]);
  expect(after!.y - before!.y).toBeGreaterThan(15);
  expect(Math.abs(mark!.y - after!.y)).toBeLessThanOrEqual(1);
  await button(page, '复制代码').click();
  expect(await page.evaluate(() => (window as any).fixtureCopied.at(-1))).toBe(text);
});

test('near 4 MiB source retains fidelity and bounded navigation in both wrap modes', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto(fixture);
  const generated = await page.evaluate(() => {
    const bytes = 4 * 1024 * 1024 - 1;
    const lines = 25_000;
    const characters = bytes - (lines - 1);
    const width = Math.floor(characters / lines);
    const extra = characters % lines;
    const codeText = Array.from({ length: lines }, (_, index) => {
      const prefix = `export const edgeRow${index + 1} = "`;
      const suffix = '";';
      return (
        prefix + 'x'.repeat(width + Number(index < extra) - prefix.length - suffix.length) + suffix
      );
    }).join('\n');
    (window as any).fixturePreview.configure('长代码.ts', { codeText });
    return { bytes: new TextEncoder().encode(codeText).byteLength, lines };
  });
  expect(generated).toEqual({ bytes: 4 * 1024 * 1024 - 1, lines: 25_000 });
  const openStarted = Date.now();
  await button(page, '长代码').click();
  await expect
    .poll(() =>
      code(page).evaluate(
        (node) => node.textContent === (window as any).fixturePreview.source('长代码.ts'),
      ),
    )
    .toBe(true);
  const openMs = Date.now() - openStarted;
  expect(openMs).toBeLessThan(5000);
  expect(await code(page).evaluate((node) => node.childNodes.length)).toBe(1);
  const input = page.getByLabel('跳转到行', { exact: true });
  const timings: number[] = [];
  for (const wrap of [false, true]) {
    if (wrap) await button(page, '自动换行').click();
    const started = Date.now();
    await input.fill(String(generated.lines));
    await input.press('Enter');
    await targetVisible(page, generated.lines);
    timings.push(Date.now() - started);
    expect(await page.locator('.preview-line-number').count()).toBeLessThanOrEqual(256);
    expect(await page.locator('.preview-code *').count()).toBeLessThan(300);
    expect(
      await doc(page).evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return [node.scrollTop, node.scrollHeight, rect.x, rect.y, rect.width, rect.height].every(
          Number.isFinite,
        );
      }),
    ).toBe(true);
  }
  await button(page, '复制代码').click();
  expect(
    await page.evaluate(
      () =>
        (window as any).fixtureCopied.at(-1) === (window as any).fixturePreview.source('长代码.ts'),
    ),
  ).toBe(true);
  expect(await counts(page)).toMatchObject({
    reads: 1,
    watchCalls: 1,
    listenerAdds: 1,
    listenerRemoves: 0,
    nativeShows: 0,
  });
  console.log(
    'near-limit-code',
    JSON.stringify({
      ...generated,
      openMs,
      jumpMs: timings,
      gutterNodes: await page.locator('.preview-line-number').count(),
    }),
  );
});

test('wrapped line gutters align across themes, narrow widths and text sizes', async ({ page }) => {
  test.setTimeout(90_000);
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 1024, 390]) {
      for (const font of [14, 20]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixture);
        await page.evaluate(
          ({ theme, font }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.fontSize = `${font}px`;
            (window as any).fixturePreview.configure('长代码.ts', {
              codeText: `first marker\n${'wrapped source '.repeat(12)}\nlast marker\n`,
            });
          },
          { theme, font },
        );
        await button(page, '长代码').click();
        const wrap = button(page, '自动换行');
        if ((await wrap.getAttribute('aria-pressed')) !== 'true') await wrap.click();
        await wrap.hover();
        await expect
          .poll(() =>
            wrap.evaluate(
              (node) =>
                getComputedStyle(node).color ===
                getComputedStyle(node.closest('.preview-code')!.querySelector('pre')!).color,
            ),
          )
          .toBe(true);
        const palette = await page.locator('.preview-code-header').evaluate((header) => {
          const color = (node: Element) => getComputedStyle(node).color;
          const background = (node: Element) => getComputedStyle(node).backgroundColor;
          const body = header.closest('.preview-code')!.querySelector('pre')!;
          return {
            copy: color(header.querySelector('.copy-label')!),
            jump: color(header.querySelector('.preview-code-jump button')!),
            wrap: color(header.querySelector('[aria-pressed]')!),
            input: color(header.querySelector('input')!),
            source: color(body),
            headerBackground: background(header),
            inputBackground: background(header.querySelector('input')!),
            sourceBackground: background(body),
          };
        });
        expect(palette.jump).toBe(palette.copy);
        expect(palette.wrap).toBe(palette.source);
        expect(palette.input).toBe(palette.source);
        expect(palette.inputBackground).toBe(palette.sourceBackground);
        expect(contrast(palette.jump, palette.headerBackground)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette.input, palette.inputBackground)).toBeGreaterThanOrEqual(4.5);
        const third = page.locator('.preview-line-number[data-line="3"]');
        await expect(third).toBeVisible();
        const sourceTop = await code(page).evaluate((element) => {
          const text = element.textContent!;
          const offset = text.indexOf('\n', text.indexOf('\n') + 1) + 1;
          const range = document.createRange();
          range.setStart(element.firstChild!, offset);
          range.setEnd(element.firstChild!, offset + 1);
          return range.getBoundingClientRect().top;
        });
        const gutter = await third.boundingBox();
        expect(Math.abs(gutter!.y - sourceTop)).toBeLessThanOrEqual(1);
        const header = await page.locator('.preview-code-header').boundingBox();
        expect(header!.x + header!.width).toBeLessThanOrEqual(width + 1);
        await page.screenshot({
          path: `.local/screenshots/preview-code/${theme}-${width}-${font}px.png`,
        });
      }
    }
  }
});

test('an explicit preview-mode choice supersedes a pending source-line navigation', async ({
  page,
}) => {
  await page.goto(fixture);
  await button(page, '长 Markdown').click();
  await expect(page.locator('.preview-markdown')).toContainText('Section 100');
  const committed = await page.evaluate(async () => {
    const find = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === name,
      )!;
    find('定位 Markdown 第300行').click();
    await Promise.resolve();
    const sourceMounted = !!document.querySelector('.preview-code pre');
    find('预览').click();
    return sourceMounted;
  });
  expect(committed).toBe(true);
  await expect(page.locator('.preview-markdown')).toContainText('Section 100');
  await expect(page.locator('.preview-code')).toHaveCount(0);
  await page.getByLabel('测试输入', { exact: true }).fill('retain the latest view choice');
  await expect(page.locator('.preview-markdown')).toBeVisible();
});

test('same-frame line navigation uses the latest wrap geometry only once', async ({ page }) => {
  await openCode(page);
  const before = await counts(page);
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'false');
  const committed = await page.evaluate(async () => {
    const renders = (window as any).fixturePreview.counts().renders;
    const find = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === name,
      )!;
    find('定位代码第12行').click();
    // Let React commit navigation without advancing to its pending animation frame.
    await Promise.resolve();
    const navigationCommitted = (window as any).fixturePreview.counts().renders > renders;
    find('自动换行').click();
    return navigationCommitted;
  });
  expect(committed).toBe(true);
  await expect(button(page, '自动换行')).toHaveAttribute('aria-pressed', 'true');
  await targetVisible(page, 12);
  const sourceTop = await code(page).evaluate((element) => {
    const text = element.textContent!;
    let offset = 0;
    for (let line = 1; line < 12; line++) offset = text.indexOf('\n', offset) + 1;
    const range = document.createRange();
    range.setStart(element.firstChild!, offset);
    range.setEnd(element.firstChild!, offset + 1);
    return range.getClientRects()[0].top;
  });
  const number = page.locator('.preview-line-number[data-line="12"]');
  await expect(number).toBeVisible();
  const [mark, gutter] = await Promise.all([
    highlight(page, 12).boundingBox(),
    number.boundingBox(),
  ]);
  expect(Math.abs(mark!.y - sourceTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(gutter!.y - sourceTop)).toBeLessThanOrEqual(1);
  const nextTop = await doc(page).evaluate((node) => node.scrollTop + 180);
  await scroll(doc(page), nextTop);
  await page.getByLabel('测试输入', { exact: true }).fill('keep reading after navigation');
  await expect.poll(() => doc(page).evaluate((node) => node.scrollTop)).toBe(nextTop);
  expect((await counts(page)).reads).toBe(before.reads);
});
