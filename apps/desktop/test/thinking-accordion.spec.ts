import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION, type Session, type SessionEvent } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const thought =
  '**检查需求**\n正在检查工程目录和主题适配。\n\n[思考唯一链接](https://example.com)\n\n' +
  '保留完整英文 engineering 与中文换行。'.repeat(12);

async function open(page: Page, theme = 'system', mode = 'expanded') {
  await page.addInitScript((prefs) => localStorage.setItem('proxy-prefs', JSON.stringify(prefs)), {
    theme,
    view: { mode },
  });
  const connectionId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();
  const started = Date.now() - 10_000;
  const session: Session = {
    id: randomUUID(),
    title: '思考伸缩测试',
    autoTitle: false,
    projectPath: 'D:\\thinking',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: new Date(started).toISOString(),
    updatedAt: new Date(started).toISOString(),
    activeRun: null,
  };
  let sequence = 0;
  const event = (payload: SessionEvent['payload'], seconds: number) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: new Date(started + seconds * 1000).toISOString(),
    payload,
  });
  const events = [
    event(
      { type: 'message.user', messageId: randomUUID(), text: '检查思考组件', scenario: 'chat' },
      0,
    ),
    event({ type: 'thinking.delta', messageId, text: thought }, 1),
  ];
  let emit = (_payload: SessionEvent['payload'], _seconds: number) => {};
  let fragment = (_payload: SessionEvent['payload']) => {};
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    emit = (payload, seconds) => send({ type: 'session.event', event: event(payload, seconds) });
    fragment = (payload) =>
      send({ type: 'session.fragment', sessionId: session.id, runId, payload });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-thinking-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  if (mode === 'standard') await page.locator('.work > summary').click();
  await expect(page.locator('.thinking-block')).toBeVisible();
  return {
    emit,
    fragment,
    append: (text: string) => emit({ type: 'thinking.delta', messageId, text }, 2),
    finish: (status: 'completed' | 'cancelled' | 'failed' = 'completed') =>
      emit({ type: 'run.status', status, connectionId }, 4),
  };
}

test('only the live trailing thought waves; later text, tools and run endings settle it', async ({
  page,
}) => {
  const stream = await open(page);
  const block = page.locator('.thinking-block');
  await expect(block.locator('.tool-verb')).toHaveText('思考中…');
  await block.locator(':scope > summary').click({ position: { x: 14, y: 14 } });
  expect(
    await block
      .locator('.message-content p')
      .first()
      .evaluate((el) => getComputedStyle(el).textWrapStyle),
  ).toBe('auto');
  const dots = block.locator('.thinking-indicator > span');
  await expect(dots).toHaveCount(3);
  const phases = await dots.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, delay: style.animationDelay };
    }),
  );
  expect(phases.every((phase) => phase.name !== 'none')).toBe(true);
  expect(new Set(phases.map((phase) => phase.delay)).size).toBe(3);
  await stream.emit({ type: 'text.delta', messageId: randomUUID(), text: '已开始回答。' }, 4);
  await expect(block.locator('.tool-verb')).toHaveText('思考已结束');
  await expect(dots).toHaveCount(1);
  expect(
    await block
      .locator('.message-content p')
      .first()
      .evaluate((el) => getComputedStyle(el).textWrapStyle),
  ).toBe('pretty');
  await stream.emit({ type: 'thinking.delta', messageId: randomUUID(), text: '第二段思考' }, 5);
  await expect(page.locator('.thinking-block').last().locator('.tool-verb')).toHaveText('思考中…');
  await stream.emit(
    { type: 'tool.requested', toolId: randomUUID(), name: 'Read', input: '{}', target: 'Windows' },
    7,
  );
  await expect(page.locator('.thinking-block').last().locator('.tool-verb')).toHaveText(
    '思考已结束',
  );
  await stream.emit({ type: 'thinking.delta', messageId: randomUUID(), text: '第三段思考' }, 8);
  await expect(page.locator('.thinking-block').last().locator('.tool-verb')).toHaveText('思考中…');
  await stream.emit({ type: 'run.status', status: 'cancelled', connectionId: randomUUID() }, 10);
  await expect(page.locator('.thinking-block').last().locator('.tool-verb')).toHaveText(
    '思考已结束',
  );
  await expect(page.locator('.thinking-indicator > span')).toHaveCount(3);
  expect(await dots.first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});

test('native keyboard folds stay lazy, animate both grid directions and reverse without a snap', async ({
  page,
}) => {
  await open(page);
  const block = page.locator('.thinking-block');
  const summary = block.locator(':scope > summary');
  await expect(block.locator('.tool-detail')).toHaveCount(0);
  expect(await block.locator('.thinking-grid').evaluate((el) => getComputedStyle(el).display)).toBe(
    'grid',
  );
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--cds-dur-sheet', '1000ms'),
  );
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(block.locator('.tool-detail')).toContainText('思考唯一链接');
  const halfway = async () =>
    block.evaluate((el) => {
      const animation = el
        .getAnimations({ subtree: true })
        .find((a) => a instanceof CSSTransition && a.transitionProperty === 'grid-template-rows');
      if (!animation) return null;
      animation.pause();
      animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2;
      return el.querySelector('.thinking-content')!.getBoundingClientRect().height;
    });
  const expanding = await halfway();
  expect(expanding).not.toBeNull();
  const finish = () =>
    block.evaluate((el) =>
      el.getAnimations({ subtree: true }).forEach((a) => {
        if (a instanceof CSSTransition) a.finish();
      }),
    );
  await finish();
  const full = (await block.locator('.thinking-content').boundingBox())!.height;
  expect(expanding!).toBeGreaterThan(0);
  expect(expanding!).toBeLessThan(full);
  await page.keyboard.press('Space');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(block.locator('.thinking-grid')).toHaveAttribute('inert', '');
  await expect(block.getByRole('link', { name: '思考唯一链接' })).toHaveCount(0);
  const collapsing = await halfway();
  expect(collapsing).not.toBeNull();
  expect(collapsing!).toBeGreaterThan(0);
  expect(collapsing!).toBeLessThan(full);
  await page.keyboard.press('Enter');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await finish();
  await expect(block.locator('.thinking-grid')).not.toHaveAttribute('inert');
  await expect(block.getByRole('link', { name: '思考唯一链接' })).toBeVisible();
  await summary.press('Space');
  await finish();
  await expect(block.locator('.tool-detail')).toHaveCount(0);
  expect((await block.locator('.thinking-content').boundingBox())!.height).toBe(0);
});

test('settling real fragments keeps ended thoughts static without estimating elapsed time', async ({
  page,
}) => {
  const stream = await open(page);
  const thoughtId = randomUUID();
  const answerId = randomUUID();
  await stream.fragment({ type: 'thinking.delta', messageId: thoughtId, text: '正在流式思考' });
  const last = page.locator('.thinking-block').last();
  await expect(last.locator('.tool-verb')).toHaveText('思考中…');
  await stream.emit({ type: 'thinking.delta', messageId: thoughtId, text: '正在流式思考' }, 10);
  await stream.fragment({ type: 'text.delta', messageId: answerId, text: '开始回答' });
  await expect(last.locator('.tool-verb')).toHaveText('思考已结束');
  await stream.emit({ type: 'text.delta', messageId: answerId, text: '开始回答' }, 15);
  await expect(last.locator('.tool-verb')).toHaveText('思考已结束');
  await expect(page.locator('.thinking-block')).toHaveCount(2);
  await expect(page.locator('.message.assistant .message-content')).toHaveText('开始回答');
});

test('keyboard focus paints inside the thinking card without being clipped', async ({ page }) => {
  await open(page);
  const summary = page.locator('.thinking-block > summary');
  await page.keyboard.press('Tab');
  await summary.focus();
  await page.screenshot({
    path: resolve(screenshots, 'thinking-keyboard-focus.png'),
    animations: 'disabled',
  });
  const focus = await summary.evaluate((el) => {
    const style = getComputedStyle(el);
    const card = el.closest('.thinking-block')!;
    const clipping = ['clip', 'hidden'].includes(getComputedStyle(card).overflowX);
    const outline = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const box = el.getBoundingClientRect(),
      bounds = card.getBoundingClientRect();
    return {
      visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
      fits:
        !clipping ||
        (box.left - outline >= bounds.left &&
          box.right + outline <= bounds.right &&
          box.top - outline >= bounds.top),
    };
  });
  expect(focus.visible).toBe(true);
  expect(focus.fits).toBe(true);
});

test('the two-line preview does not snap the header height when the grid starts either direction', async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--cds-dur-sheet', '1000ms'),
  );
  const block = page.locator('.thinking-block');
  const summary = block.locator(':scope > summary');
  const headingCentre = async (selector: string) => {
    const box = (await summary.locator(selector).boundingBox())!;
    return box.y + box.height / 2;
  };
  expect(
    Math.abs((await headingCentre('.fold-chevron')) - (await headingCentre('.tool-verb'))),
  ).toBeLessThanOrEqual(1);
  const closed = (await block.boundingBox())!.height;
  const seek = (finish: boolean) =>
    block.evaluate((el, finish) => {
      el.getAnimations({ subtree: true }).forEach((animation) => {
        if (!(animation instanceof CSSTransition)) return;
        if (finish) animation.finish();
        else {
          animation.pause();
          animation.currentTime = 0;
        }
      });
      return el.getBoundingClientRect().height;
    }, finish);
  await summary.press('Enter');
  await expect(block).toHaveAttribute('open', '');
  await expect(block.locator('.thinking-preview')).toHaveAttribute('aria-hidden', 'true');
  expect(Math.abs((await seek(false)) - closed)).toBeLessThanOrEqual(1);
  await seek(true);
  // Measure the closing baseline after the lazy Markdown replaces its plain-text fallback.
  await expect(block.getByRole('link', { name: '思考唯一链接' })).toBeVisible();
  const expanded = await seek(true);
  await summary.press('Space');
  await expect(block).not.toHaveAttribute('open');
  await expect(block.locator('.thinking-preview')).toHaveAttribute('aria-hidden', 'false');
  expect(Math.abs((await seek(false)) - expanded)).toBeLessThanOrEqual(1);
  await seek(true);
  await expect(block.locator('.tool-detail')).toHaveCount(0);
});

test('a streaming exit releases content when reduced motion cancels the transition', async ({
  page,
}) => {
  const stream = await open(page);
  const block = page.locator('.thinking-block');
  const summary = block.locator(':scope > summary');
  await summary.press('Enter');
  await block.evaluate((el) =>
    el.getAnimations({ subtree: true }).forEach((a) => {
      if (a instanceof CSSTransition) a.finish();
    }),
  );
  await summary.press('Space');
  await block.evaluate((el) =>
    el.getAnimations({ subtree: true }).forEach((a) => {
      if (a instanceof CSSTransition) {
        a.pause();
        a.currentTime = 100;
      }
    }),
  );
  await stream.append('\n收起途中到达');
  await expect(block.locator('.tool-detail')).toContainText('收起途中到达');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await block.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(block.locator('.tool-detail')).toHaveCount(0);
  expect((await block.locator('.thinking-content').boundingBox())!.height).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await summary.press('Enter');
  await expect(block.locator('.tool-detail')).toContainText('收起途中到达');
  const positions = await block.locator('.thinking-indicator > span').evaluateAll((dots) =>
    dots.map((dot) => {
      const animation = dot.getAnimations()[0];
      animation.pause();
      animation.currentTime = 450;
      return getComputedStyle(dot).transform;
    }),
  );
  expect(new Set(positions).size).toBe(3);
});

for (const mode of ['standard', 'expanded']) {
  test(`search reverses a streaming exit without losing the reader fold state · ${mode}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const stream = await open(page, 'system', mode);
    const block = page.locator('.thinking-block');
    const summary = block.locator(':scope > summary');
    const finishTransitions = () =>
      block.evaluate((el) =>
        el.getAnimations({ subtree: true }).forEach((animation) => {
          if (animation instanceof CSSTransition) animation.finish();
        }),
      );
    await summary.press('Enter');
    await expect(block.getByRole('link', { name: '思考唯一链接' })).toBeVisible();
    await finishTransitions();
    await summary.press('Space');
    const exiting = await block.evaluate((el) => {
      const animation = el
        .getAnimations({ subtree: true })
        .find((a) => a instanceof CSSTransition && a.transitionProperty === 'grid-template-rows');
      if (!animation) return false;
      animation.pause();
      animation.currentTime = 100;
      return true;
    });
    expect(exiting).toBe(true);
    await page.keyboard.press('Control+f');
    const find = page.getByLabel('查找对话内容', { exact: true });
    await find.fill('思考唯一链接');
    await expect(page.locator('.find-count')).toHaveText('1 / 1');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await stream.append('\n搜索反转期间新增内容');
    await finishTransitions();
    await expect(block.getByRole('link', { name: '思考唯一链接' })).toBeVisible();
    await expect(block.locator('.tool-detail')).toContainText('搜索反转期间新增内容');
    // A search-forced summary must not change the reader's earlier closed preference.
    await summary.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await find.press('Escape');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await finishTransitions();
    await expect(block.locator('.tool-detail')).toHaveCount(0);
    await summary.press('Enter');
    await finishTransitions();
    await page.keyboard.press('Control+f');
    await find.fill('搜索反转期间新增内容');
    await expect(page.locator('.find-count')).toHaveText('1 / 1');
    await find.press('Escape');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(block.locator('.tool-detail')).toContainText('搜索反转期间新增内容');
    expect(errors).toEqual([]);
  });
}

test('unmounting a closing thought releases its animations and does not retain the old body', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const stream = await open(page, 'system', 'standard');
  const block = page.locator('.thinking-block');
  const summary = block.locator(':scope > summary');
  await summary.press('Enter');
  await expect(block.getByRole('link', { name: '思考唯一链接' })).toBeVisible();
  await block.evaluate((el) =>
    el.getAnimations({ subtree: true }).forEach((a) => {
      if (a instanceof CSSTransition) a.finish();
    }),
  );
  await summary.press('Space');
  await block.evaluate((el) =>
    el.getAnimations({ subtree: true }).forEach((a) => {
      if (a instanceof CSSTransition) a.pause();
    }),
  );
  await expect(block.locator('.tool-detail')).toHaveCount(1);
  const closing = await block.evaluateHandle((el) =>
    el.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition),
  );
  await page.locator('.work > summary').press('Enter');
  await expect(block).toHaveCount(0);
  expect(await closing.evaluate((animations) => animations.length)).toBeGreaterThan(0);
  await expect
    .poll(() =>
      closing.evaluate((animations) =>
        animations.every((animation) => animation.playState === 'idle'),
      ),
    )
    .toBe(true);
  await closing.dispose();
  await stream.append('\n父级收起期间新增内容');
  await page.locator('.work > summary').press('Enter');
  await expect(block).not.toHaveAttribute('open');
  await expect(block.locator('.tool-detail')).toHaveCount(0);
  await summary.press('Enter');
  await expect(block.locator('.tool-detail')).toContainText('父级收起期间新增内容');
  await stream.finish('failed');
  await expect(block).toHaveCount(0);
  await page.locator('.turn-process > summary').press('Enter');
  await page.locator('.work > summary').press('Enter');
  await expect(block.locator('.tool-verb')).toHaveText('思考已结束');
  await expect(block.locator('.thinking-indicator > span')).toHaveCount(1);
  expect(
    await block
      .locator('.thinking-indicator > span')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  test(`closed preview retains contrast on hover in ${theme} theme`, async ({ page }) => {
    await open(page, theme);
    const summary = page.locator('.thinking-block > summary');
    await summary.hover();
    const ratio = await summary.locator('.thinking-preview').evaluate((el) => {
      const luminance = (value: string) => {
        const c = value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const text = luminance(getComputedStyle(el).color);
      const background = luminance(getComputedStyle(el.closest('summary')!).backgroundColor);
      return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}

test('streaming, completion and find preserve the readers fold state; reduced motion settles immediately', async ({
  page,
}) => {
  const stream = await open(page, 'system', 'standard');
  const block = page.locator('.thinking-block');
  const summary = block.locator(':scope > summary');
  await summary.click({ position: { x: 14, y: 14 } });
  await stream.append('\n持续新增的思考');
  await expect(block.locator('.tool-detail')).toContainText('持续新增的思考');
  await stream.finish();
  await expect(page.locator('.turn-process')).toBeVisible();
  await page.locator('.turn-process > summary').click();
  await page.locator('.work > summary').click();
  // Standard mode unmounts finished work; subsequent search must still restore closed folds.
  await expect(block).not.toHaveAttribute('open');
  await page.keyboard.press('Control+f');
  await page.getByLabel('查找对话内容', { exact: true }).fill('思考唯一链接');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await expect(block).toHaveAttribute('open', '');
  await page.getByLabel('查找对话内容', { exact: true }).press('Escape');
  await expect(block).not.toHaveAttribute('open');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await summary.click();
  expect(await block.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  await summary.click();
  expect((await block.locator('.thinking-content').boundingBox())!.height).toBe(0);
});

for (const theme of ['light', 'dark', 'system']) {
  test(`thinking colours and narrow wrapping follow ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' });
    const stream = await open(page, theme);
    const block = page.locator('.thinking-block');
    const label = block.locator('.tool-verb');
    const capture = async (name: string) => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 390) {
          await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
          await expect(page.locator('.sidebar-shade')).toHaveCount(0);
        }
        await page.screenshot({
          path: resolve(screenshots, `thinking-${theme}-${name}-${width}.png`),
          // Keep live CSS animations owned by CSS; screenshot cancellation/replay can outlive a media change.
          animations: 'allow',
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        const colour = await label.evaluate((el) => {
          const background = getComputedStyle(el.closest('.thinking-block')!).backgroundColor;
          const luminance = (value: string) => {
            const c = value
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number)
              .map((v) => v / 255)
              .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          };
          const a = luminance(getComputedStyle(el).color),
            b = luminance(background);
          return {
            text: getComputedStyle(el).color,
            background,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          };
        });
        expect(colour.ratio).toBeGreaterThanOrEqual(4.5);
        expect(await block.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      return label.evaluate((el) => getComputedStyle(el).color);
    };
    await capture('closed');
    await block.locator(':scope > summary').click({ position: { x: 14, y: 14 } });
    const activeColour = await capture('active');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() => block.evaluate((el) => el.getAnimations({ subtree: true }).length))
      .toBe(0);
    await expect(block.locator('.thinking-indicator > span')).toHaveCount(3);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect
      .poll(() =>
        block
          .locator('.thinking-indicator > span')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
      )
      .not.toBe('none');
    if (theme === 'system') {
      await page.emulateMedia({ colorScheme: 'dark' });
      expect(await capture('active-dark')).not.toBe(activeColour);
    }
    await stream.finish();
    await expect(block.locator('.tool-verb')).toHaveText('思考已结束');
    await expect(block).toHaveAttribute('open', '');
    expect(await capture('done')).not.toBe(activeColour);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() => block.evaluate((el) => el.getAnimations({ subtree: true }).length))
      .toBe(0);
  });
}
