import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSession, login, screenshots, send, settled } from './helpers.ts';

async function mountReply(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const richPath = '/src/RichText.tsx';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { default: RichText } = await import(richPath);
    const host = document.createElement('main');
    host.className = 'message-content streaming';
    host.style.cssText = 'width:280px;padding:20px';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    (window as unknown as { renderReply: (text: string, streaming: boolean) => void }).renderReply =
      (text, streaming) => root.render(React.createElement(RichText, { text, streaming }));
    Object.assign(window, { unmountReply: () => root.unmount() });
  });
  return async (text: string, streaming = true) => {
    await page.evaluate(
      ({ text, streaming }) =>
        (
          window as unknown as { renderReply: (text: string, streaming: boolean) => void }
        ).renderReply(text, streaming),
      { text, streaming },
    );
    await expect(page.locator('main')).toHaveText(text);
  };
}

async function sizeChat(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  // Wait for the responsive media-query handler before toggling the desktop sidebar.
  if (width > 700) {
    const collapse = page
      .getByRole('banner')
      .getByRole('button', { name: '收起侧栏', exact: true });
    await expect(collapse).toBeVisible();
    await collapse.click();
  } else {
    await expect(page.getByRole('button', { name: '展开会话列表', exact: true })).toBeVisible();
  }
  await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('.sidebar-shade')).toHaveCount(0);
}

test('composer grows and shrinks without shifting on focus; bubbles stay open and readable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const errors: string[] = [];
    Object.assign(window, { composerErrors: errors });
    window.addEventListener('error', (event) => errors.push(event.message));
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '输入与气泡');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1280, 390]) {
      await sizeChat(page, width);
      const composer = page.locator('.composer');
      const input = page.getByRole('textbox', { name: '消息', exact: true });
      await input.fill('');
      await input.blur();
      await expect(composer).toHaveCSS('border-radius', '20px');
      const resting = await composer.evaluate((element) => getComputedStyle(element).boxShadow);
      expect(resting.match(/rgba?\(/g)).toHaveLength(2);
      const before = (await composer.boundingBox())!;
      await input.focus();
      await expect
        .poll(() => composer.evaluate((element) => getComputedStyle(element).boxShadow))
        .not.toBe(resting);
      const after = (await composer.boundingBox())!;
      expect(after).toEqual(before);
      const empty = (await input.boundingBox())!.height;
      await input.fill('多行输入与自然换行。'.repeat(8) + '\n' + '新的段落。\n'.repeat(24));
      expect((await input.boundingBox())!.height).toBeGreaterThan(empty);
      expect((await input.boundingBox())!.height).toBeLessThanOrEqual(420);
      expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport();
      await input.fill('');
      expect((await input.boundingBox())!.height).toBeCloseTo(empty, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await sizeChat(page, 1280);
  await input.fill('自然换行也会跟随窗口宽度。'.repeat(10));
  const wideHeight = (await input.boundingBox())!.height;
  await sizeChat(page, 390);
  await expect.poll(async () => (await input.boundingBox())!.height).toBeGreaterThan(wideHeight);
  await sizeChat(page, 1280);
  await expect.poll(async () => (await input.boundingBox())!.height).toBeCloseTo(wideHeight, 1);
  await sizeChat(page, 390);
  await send(page, '实现一个清晰、安静的聊天界面。');
  await settled(page);
  await expect(page.locator('.message.user .message-content').last()).toHaveCSS(
    'border-radius',
    '20px',
  );
  await expect(page.locator('.message.assistant .message-content').last()).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect(page.locator('.message.assistant .message-content').last()).toHaveCSS(
    'box-shadow',
    'none',
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1280, 390]) {
      await sizeChat(page, width);
      await page.screenshot({
        path: `${screenshots}/composer-bubbles-${colorScheme}-${width}.png`,
        animations: 'disabled',
      });
    }
  }
  expect(
    await page.evaluate(() => (window as unknown as { composerErrors: string[] }).composerErrors),
  ).toEqual([]);
});

test('graphemes blur into place without splitting emoji, changing wrapping or text selection', async ({
  page,
}) => {
  const render = await mountReply(page);
  await render('已有正文：', false);
  const suffix = '你好👨‍👩‍👧‍👦👍🏽e\u0301🇨🇳';
  await render('已有正文：' + suffix);
  const glyphs = page.locator('.stream-grapheme');
  await expect(glyphs).toHaveText(['你', '好', '👨‍👩‍👧‍👦', '👍🏽', 'e\u0301', '🇨🇳']);
  const styles = await glyphs.evaluateAll((elements) =>
    elements.map((element) => {
      const animation = element.getAnimations()[0];
      animation.pause();
      animation.currentTime = 0;
      return {
        duration: getComputedStyle(element).animationDuration,
        delay: getComputedStyle(element).animationDelay,
        filter: getComputedStyle(element).filter,
        display: getComputedStyle(element).display,
      };
    }),
  );
  expect(styles.map((style) => style.delay)).toEqual([
    '0s',
    '0.03s',
    '0.06s',
    '0.09s',
    '0.12s',
    '0.15s',
  ]);
  expect(
    styles.every(
      (style) =>
        style.duration === '0.09s' && style.filter === 'blur(6px)' && style.display === 'inline',
    ),
  ).toBe(true);
  await expect(page.locator('main > p')).toHaveCSS('opacity', '1');
  expect(
    await page.locator('main').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.toString();
    }),
  ).toBe('已有正文：' + suffix);
  await page.screenshot({ path: `${screenshots}/grapheme-start.png` });
  await glyphs.evaluateAll((elements) =>
    elements.forEach((element) =>
      element.getAnimations().forEach((animation) => {
        animation.finish();
      }),
    ),
  );
  await expect(glyphs.first()).toHaveCSS('filter', 'blur(0px)');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(glyphs).toHaveCount(0);
  await expect(page.locator('main > p')).toHaveCSS('filter', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(glyphs).toHaveCount(0);
  // A combining mark arriving in another network chunk belongs to the previous grapheme.
  await render('组合：e', false);
  await render('组合：e\u0301');
  await expect(glyphs).toHaveText(['e\u0301']);
  await render('组合：👨', false);
  await render('组合：👨‍👩‍👧‍👦');
  await expect(glyphs).toHaveText(['👨‍👩‍👧‍👦']);
  for (const text of [
    'A verylongunbrokenenglishword here',
    '中文自然换行测试。测试换行与标点。',
    'مرحبا بالعالم الجميل',
  ]) {
    await render('', false);
    await render(text);
    const heights = await page.locator('main > p').evaluate((element) => {
      const copy = element.cloneNode(true) as HTMLElement;
      copy.textContent = element.textContent;
      element.after(copy);
      const result = [element.getBoundingClientRect().height, copy.getBoundingClientRect().height];
      copy.remove();
      return result;
    });
    expect(heights[0]).toBe(heights[1]);
  }
});

test('large bursts bound animated graphemes across Markdown leaves and completion cleans up', async ({
  page,
}) => {
  const render = await mountReply(page);
  await render('已有内容', false);
  // Use the mount renderer directly: Markdown textContent intentionally differs from its source.
  const source =
    '已有内容' +
    '一段很长的追加内容。'.repeat(1200) +
    '\n\n' +
    Array.from({ length: 100 }, (_, i) => `**强调${i}**`).join(' ');
  await page.evaluate(
    (text) =>
      (
        window as unknown as { renderReply: (text: string, streaming: boolean) => void }
      ).renderReply(text, true),
    source,
  );
  await expect(page.locator('main')).toContainText('强调99');
  expect(await page.locator('.stream-grapheme').count()).toBeGreaterThan(0);
  expect(await page.locator('.stream-grapheme').count()).toBeLessThanOrEqual(24);
  expect(
    await page
      .locator('.stream-grapheme')
      .evaluateAll((elements) =>
        Math.max(
          ...elements.map((element) => parseFloat(getComputedStyle(element).animationDelay)),
        ),
      ),
  ).toBeLessThanOrEqual(0.18);
  const manyLeaves = '已有内容\n\n' + Array.from({ length: 60 }, () => '**短** *句*').join(' ');
  await render('已有内容', false);
  await page.evaluate(
    (text) =>
      (
        window as unknown as { renderReply: (text: string, streaming: boolean) => void }
      ).renderReply(text, true),
    manyLeaves,
  );
  await expect(page.locator('main strong')).toHaveCount(60);
  await expect(page.locator('.stream-grapheme')).toHaveCount(24);
  expect(await page.locator('.stream-reveal').count()).toBeGreaterThan(1);
  await page.evaluate(
    (text) =>
      (
        window as unknown as { renderReply: (text: string, streaming: boolean) => void }
      ).renderReply(text, false),
    source,
  );
  await expect(page.locator('.stream-grapheme, .stream-reveal')).toHaveCount(0);
  await expect(page.locator('main')).toContainText('强调99');
});

test('long whitespace stays intact without allocating a text node per space', async ({ page }) => {
  const render = await mountReply(page);
  await render('前文：', false);
  const text = '前文：' + ' '.repeat(10000) + '末字';
  await render(text);
  expect(await page.locator('main > p').textContent()).toBe(text);
  expect(
    await page.locator('.stream-reveal').evaluate((element) => element.childNodes.length),
  ).toBeLessThanOrEqual(50);
  await expect(page.locator('.stream-grapheme')).toHaveText(['末', '字']);
});

test('changing reduced motion never replays text already displayed', async ({ page }) => {
  const render = await mountReply(page);
  await render('旧正文：', false);
  await render('旧正文：逐字');
  await expect(page.locator('.stream-grapheme')).toHaveCount(2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.stream-grapheme')).toHaveCount(0);
  await render('旧正文：逐字新增');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const active = await page
    .locator('main')
    .evaluate((element) => element.getAnimations({ subtree: true }).length);
  expect(active).toBe(0);
  await render('旧正文：逐字新增后续');
  await expect(page.locator('.stream-grapheme')).toHaveText(['后', '续']);
});

test('replayed and replaced replies stay immediate; resuming reveals only new complete graphemes', async ({
  page,
}) => {
  const render = await mountReply(page);
  await render('历史回复。', false);
  await render('历史回复。续写');
  await expect(page.locator('.stream-grapheme')).toHaveText(['续', '写']);
  await render('历史回复。续写', false);
  await expect(page.locator('.stream-reveal')).toHaveCount(0);
  await render('历史回复。续写');
  await expect(page.locator('.stream-reveal')).toHaveCount(0);
  await render('历史回复。续写🚀');
  await expect(page.locator('.stream-grapheme')).toHaveText(['🚀']);
  await render('替换后的快照');
  await expect(page.locator('.stream-reveal')).toHaveCount(0);
  await render('替换后的快照：\ud83d');
  await render('替换后的快照：🚀');
  await expect(page.locator('.stream-grapheme')).toHaveText(['🚀']);
  await page.evaluate(() => {
    (window as unknown as { renderReply: (text: string, streaming: boolean) => void }).renderReply(
      '实体 &am',
      true,
    );
  });
  await expect(page.locator('main > p')).toHaveText('实体 &am');
  await page.evaluate(() => {
    (window as unknown as { renderReply: (text: string, streaming: boolean) => void }).renderReply(
      '实体 &amp; 后续',
      true,
    );
  });
  await expect(page.locator('main > p')).toHaveText('实体 & 后续');
  await expect(page.locator('.stream-reveal')).toHaveCount(0);
});

test('motion preference listeners exist only for live replies and are released on completion and unmount', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (
        this instanceof MediaQueryList &&
        this.media.includes('prefers-reduced-motion') &&
        type === 'change' &&
        listener
      )
        listeners.add(listener);
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      if (
        this instanceof MediaQueryList &&
        this.media.includes('prefers-reduced-motion') &&
        type === 'change' &&
        listener
      )
        listeners.delete(listener);
      return remove.call(this, type, listener, options);
    };
    Object.assign(window, { motionListenerCount: () => listeners.size });
  });
  const render = await mountReply(page);
  const listenerCount = () =>
    page.evaluate(() =>
      (window as unknown as { motionListenerCount: () => number }).motionListenerCount(),
    );
  await render('静态历史', false);
  await expect.poll(listenerCount).toBe(0);
  for (let index = 0; index < 8; index++) {
    await render(`流式回复${index}`);
    await expect.poll(listenerCount).toBe(1);
    await render(`流式回复${index}`, false);
    await expect.poll(listenerCount).toBe(0);
  }
  await render('最后一次流式回复');
  await expect.poll(listenerCount).toBe(1);
  await page.evaluate(() => (window as unknown as { unmountReply: () => void }).unmountReply());
  await expect.poll(listenerCount).toBe(0);
});

test('IME confirmation does not send; Shift+Enter inserts a line and Enter sends once', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '输入法与快捷键');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('中文组合输入');
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  await expect(page.locator('.message.user')).toHaveCount(0);
  await expect(input).toHaveValue('中文组合输入');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('中文组合输入\n');
  await input.press('Enter');
  await settled(page);
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.user .message-content')).toHaveText('中文组合输入');
  await expect(input).toHaveValue('');
});
