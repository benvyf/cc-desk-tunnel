import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const fixture = '/test/fixtures/preview-sidebar.html';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const layer = (page: Page) => page.locator('.preview-pdf-page .textLayer');
async function configure(page: Page, options: Record<string, unknown>, refresh = false) {
  await page.evaluate(
    ({ options, refresh }) => {
      (window as any).fixturePreview.configure('多页报告.pdf', options);
      if (refresh) (window as any).fixturePreview.emit('多页报告.pdf');
    },
    { options, refresh },
  );
}
async function ready(page: Page, text = 'Reading report - page 1') {
  await expect(layer(page)).toHaveText(text);
  await expect(page.locator('.preview-pdf-pages')).toHaveAttribute('aria-busy', 'false');
}
async function copySelected(locator: Locator, select = false) {
  return locator.evaluate((node, select) => {
    if (select) {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      const selection = node.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const win = node.ownerDocument.defaultView! as Window & typeof globalThis;
    const data = new win.DataTransfer();
    const event = new win.ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    node.dispatchEvent(event);
    return { text: data.getData('text/plain'), prevented: event.defaultPrevented };
  }, select);
}
async function dragText(page: Page, locator: Locator) {
  const bounds = (await locator.boundingBox())!;
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 15 });
  await page.mouse.up();
}
async function geometry(page: Page) {
  return page.locator('.preview-pdf-page').evaluate((node) => {
    const canvas = node.querySelector('canvas')!;
    const text = node.querySelector('.textLayer')!.getBoundingClientRect();
    const bounds = canvas.getBoundingClientRect();
    const span = node.querySelector('.textLayer span')!.getBoundingClientRect();
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width,
      top = canvas.height,
      right = 0,
      bottom = 0;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (pixels[i] < 120 && pixels[i + 1] < 120 && pixels[i + 2] < 120 && pixels[i + 3] > 120) {
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
        }
      }
    const ink = {
      left: bounds.left + (left * bounds.width) / canvas.width,
      right: bounds.left + (right * bounds.width) / canvas.width,
      top: bounds.top + (top * bounds.height) / canvas.height,
      bottom: bounds.top + (bottom * bounds.height) / canvas.height,
    };
    return {
      canvas: bounds.toJSON(),
      layer: text.toJSON(),
      span: span.toJSON(),
      ink,
      allocation: Math.max(canvas.width, canvas.height),
      styles: {
        font: getComputedStyle(node.querySelector('.textLayer span')!).font,
        letterSpacing: getComputedStyle(node.querySelector('.textLayer span')!).letterSpacing,
        transform: getComputedStyle(node.querySelector('.textLayer span')!).transform,
      },
    };
  });
}
async function aligned(page: Page) {
  const value = await geometry(page);
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs(value.canvas[key] - value.layer[key]), key).toBeLessThan(0.1);
  for (const key of ['left', 'right', 'top', 'bottom'] as const)
    expect(Math.abs(value.span[key] - value.ink[key]), JSON.stringify(value)).toBeLessThan(6);
  expect(value.allocation).toBeLessThanOrEqual(4096);
  return value;
}

test('PDF current page supports actual mouse selection and plain text copy', async ({ page }) => {
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  const text = page
    .locator('.preview-pdf-page .textLayer span')
    .filter({ hasText: 'Reading report' })
    .first();
  await expect(text).toHaveText('Reading report - page 1');
  await dragText(page, text);
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe('Reading report - page 1');
  expect(await copySelected(text)).toEqual({ text: 'Reading report - page 1', prevented: true });
  expect(await page.evaluate(() => (window as any).fixturePreview.counts())).toMatchObject({
    reads: 1,
  });
});

test('Unicode copy uses PDF mapping and normalizes ligatures', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(fixture);
  await configure(page, { pdfText: 'Office ﬁle 中文' });
  await button(page, '多页 PDF').click();
  await ready(page, 'Office ﬁle 中文 - page 1');
  expect(await copySelected(layer(page).locator('span').first(), true)).toEqual({
    text: 'Office file 中文 - page 1',
    prevented: true,
  });
  await dragText(page, layer(page).locator('span').first());
  await page.keyboard.press('ControlOrMeta+C');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Office file 中文 - page 1',
  );
});

test.describe('PDF canvas and text viewport', () => {
  test.use({ deviceScaleFactor: 2 });
  for (const [userUnit, rotation, zoomClicks] of [
    [0.5, 0, 0],
    [2, 90, 1],
    [3, 180, 8],
  ])
    test(`PDF UserUnit ${userUnit} at rotation ${rotation} keeps text aligned`, async ({
      page,
    }) => {
      await page.goto(fixture);
      await configure(page, { pdfUserUnit: userUnit, rotation });
      await button(page, '多页 PDF').click();
      await ready(page);
      await aligned(page);
      for (let i = 0; i < zoomClicks; i++) await button(page, '放大 PDF').click();
      await ready(page);
      const geometry = await aligned(page);
      if (zoomClicks === 8) expect(geometry.allocation).toBe(4096);
      expect((await copySelected(layer(page).locator('span').first(), true)).text).toBe(
        'Reading report - page 1',
      );
    });
  test('zoom, pixel allocation cap, resized pane and font changes keep glyph alignment', async ({
    page,
  }) => {
    await page.goto(fixture);
    await button(page, '多页 PDF').click();
    await ready(page);
    await aligned(page);
    await button(page, '放大 PDF').click();
    await ready(page);
    await aligned(page);
    for (let i = 0; i < 7; i++) await button(page, '放大 PDF').click();
    await ready(page);
    expect((await aligned(page)).allocation).toBe(4096);
    await page.setViewportSize({ width: 1024, height: 900 });
    await ready(page);
    await aligned(page);
    await page.locator('.preview-pdf').evaluate((node) => {
      (node as HTMLElement).style.fontSize = '20px';
    });
    await aligned(page);
    for (let i = 0; i < 10; i++) await button(page, '缩小 PDF').click();
    await ready(page);
    await aligned(page);
    expect(await page.evaluate(() => (window as any).fixturePreview.counts())).toMatchObject({
      reads: 1,
    });
  });
  for (const rotation of [90, 180, 270])
    test(`PDF rotation ${rotation} keeps text over canvas glyphs`, async ({ page }) => {
      await page.goto(fixture);
      await configure(page, { rotation });
      await button(page, '多页 PDF').click();
      await ready(page);
      await aligned(page);
      expect((await copySelected(layer(page).locator('span').first(), true)).text).toBe(
        'Reading report - page 1',
      );
    });
});

test('a page without text keeps the canvas and explains selection availability', async ({
  page,
}) => {
  await page.goto(fixture);
  await configure(page, { noText: true });
  await button(page, '多页 PDF').click();
  await expect(page.locator('.preview-pdf-text-status')).toContainText('此页没有可选文字');
  await expect(page.locator('.preview-pdf canvas')).toBeVisible();
  await expect(layer(page).locator('span')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('text parsing failure preserves a successful canvas', async ({ page }) => {
  await page.addInitScript(() => {
    const original = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (this: ReadableStream, ...args: any[]) {
      if (new Error().stack?.includes('TextLayer.render'))
        throw new Error('fixture text stream failure');
      return original.apply(this, args as []);
    } as typeof original;
  });
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  await expect(page.locator('.preview-pdf-text-status')).toContainText('文字暂时无法选择');
  await expect(page.locator('.preview-pdf-pages')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.preview-pdf canvas')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rapid page changes retain only current text and closing releases copy handlers', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  await ready(page);
  for (const number of ['4', '2', '3', '1', '4']) await page.getByLabel('PDF 页码').fill(number);
  await ready(page, 'Reading report - page 4');
  await expect(layer(page)).toHaveCount(1);
  await page.evaluate(() => {
    (window as any).oldPdfLayer = document.querySelector('.textLayer');
  });
  await button(page, '关闭预览 多页报告.pdf').click();
  await expect(layer(page)).toHaveCount(0);
  const oldCopy = await page.evaluate(() => {
    const node = (window as any).oldPdfLayer as HTMLElement;
    document.body.append(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    node.dispatchEvent(event);
    node.remove();
    return event.defaultPrevented;
  });
  expect(oldCopy).toBe(false);
  await expect(page.locator('body > canvas.hiddenCanvasElement')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('PDF refresh leaves outside selection and outside copying alone', async ({ page }) => {
  await page.goto(fixture);
  await button(page, '多页 PDF').click();
  await ready(page);
  await page.evaluate(() => {
    const outside = document.createElement('p');
    outside.id = 'outside-selection';
    outside.textContent = 'Other pane text';
    document.body.append(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    (window as any).fixturePreview.emit('多页报告.pdf');
  });
  await ready(page);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('Other pane text');
  expect(await copySelected(page.locator('#outside-selection'))).toEqual({
    text: '',
    prevented: false,
  });
});

test('popup PDF selection and copy read the owning document', async ({ page }) => {
  await page.goto(fixture + '?popup');
  const popupPromise = page.waitForEvent('popup');
  await button(page, '打开弹出预览').click();
  const popup = await popupPromise;
  await button(popup, '多页 PDF').click();
  await ready(popup);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  expect(await copySelected(layer(popup).locator('span').first(), true)).toEqual({
    text: 'Reading report - page 1',
    prevented: true,
  });
  await aligned(popup);
  await button(popup, '关闭预览 多页报告.pdf').click();
  await expect(layer(popup)).toHaveCount(0);
  await popup.close();
});

test('PDF remains selectable at mobile, tablet and desktop sizes in both themes and font sizes', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  for (const theme of ['light', 'dark'])
    for (const width of [390, 1024, 1440])
      for (const font of [14, 20]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fixture);
        await page.evaluate(
          ({ theme, font }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.style.setProperty('--interface-font-size', `${font}px`);
          },
          { theme, font },
        );
        await button(page, '多页 PDF').click();
        await ready(page);
        await aligned(page);
        expect((await copySelected(layer(page).locator('span').first(), true)).text).toBe(
          'Reading report - page 1',
        );
        await page
          .locator('.preview-pdf')
          .screenshot({ path: testInfo.outputPath(`pdf-${theme}-${width}-${font}.png`) });
      }
});
