import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent, EventPayload } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

async function fixture(page: Page, completedTurns = 42) {
  const connectionId = randomUUID();
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '发送方式与会话导航',
    autoTitle: false,
    projectPath: 'D:\\工作\\客户端',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: randomUUID(), status: 'running', connectionId },
  };
  const events: SessionEvent[] = [];
  const add = (runId: string, payload: EventPayload) => {
    const event: SessionEvent = {
      sessionId: session.id,
      runId,
      sequence: events.length + 1,
      createdAt: now,
      payload,
    };
    events.push(event);
    return event;
  };
  for (let i = 1; i <= completedTurns; i++) {
    const runId = randomUUID();
    add(runId, {
      type: 'message.user',
      messageId: randomUUID(),
      text:
        i === 20 ? '后续如果 Claude Code 更新，会影响吗？' : `第 ${i} 条问题：检查客户端交互细节`,
      scenario: 'chat',
    });
    add(runId, {
      type: 'text.delta',
      messageId: randomUUID(),
      text: `第 ${i} 条回复：终端使用官方 Claude Code，客户端负责消息发送和界面呈现。\n\n本次检查包含输入方式、消息定位、窄窗口排版和状态提示，确保每一项都能直接验证。`,
    });
    add(runId, { type: 'run.status', status: 'completed', connectionId });
  }
  add(session.activeRun!.id, {
    type: 'message.user',
    messageId: randomUUID(),
    text: '继续完善这两个客户端功能',
    scenario: 'chat',
  });
  add(session.activeRun!.id, { type: 'run.status', status: 'running', connectionId });
  const requests: { text: string; requestId: string }[] = [];
  const moves: string[] = [];
  let send: (value: unknown) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18892/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
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
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      if (message.type === 'session.move') {
        moves.push(message.projectPath);
        session.projectPath = message.projectPath;
        send({ type: 'session.updated', session });
      }
      if (message.type === 'message.send') {
        requests.push({ text: message.text, requestId: message.requestId });
        if (!session.activeRun)
          session.activeRun = { id: randomUUID(), status: 'running', connectionId };
        send({ type: 'session.updated', session });
        send({
          type: 'session.event',
          event: add(session.activeRun.id, {
            type: 'message.user',
            messageId: message.requestId,
            text: message.text,
            scenario: 'chat',
          }),
        });
        send({
          type: 'session.event',
          event: add(session.activeRun.id, { type: 'run.status', status: 'running', connectionId }),
        });
      }
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.addInitScript(
    () =>
      !localStorage.getItem('proxy-prefs') &&
      localStorage.setItem('proxy-prefs', JSON.stringify({ theme: 'dark' })),
  );
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-follow-up-credential-long-enough');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  const finish = (status: 'completed' | 'cancelled' | 'failed' = 'completed') => {
    const runId = session.activeRun!.id;
    session.activeRun = null;
    send({
      type: 'session.event',
      event: add(runId, { type: 'run.status', status, connectionId }),
    });
    send({ type: 'session.updated', session });
  };
  const output = (text: string) =>
    send({
      type: 'session.event',
      event: add(session.activeRun!.id, { type: 'text.delta', messageId: randomUUID(), text }),
    });
  return { requests, finish, output, moves };
}

test('busy Enter and its opposite preserve queue order, edits and immediate steering', async ({
  page,
}) => {
  const { requests, finish } = await fixture(page);
  const box = page.getByRole('textbox', { name: '消息', exact: true });
  const queue = page.getByRole('region', { name: '待发送消息' });
  const mode = page.getByLabel('繁忙时的发送行为');
  await expect(mode).toHaveValue('queue');
  await box.fill('排队第一条');
  await box.press('Enter');
  await expect(queue).toContainText('排队第一条');
  expect(requests).toHaveLength(0);
  await box.fill('马上补充');
  await box.press('Control+Enter');
  await expect.poll(() => requests.map((request) => request.text)).toEqual(['马上补充']);
  await mode.selectOption('steer');
  await box.fill('排队第二条');
  await box.press('Control+Enter');
  await expect(queue).toContainText('排队第二条');
  await box.fill('默认插话');
  await box.press('Enter');
  await expect
    .poll(() => requests.map((request) => request.text))
    .toEqual(['马上补充', '默认插话']);
  await queue.getByRole('button', { name: '编辑排队消息', exact: true }).first().click();
  await queue.getByRole('textbox', { name: '编辑排队消息', exact: true }).fill('编辑后的第一条');
  finish();
  await expect(queue).toContainText('排队已暂停');
  expect(requests).toHaveLength(2);
  await queue.getByRole('button', { name: '保存排队消息' }).click();
  await queue.getByRole('button', { name: '继续排队' }).click();
  await expect.poll(() => requests.at(-1)?.text).toBe('编辑后的第一条');
  await expect(queue).not.toContainText('编辑后的第一条');
  await expect(queue).toContainText('排队第二条');
  finish();
  await expect.poll(() => requests.at(-1)?.text).toBe('排队第二条');
  await expect(queue).toHaveCount(0);
  await box.fill('可移除的消息');
  await box.press('Control+Enter');
  await queue.getByRole('button', { name: '移除排队消息' }).click();
  await expect(queue).toHaveCount(0);
});

test('project entry sits beside search and moves sessions through a menu below it, including narrow windows', async ({
  page,
}) => {
  const longName = '需要省略显示的长项目名称'.repeat(4);
  const target = `D:\\工作\\${longName}`;
  await page.addInitScript(
    (project) =>
      localStorage.setItem('proxy-projects', JSON.stringify(['D:\\工作\\客户端', project])),
    target,
  );
  const { finish, moves } = await fixture(page);
  const entry = page.getByRole('button', { name: '会话所在的项目', exact: true });
  const search = page.getByRole('button', { name: '打开对话查找', exact: true });
  await expect(
    page.locator('.composer-area').getByRole('button', { name: '会话所在的项目', exact: true }),
  ).toHaveCount(0);
  await expect(entry).toBeDisabled();
  finish();
  await expect(entry).toBeEnabled();
  await entry.click();
  const menu = page.getByRole('menu', { name: '会话所在的项目', exact: true });
  await expect(entry).toHaveAttribute('aria-expanded', 'true');
  const entryBounds = await entry.boundingBox();
  const menuBounds = await menu.boundingBox();
  expect(menuBounds!.y).toBeGreaterThanOrEqual(entryBounds!.y + entryBounds!.height);
  await menu.getByRole('menuitemradio', { name: longName, exact: true }).click();
  await expect.poll(() => moves).toEqual([target]);
  await expect(entry).toHaveText(longName);
  await expect(entry).toHaveAttribute('title', target);
  await expect(entry).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 390, height: 800 });
  const narrowEntry = await entry.boundingBox();
  const searchBounds = await search.boundingBox();
  expect(narrowEntry!.x + narrowEntry!.width).toBeLessThanOrEqual(searchBounds!.x);
  expect(Math.abs(narrowEntry!.y - searchBounds!.y)).toBeLessThan(4);
  await entry.click();
  await expect(menu).toBeVisible();
  const narrowMenu = await menu.boundingBox();
  expect(narrowMenu!.x).toBeGreaterThanOrEqual(0);
  expect(narrowMenu!.x + narrowMenu!.width).toBeLessThanOrEqual(390);
  await menu.press('Escape');
  await expect(menu).toHaveCount(0);
  await search.click();
  await expect(page.locator('.conversation-find')).toBeVisible();
});

test('turn rail previews, bookmarks and navigates without being pulled back by new output', async ({
  page,
}) => {
  const { requests, output } = await fixture(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const rail = page.getByRole('navigation', { name: '对话导航' });
  const mark = rail.getByRole('button', { name: '跳转到第 20 条消息', exact: true });
  await expect(rail.locator('.turn-mark')).toHaveCount(43);
  const expectCompact = async () => {
    await expect
      .poll(() =>
        rail
          .locator('.turn-mark span')
          .evaluateAll((ticks) =>
            ticks.every((tick) => Math.round(tick.getBoundingClientRect().width) === 6),
          ),
      )
      .toBe(true);
  };
  await expectCompact();
  await mark.hover();
  const expectWave = async (peak: number) => {
    for (let offset = -4; offset <= 4; offset++) {
      const tick = rail
        .getByRole('button', { name: `跳转到第 ${peak + offset} 条消息`, exact: true })
        .locator('span');
      await expect
        .poll(async () => Math.round((await tick.boundingBox())!.width))
        .toBe([24, 18, 12, 8, 6][Math.abs(offset)]);
    }
  };
  await expectWave(20);
  // Moving inside one mark must not repeatedly measure layout or update the preview.
  expect(
    await mark.evaluate(async (element) => {
      const original = element.getBoundingClientRect;
      let reads = 0;
      element.getBoundingClientRect = function () {
        reads++;
        return original.call(this);
      };
      try {
        for (let i = 0; i < 60; i++)
          element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        await new Promise(requestAnimationFrame);
        return reads;
      } finally {
        element.getBoundingClientRect = original;
      }
    }),
  ).toBe(0);
  const preview = rail.locator('.turn-preview');
  await expect(preview).toContainText('后续如果 Claude Code 更新，会影响吗？');
  await expect(preview).toContainText('第 20 条回复');
  await preview.getByRole('button', { name: '添加消息书签' }).click();
  await expect(mark).toHaveAttribute('data-bookmarked', 'true');
  await expectWave(20);
  await preview.hover();
  await expectWave(20);
  await mark.click();
  await expect(mark).toHaveAttribute('aria-current', 'true');
  await page.mouse.move(500, 120);
  await expect(mark).toBeFocused();
  await expectCompact();
  await expect(preview).toHaveCount(0);
  const question = page
    .locator('.message.user')
    .filter({ hasText: '后续如果 Claude Code 更新，会影响吗？' });
  await expect(question).toBeInViewport();
  output('最新输出仍然继续，正在逐项落实交互细节。');
  await expect(page.locator('.transcript')).toContainText('最新输出仍然继续');
  await expectCompact();
  await expect(question).toBeInViewport();
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('先检查布局，再整理测试结果');
  await page.getByRole('button', { name: '排队发送', exact: true }).click();
  expect(requests).toHaveLength(0);
  await expect(question).toBeInViewport();
  await mark.hover();
  const folder = resolve(screenshots, '发送与导航');
  mkdirSync(folder, { recursive: true });
  const queuedBounds = await page.locator('.follow-up-queue').boundingBox();
  const composerBounds = await page.locator('form.composer').boundingBox();
  expect(queuedBounds!.x).toBeGreaterThan(composerBounds!.x);
  expect(queuedBounds!.width).toBeLessThan(composerBounds!.width);
  expect(queuedBounds!.y + queuedBounds!.height - composerBounds!.y).toBeCloseTo(14, 0);
  const rowBounds = await page.locator('.follow-up-queue li').first().boundingBox();
  expect(rowBounds!.y + rowBounds!.height).toBeLessThanOrEqual(composerBounds!.y);
  await page
    .locator('.composer-area')
    .screenshot({ path: resolve(folder, '03-输入框-贴合排队条.png') });
  await page.screenshot({ path: resolve(folder, '01-完整窗口-排队与导航.png') });
  await page.setViewportSize({ width: 390, height: 800 });
  // The sidebar becomes a closed overlay at this width.
  await mark.focus();
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  await page.screenshot({ path: resolve(folder, '02-窄窗口-导航预览.png') });
  await page
    .locator('.composer-area')
    .screenshot({ path: resolve(folder, '04-窄窗口-贴合排队条.png') });
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await mark.focus();
  await mark.press('ArrowDown');
  await expect(rail.getByRole('button', { name: '跳转到第 21 条消息', exact: true })).toBeFocused();
  await expectWave(21);
  // Returning to the transcript collapses every mark, including the current reading position.
  await page.getByRole('textbox', { name: '消息', exact: true }).focus();
  await page.mouse.move(500, 120);
  await expectCompact();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mark.locator('span')).toHaveCSS('transition-duration', '0s');
});

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test('turn rail hover lifecycle in ' + theme + ' at ' + width + 'px', async ({ page }) => {
      await page.addInitScript((theme) => {
        localStorage.setItem('proxy-prefs', JSON.stringify({ theme }));
      }, theme);
      await fixture(page, 8);
      await page.setViewportSize({ width, height: 800 });
      const nav = page.locator('.turn-navigation');
      const mark = nav.locator('.turn-mark').nth(4);
      const compact = async () => {
        await expect
          .poll(() =>
            nav
              .locator('.turn-mark span')
              .evaluateAll((ticks) =>
                ticks.every((tick) => Math.round(tick.getBoundingClientRect().width) === 6),
              ),
          )
          .toBe(true);
        await expect(nav.locator('.turn-preview')).toHaveCount(0);
      };
      await compact();
      await page.screenshot({
        animations: 'disabled',
        path: resolve(screenshots, 'turn-rail-' + theme + '-' + width + '-idle.png'),
      });
      await mark.hover();
      await expect
        .poll(async () => Math.round((await mark.locator('span').boundingBox())!.width))
        .toBe(24);
      const preview = nav.locator('.turn-preview');
      await expect(preview).toBeVisible();
      const bounds = (await preview.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        animations: 'disabled',
        path: resolve(screenshots, 'turn-rail-' + theme + '-' + width + '-hover.png'),
      });
      await page.mouse.move(100, 100);
      await compact();
      await mark.focus();
      await expect(preview).toBeVisible();
      await mark.press('Escape');
      await compact();
      await mark.hover();
      await expect(preview).toBeVisible();
      await page.mouse.move(100, 100);
      await compact();
    });
  }
}

test('sidebar divider clamps, cancels and remembers width without disturbing chat', async ({
  page,
}) => {
  await fixture(page);
  const divider = page.getByRole('separator', { name: '调整侧栏宽度' });
  const sidebar = page.locator('.shell > .sidebar');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  const width = () =>
    sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  const saved = () => page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).sidebarWidth);
  const start = async () => {
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await page.mouse.down();
  };
  await composer.fill('拖动侧栏时保留这份草稿');
  await expect.poll(width).toBe(284);
  await start();
  await page.mouse.move(1000, 250, { steps: 12 });
  await expect.poll(width).toBe(420);
  // Persist only once the drag ends, not on each pointer movement.
  expect(await saved()).toBeUndefined();
  await page.mouse.up();
  await expect.poll(saved).toBe(420);
  await expect(composer).toHaveValue('拖动侧栏时保留这份草稿');
  await expect(page.locator('.shell')).not.toHaveAttribute('data-sidebar-resizing');
  await divider.hover();
  const folder = resolve(screenshots, '发送与导航');
  mkdirSync(folder, { recursive: true });
  await page.screenshot({ path: resolve(folder, '08-侧栏拖动-420px.png') });
  await start();
  await page.mouse.move(80, 250, { steps: 8 });
  await expect.poll(width).toBe(264);
  await page.mouse.up();
  await expect.poll(saved).toBe(264);
  await start();
  await page.mouse.move(430, 250, { steps: 4 });
  await expect.poll(width).toBeGreaterThan(264);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(width).toBe(264);
  await expect.poll(saved).toBe(264);
  await expect(page.locator('.shell')).not.toHaveAttribute('data-sidebar-resizing');
  await divider.focus();
  await divider.press('End');
  await expect.poll(width).toBe(420);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(width).toBe(348);
  await expect(divider).toHaveAttribute('aria-valuemax', '348');
  expect((await page.locator('main.workspace').boundingBox())!.width).toBeGreaterThanOrEqual(400);
  expect(await saved()).toBe(420);
  await divider.click();
  expect(await saved()).toBe(420);
  await expect.poll(width).toBe(348);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(width).toBe(420);
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeHidden();
  await page.keyboard.press('Control+b');
  await expect.poll(width).toBe(420);
  await divider.dblclick();
  await expect.poll(width).toBe(284);
  await divider.press('ArrowRight');
  await expect.poll(width).toBe(294);
  await page.reload();
  if (await page.getByLabel('服务地址', { exact: true }).isVisible()) {
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-only-follow-up-credential-long-enough');
    await page.getByRole('button', { name: '连接', exact: true }).click();
  }
  await expect.poll(width).toBe(294);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(divider).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('sidebar drag coalesces pointer bursts and releases cleanly when interrupted', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { output } = await fixture(page, 180);
  const divider = page.getByRole('separator', { name: '调整侧栏宽度' });
  const shell = page.locator('.shell');
  const sidebar = page.locator('.shell > .sidebar');
  const saved = () => page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).sidebarWidth);
  const width = () =>
    sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width));
  const start = async () => {
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 150);
    await page.mouse.down();
  };
  await page.getByRole('button', { name: '跳转到第 80 条消息', exact: true }).click();
  const question = page.locator('.message.user').filter({ hasText: '第 80 条问题' });
  await expect(question).toBeInViewport();
  await start();
  const writes = await divider.evaluate(async (element) => {
    const shell = element.closest<HTMLElement>('.shell')!;
    const original = CSSStyleDeclaration.prototype.setProperty;
    let count = 0;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
      if (this === shell.style && name === '--sidebar-width') count++;
      return original.call(this, name, value, priority);
    };
    try {
      for (let i = 0; i < 1000; i++)
        element.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 1,
            clientX: 350 + (i % 50),
          }),
        );
      await new Promise(requestAnimationFrame);
      return count;
    } finally {
      CSSStyleDeclaration.prototype.setProperty = original;
    }
  });
  expect(writes).toBe(1);
  expect(await saved()).toBeUndefined();
  await expect(question).toBeInViewport();
  output('拖动时回复仍然继续输出');
  await expect(page.locator('.transcript')).toContainText('拖动时回复仍然继续输出');
  await expect(question).toBeInViewport();
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeHidden();
  await expect(shell).not.toHaveAttribute('data-sidebar-resizing');
  await page.mouse.up();
  await page.keyboard.press('Control+b');
  await expect.poll(width).toBe(284);
  await start();
  await page.mouse.move(430, 250);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(shell).not.toHaveAttribute('data-sidebar-resizing');
  await page.mouse.up();
  await expect.poll(width).toBe(284);
  await start();
  await page.mouse.move(430, 250);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(shell).not.toHaveAttribute('data-sidebar-resizing');
  await page.mouse.up();
  await expect.poll(width).toBe(284);
  expect(await saved()).toBeUndefined();
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await composer.fill('取消拖动后可以正常输入');
  await expect(composer).toHaveValue('取消拖动后可以正常输入');
  expect(errors).toEqual([]);
});

test('long turn rail keeps preview and keyboard navigation aligned while scrolling', async ({
  page,
}) => {
  await fixture(page, 180);
  const nav = page.getByRole('navigation', { name: '对话导航' });
  const rail = nav.locator('.turn-navigation-rail');
  const marks = nav.locator('.turn-mark');
  await expect(marks).toHaveCount(181);
  expect(await rail.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const middle = marks.nth(90);
  await middle.hover();
  await expect(nav.locator('.turn-preview')).toContainText('第 91 条问题');
  await rail.evaluate((element) => {
    element.scrollTop = 0;
  });
  // Scrolling may enter another mark under the stationary pointer; never keep the old preview.
  await expect
    .poll(() => nav.locator('.turn-preview').allTextContents())
    .not.toEqual([expect.stringContaining('第 91 条问题')]);
  // Leaving the rail reveals the reading marker again, even if active did not change.
  await page.mouse.move(500, 120);
  await expect(marks.last()).toBeInViewport();
  await marks.last().focus();
  await marks.last().press('Home');
  await expect(marks.first()).toBeFocused();
  await expect(marks.first()).toBeInViewport();
  await expect(nav.locator('.turn-preview')).toContainText('第 1 条问题');
  await marks.first().press('End');
  await expect(marks.last()).toBeFocused();
  await expect(marks.last()).toBeInViewport();
  await expect(nav.locator('.turn-preview')).toContainText('继续完善这两个客户端功能');
  await marks.last().press('Escape');
  await expect(nav.locator('.turn-preview')).toHaveCount(0);
});

test('compact queue keeps multiple rows operable and explains attachment length errors while editing', async ({
  page,
}) => {
  const { requests } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 800 });
  const box = page.getByRole('textbox', { name: '消息', exact: true });
  const queue = page.getByRole('region', { name: '待发送消息' });
  for (let i = 1; i <= 7; i++) {
    await box.fill(`第 ${i} 条很长的排队消息，用于确认窄窗口下正文省略时右侧按钮仍然可以操作`);
    await box.press('Enter');
  }
  const path = 'D:\\工作\\截图.png';
  await box.fill(`附带文件的检查\n"${path}"`);
  await box.press('Enter');
  const list = queue.locator('ol');
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await queue
    .locator('li')
    .last()
    .getByRole('button', { name: '编辑排队消息', exact: true })
    .click();
  const editor = queue.getByRole('textbox', { name: '编辑排队消息', exact: true });
  await expect(editor).toBeFocused();
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(queue.getByRole('button', { name: '继续排队' })).toBeEnabled();
  await queue
    .locator('li')
    .last()
    .getByRole('button', { name: '编辑排队消息', exact: true })
    .click();
  await editor.fill('字'.repeat(16000));
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  await expect(queue.getByRole('alert')).toContainText('消息过长（含附件）');
  await expect(queue.getByRole('button', { name: '保存排队消息' })).toBeDisabled();
  await editor.fill('附件正文已更新');
  await expect(queue.getByRole('alert')).toHaveCount(0);
  await queue.getByRole('button', { name: '保存排队消息' }).click();
  const last = queue.locator('li').last();
  await expect(last).toContainText('1 个附件');
  const action = last.getByRole('button', { name: '插话发送此消息' });
  await action.scrollIntoViewIfNeeded();
  const actionBounds = await action.boundingBox();
  const composerBounds = await page.locator('form.composer').boundingBox();
  expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(composerBounds!.y);
  const folder = resolve(screenshots, '发送与导航');
  mkdirSync(folder, { recursive: true });
  await page
    .locator('.composer-area')
    .screenshot({ path: resolve(folder, '05-多条排队-暂停与附件.png') });
  await action.click();
  await expect
    .poll(() => requests.map((request) => request.text))
    .toEqual([`附件正文已更新\n"${path}"`]);
  await expect(queue.locator('li')).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
