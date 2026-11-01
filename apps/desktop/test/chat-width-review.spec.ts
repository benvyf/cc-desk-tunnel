import { test, expect, type Page } from '@playwright/test';
import { chatWidthFixture } from './fixtures/chat-width.ts';
import {
  installPerformanceProbe,
  readPerformanceProbe,
} from './fixtures/conversation-performance.ts';

const handle = (page: Page) => page.locator('.workspace [data-chat-width-handle="right"]');
const width = (page: Page) =>
  page.locator('.workspace .transcript').evaluate((n) => n.getBoundingClientRect().width);
async function begin(page: Page) {
  const b = (await handle(page).boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 20);
  await expect.poll(() => width(page)).toBe(838);
  return { x: x + 35, y: y + 20 };
}

test('a captured indicator stays under the pointer when the conversation header grows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  const at = await begin(page);
  const before = (await handle(page).boundingBox())!;
  await page.keyboard.press('Control+f');
  await expect(page.locator('.conversation-find')).toBeVisible();
  const after = (await handle(page).boundingBox())!;
  expect(after.y).toBeGreaterThan(before.y);
  await expect
    .poll(() =>
      handle(page).evaluate(
        (n) =>
          n.getBoundingClientRect().top +
          Number.parseFloat(getComputedStyle(n).getPropertyValue('--chat-width-pointer-y')),
      ),
    )
    .toBeCloseTo(at.y, 0);
  await page.mouse.move(at.x + 10, at.y + 10);
  await expect
    .poll(() =>
      handle(page).evaluate(
        (n) =>
          n.getBoundingClientRect().top +
          Number.parseFloat(getComputedStyle(n).getPropertyValue('--chat-width-pointer-y')),
      ),
    )
    .toBeCloseTo(at.y + 10, 0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

for (const button of ['right', 'middle'] as const) {
  test(`native ${button} button chords release a primary drag cleanly`, async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 950 });
    await chatWidthFixture(page);
    const at = await begin(page);
    await page.mouse.down({ button });
    await page.mouse.up({ button: 'left' });
    await page.mouse.move(at.x + 50, at.y);
    await page.mouse.up({ button });
    await expect(page.locator('.chat-workspace')).not.toHaveAttribute('data-chat-width-dragging');
    const saved = await page.evaluate(() => localStorage.getItem('cc-chat-content-width'));
    // Browser context-menu/autoscroll capture cancellation or an ordinary commit must both end the gesture.
    expect(await width(page)).toBe(saved === null ? 768 : Number(saved));
    const ended = await width(page);
    await page.mouse.move(at.x + 100, at.y + 20);
    expect(await width(page)).toBe(ended);
  });
}

test('real same-origin storage events synchronize both mounted and unmounted controls', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await begin(page);
  await page.mouse.up();
  const peer = await context.newPage();
  // An inert document avoids starting another application or any model/service request.
  await peer.route('**/width-storage-peer', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>storage peer</title>' }),
  );
  await peer.goto('/width-storage-peer');
  await peer.evaluate(() => localStorage.setItem('cc-chat-content-width', '940'));
  await expect.poll(() => width(page)).toBe(940);
  await page.bringToFront();
  await page.keyboard.press('Control+Comma');
  await expect(handle(page)).toHaveCount(0);
  await peer.evaluate(() => localStorage.setItem('cc-chat-content-width', '1100'));
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await expect.poll(() => width(page)).toBe(1100);
  await peer.close();
});

test('repeated main-session remounts keep global listeners bounded', async ({ page }) => {
  await installPerformanceProbe(page);
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  const before = await readPerformanceProbe(page);
  for (let n = 0; n < 8; n++) {
    await page
      .locator('.session-row')
      .filter({ hasText: n % 2 === 0 ? '宽度测试第二会话' : '宽度测试主会话' })
      .locator('.session-select')
      .click();
    await expect(handle(page)).toBeVisible();
  }
  const after = await readPerformanceProbe(page);
  for (const event of ['storage', 'blur', 'keydown', 'visibilitychange']) {
    const balance = (probe: typeof before) =>
      (probe.listenerAdds[event] ?? 0) - (probe.listenerRemoves[event] ?? 0);
    expect(balance(after), event).toBe(balance(before));
  }
});

test('narrow columns and large type retain a centered, operable composer', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await page.evaluate(async () => {
    const path = '/src/prefs.ts';
    const { setPrefs } = await import(path);
    setPrefs((p: any) => ({ ...p, fontSizes: { ...p.fontSizes, interface: 20 } }));
  });
  for (const viewport of [1095, 1096, 1097, 720, 390, 320]) {
    await page.setViewportSize({ width: viewport, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    const text = (await page.locator('.workspace .transcript').boundingBox())!;
    const input = (await page.locator('.workspace .composer').boundingBox())!;
    expect(Math.abs(text.x + text.width / 2 - input.x - input.width / 2)).toBeLessThanOrEqual(1);
    const column = await page
      .locator('.workspace .conversation-frame')
      .evaluate((n) => n.clientWidth);
    if (column < 760) await expect(handle(page)).toBeHidden();
  }
});

test('a hovered indicator follows layout changes after a completed drag', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  const at = await begin(page);
  await page.mouse.up();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.conversation-find')).toBeVisible();
  await expect
    .poll(() => handle(page).evaluate((n) => getComputedStyle(n, '::after').opacity))
    .toBe('1');
  await expect
    .poll(() =>
      handle(page).evaluate(
        (n) =>
          n.getBoundingClientRect().top +
          Number.parseFloat(getComputedStyle(n).getPropertyValue('--chat-width-pointer-y')),
      ),
    )
    .toBeCloseTo(at.y, 0);
});

test('consecutive captured gestures save only their own final widths', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (let turn = 0; turn < 16; turn++) {
    const before = await width(page);
    const box = (await handle(page).boundingBox())!;
    const dx = turn % 2 ? -15 : 15;
    await page.mouse.move(box.x + 5, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 5 + dx, box.y + 130);
    await page.mouse.up();
    await expect.poll(() => width(page)).toBe(before + dx * 2);
    expect(await page.evaluate(() => localStorage.getItem('cc-chat-content-width'))).toBe(
      String(before + dx * 2),
    );
    await expect(page.locator('.chat-workspace')).not.toHaveAttribute('data-chat-width-dragging');
  }
  expect(errors).toEqual([]);
});

test('a divider hidden by a narrow column does not retain keyboard ownership', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await handle(page).focus();
  await page.setViewportSize({ width: 720, height: 950 });
  await expect(handle(page)).toBeHidden();
  await expect
    .poll(() => handle(page).evaluate((n) => n.ownerDocument.activeElement === n))
    .toBe(false);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => localStorage.getItem('cc-chat-content-width'))).toBeNull();
});
