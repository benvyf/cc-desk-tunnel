import { test, expect, type Page } from '@playwright/test';
import { chatWidthFixture } from './fixtures/chat-width.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const main = (page: Page) => page.locator('.workspace');
const handle = (page: Page, side = 'right') =>
  main(page).locator(`[data-chat-width-handle="${side}"]`);
const width = (page: Page, selector = '.transcript') =>
  main(page)
    .locator(selector)
    .evaluate((n) => n.getBoundingClientRect().width);
async function drag(page: Page, side: string, dx: number, up = true) {
  const box = (await handle(page, side).boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + 40, { steps: 8 });
  if (up) await page.mouse.up();
}

test('both margins resize the centered transcript and composer together', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await expect(handle(page)).toBeVisible();
  const before = await width(page);
  await drag(page, 'right', 80);
  await expect.poll(() => width(page)).toBeCloseTo(before + 160, 0);
  expect(await width(page, '.composer')).toBeCloseTo(before + 160, 0);
  const textBox = (await main(page).locator('.transcript').boundingBox())!;
  const inputBox = (await main(page).locator('.composer').boundingBox())!;
  expect(textBox.x + textBox.width / 2).toBeCloseTo(inputBox.x + inputBox.width / 2, 0);
  await drag(page, 'left', 50);
  await expect.poll(() => width(page)).toBeCloseTo(before + 60, 0);
  expect(await page.evaluate(() => localStorage.getItem('cc-chat-content-width'))).toBe(
    String(before + 60),
  );
});

test('clamping a stored width preserves it through narrow windows and returns on expansion', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('cc-chat-content-width', '1120'));
  await page.setViewportSize({ width: 1900, height: 900 });
  const f = await chatWidthFixture(page);
  expect(await width(page)).toBe(1120);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => width(page)).toBeLessThan(1120);
  const box = (await handle(page).boundingBox())!;
  await page.mouse.click(box.x + 5, box.y + 80);
  expect(await page.evaluate(() => localStorage.getItem('cc-chat-content-width'))).toBe('1120');
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(handle(page)).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.setViewportSize({ width: 1900, height: 900 });
  await expect.poll(() => width(page)).toBe(1120);
  await page.keyboard.press('Control+b');
  await expect.poll(() => width(page)).toBe(1120);
  expect(f.calls.filter((c) => c.type.includes('width'))).toEqual([]);
});

for (const reason of [
  'Escape',
  'blur',
  'pointercancel',
  'lostpointercapture',
  'resize',
  'switch',
  'visibility',
]) {
  test(`unfinished drag is cancelled on ${reason} without persisting`, async ({ page }) => {
    await page.setViewportSize({ width: 1700, height: 950 });
    const f = await chatWidthFixture(page);
    const original = await width(page);
    const run = f.start();
    run.fragment('正在回答，不应被调宽取消。');
    await drag(page, 'right', 50, false);
    await expect.poll(() => width(page)).toBe(original + 100);
    if (reason === 'Escape') await page.keyboard.press('Escape');
    if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    if (reason === 'visibility')
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    if (reason === 'pointercancel' || reason === 'lostpointercapture')
      await handle(page).evaluate((node, reason) => {
        // Chromium exposes the captured mouse pointer as id 1.
        node.dispatchEvent(new PointerEvent(reason, { pointerId: 1 }));
      }, reason);
    if (reason === 'resize') await page.setViewportSize({ width: 1650, height: 900 });
    if (reason === 'switch')
      await page
        .locator('.session-row')
        .filter({ hasText: '宽度测试第二会话' })
        .locator('.session-select')
        .dispatchEvent('click');
    await page.mouse.up();
    await expect.poll(() => width(page)).toBe(original);
    expect(await page.evaluate(() => localStorage.getItem('cc-chat-content-width'))).toBeNull();
    expect(f.calls.filter((c) => c.type === 'run.cancel')).toEqual([]);
    await expect(main(page)).not.toHaveAttribute('data-chat-width-dragging');
  });
}

test('keyboard controls and double click follow the local divider conventions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await handle(page, 'left').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => width(page)).toBe(778);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => width(page)).toBe(768);
  await page.keyboard.press('Home');
  await expect.poll(() => width(page)).toBe(640);
  await expect(handle(page, 'left')).toHaveAttribute('aria-valuenow', '640');
  await page.keyboard.press('End');
  expect(await width(page)).toBe(Number(await handle(page).getAttribute('aria-valuemax')));
  const h = (await handle(page).boundingBox())!;
  const navigator = (await main(page).locator('.turn-navigation').boundingBox())!;
  expect(h.x + h.width).toBeLessThanOrEqual(navigator.x);
  await handle(page).dblclick();
  await expect.poll(() => width(page)).toBe(768);
  expect(await page.evaluate(() => localStorage.getItem('cc-chat-content-width'))).toBeNull();
});

test('width survives reconnecting the app and stays separate from sidebar chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1900, height: 950 });
  await chatWidthFixture(page);
  await drag(page, 'right', 80);
  const saved = await width(page);
  await main(page).getByRole('button', { name: '在侧边聊天中提问', exact: true }).last().click();
  const side = page.getByRole('region', { name: '侧边会话', exact: true });
  await expect(side).toBeVisible();
  await expect(side.locator('[data-chat-width-handle]')).toHaveCount(0);
  expect(
    await side.evaluate((n) => getComputedStyle(n).getPropertyValue('--chat-content-width')),
  ).toBe('');
  await page.keyboard.press('Control+b');
  await expect.poll(() => width(page)).toBe(saved);
  await chatWidthFixture(page);
  await expect.poll(() => width(page)).toBe(saved);
});

test('wheel on a handle scrolls the transcript and leaves live-follow until the reader returns', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  const f = await chatWidthFixture(page, 24);
  const scroll = main(page).locator('.conversation');
  const run = f.start();
  run.fragment('流式消息开始。');
  await drag(page, 'right', 60);
  const distance = () => scroll.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight);
  await expect.poll(distance).toBeLessThan(3);
  await handle(page).hover();
  await page.mouse.wheel(0, -450);
  await expect.poll(distance).toBeGreaterThan(300);
  run.fragment('\n\n新输出不应把读者拉回底部。'.repeat(20));
  await expect(main(page).getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
  await expect.poll(distance).toBeGreaterThan(300);
  await main(page).getByRole('button', { name: '回到底部', exact: true }).click();
  await expect.poll(distance).toBeLessThan(3);
});

for (const theme of ['light', 'dark']) {
  test(`${theme} uses the existing theme and a short faded indicator`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 950 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await chatWidthFixture(page);
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.mouse.move(1, 1);
    expect(await handle(page).evaluate((n) => getComputedStyle(n, '::after').opacity)).toBe('0');
    await handle(page).hover();
    const style = await handle(page).evaluate((n) => {
      const s = getComputedStyle(n, '::after');
      return {
        width: s.width,
        opacity: s.opacity,
        background: s.backgroundImage,
        cursor: getComputedStyle(n).cursor,
      };
    });
    expect(style).toMatchObject({ width: '2px', opacity: '1', cursor: 'col-resize' });
    expect(style.background).toContain('linear-gradient');
    await page.screenshot({
      path: testInfo.outputPath(`chat-width-${theme}.png`),
      animations: 'disabled',
    });
    await page.mouse.move(1, 1);
    expect(errors).toEqual([]);
  });
}

test('drag frames do not persist or mutate the transcript; release writes once', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 950 });
  const f = await chatWidthFixture(page, 100);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留输入草稿');
  await page.evaluate(() => {
    const probe = ((window as any).widthProbe = {
      writes: 0,
      mutations: 0,
      widths: 0,
      geometry: 0,
      frames: [] as number[],
      longTasks: [] as number[],
      inputFrames: [] as number[],
    });
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cc-chat-content-width') probe.writes++;
      return set.call(this, key, value);
    };
    new MutationObserver((entries) => (probe.mutations += entries.length)).observe(
      document.querySelector('.transcript')!,
      { subtree: true, childList: true, characterData: true, attributes: true },
    );
    new MutationObserver((entries) => (probe.widths += entries.length)).observe(
      document.querySelector('.chat-workspace')!,
      { attributes: true, attributeFilter: ['style'] },
    );
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches('[data-chat-width-handle]')) probe.geometry++;
      return rect.call(this);
    };
    new PerformanceObserver((list) =>
      probe.longTasks.push(...list.getEntries().map((e) => e.duration)),
    ).observe({ type: 'longtask' });
    document
      .querySelector('textarea')!
      .addEventListener('input', (e) =>
        requestAnimationFrame(() => probe.inputFrames.push(performance.now() - e.timeStamp)),
      );
    let previous = performance.now();
    const frame = (now: number) => {
      probe.frames.push(now - previous);
      previous = now;
      if (probe.frames.length < 180) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.pressSequentially('输入不会触发宽度重算。performance');
  await page.evaluate(() => {
    const probe = (window as any).widthProbe;
    probe.baselineInputFrames = probe.inputFrames;
    probe.inputFrames = [];
    probe.widths = 0;
    probe.geometry = 0;
    probe.frames = [];
    probe.longTasks = [];
  });
  const calls = f.calls.length;
  await drag(page, 'right', 200, false);
  expect(await page.evaluate(() => (window as any).widthProbe.writes)).toBe(0);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).widthProbe.writes)).toBe(1);
  await page
    .getByRole('textbox', { name: '消息', exact: true })
    .pressSequentially('输入不会触发宽度重算。performance');
  const probe = await page.evaluate(() => (window as any).widthProbe);
  expect(probe.mutations).toBe(0);
  expect(f.calls.length).toBe(calls);
  expect(probe.geometry).toBeLessThanOrEqual(3);
  const sorted = [...probe.inputFrames].sort((a: number, b: number) => a - b);
  const summary = {
    ...probe,
    inputP95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    frameMax: Math.max(...probe.frames),
  };
  const baseline = [...probe.baselineInputFrames].sort((a: number, b: number) => a - b);
  Object.assign(summary, { baselineInputP95: baseline[Math.ceil(baseline.length * 0.95) - 1] });
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '保留输入草稿输入不会触发宽度重算。performance输入不会触发宽度重算。performance',
  );
  const folder = resolve('.local/chat-width-evidence');
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, 'performance.json'), JSON.stringify(summary, null, 2));
  await testInfo.attach('width-performance', {
    body: JSON.stringify(probe),
    contentType: 'application/json',
  });
});

test('queue, run summary and session statistics follow the shared width', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  const f = await chatWidthFixture(page);
  await page.evaluate(async () => {
    const path = '/src/prefs.ts';
    const { setPrefs } = await import(path);
    setPrefs((prefs: any) => ({ ...prefs, sessionBar: { ...prefs.sessionBar, enabled: true } }));
  });
  f.start().fragment('正在回答');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('排队中的问题');
  await page.getByRole('button', { name: '排队发送', exact: true }).click();
  await expect(main(page).locator('.follow-up-queue')).toContainText('排队中的问题');
  await drag(page, 'left', -100);
  const value = await width(page);
  expect(await width(page, '.composer')).toBe(value);
  expect(await width(page, '.follow-up-queue')).toBe(value - 28);
  expect(await width(page, '.run-summary')).toBe(value);
  expect(await width(page, '.session-bar')).toBe(value);
});

test('storage errors preserve an operable chat and the current in-memory drag preference', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem,
      remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'cc-chat-content-width') throw new DOMException('blocked', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cc-chat-content-width') throw new DOMException('full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (key === 'cc-chat-content-width') throw new DOMException('blocked', 'SecurityError');
      return remove.call(this, key);
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await drag(page, 'right', 70);
  await expect.poll(() => width(page)).toBe(908);
  await drag(page, 'left', 50, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(908);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('存储不可用时仍可输入');
  await page
    .locator('.session-row')
    .filter({ hasText: '宽度测试第二会话' })
    .locator('.session-select')
    .click();
  await expect.poll(() => width(page)).toBe(908);
  await handle(page).dblclick();
  await page
    .locator('.session-row')
    .filter({ hasText: '宽度测试主会话' })
    .locator('.session-select')
    .click();
  await expect.poll(() => width(page)).toBe(768);
  expect(errors).toEqual([]);
});

test('same-origin storage updates cancel the current drag and apply the new preference', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await drag(page, 'right', 50, false);
  await page.evaluate(() => {
    localStorage.setItem('cc-chat-content-width', '940');
    dispatchEvent(
      new StorageEvent('storage', {
        key: 'cc-chat-content-width',
        newValue: '940',
        storageArea: localStorage,
      }),
    );
  });
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(940);
});

test('storage updates are observed even while Settings has unmounted the controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  await drag(page, 'right', 70);
  await page.keyboard.press('Control+Comma');
  await expect(page.locator('[data-chat-width-handle]')).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem('cc-chat-content-width', '1100');
    dispatchEvent(
      new StorageEvent('storage', {
        key: 'cc-chat-content-width',
        newValue: '1100',
        storageArea: localStorage,
      }),
    );
  });
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect.poll(() => width(page)).toBe(1100);
});

test('streaming output, dragging, typing and navigation coexist without losing the end', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  const f = await chatWidthFixture(page, 80);
  const run = f.start();
  run.fragment('流式回答。');
  const timer = setInterval(() => run.fragment('持续输出测试，正文和输入框联动。\n\n'), 30);
  try {
    await drag(page, 'right', 100);
    await page
      .getByRole('textbox', { name: '消息', exact: true })
      .pressSequentially('输出期间仍可输入');
    await drag(page, 'left', 40);
    await expect
      .poll(() =>
        main(page)
          .locator('.conversation')
          .evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight),
      )
      .toBeLessThan(3);
    await main(page).locator('[data-turn-mark]').last().click();
    await expect(main(page).getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
  } finally {
    clearInterval(timer);
  }
  expect(f.calls.filter((c) => c.type === 'run.cancel' || c.type === 'message.send')).toEqual([]);
});

test('a pointermove burst merges into one width mutation and a cancelled RAF cannot replay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1700, height: 950 });
  await chatWidthFixture(page);
  const box = (await handle(page).boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 100);
  await page.mouse.down();
  const mutations = await handle(page).evaluate(async (node) => {
    let count = 0;
    const observer = new MutationObserver((entries) => (count += entries.length));
    observer.observe(document.querySelector('.chat-workspace')!, {
      attributes: true,
      attributeFilter: ['style'],
    });
    const b = node.getBoundingClientRect();
    for (let index = 0; index < 100; index++)
      node.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          clientX: b.x + 5 + index,
          clientY: b.y + 100,
        }),
      );
    await new Promise(requestAnimationFrame);
    await Promise.resolve();
    observer.disconnect();
    return count;
  });
  expect(mutations).toBe(1);
  await handle(page).evaluate((node) => {
    node.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 1400 }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(768);
});
