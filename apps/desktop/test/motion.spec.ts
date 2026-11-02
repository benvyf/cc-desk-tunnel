import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSession, login, send, settled } from './helpers.ts';

test('narrow standalone settings remain interactive while connected settings follow the sidebar toggle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/');
  await page.keyboard.press('Control+Comma');
  await expect(page.locator('.settings-only .sidebar')).not.toHaveAttribute('inert');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(page.locator('.page-title')).toHaveText('快捷键');
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await login(page);
  // Below 600px even the folded rail gives way: the account is reached in the column, laid over the page.
  await expect(page.locator('.rail')).toBeHidden();
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.locator('.shell .sidebar')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await expect(page.locator('.shell .sidebar')).not.toHaveAttribute('inert');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(page.locator('.page-title')).toHaveText('快捷键');
});

test('menus finish their exit without accepting input and can reopen during exit', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--cds-dur-base', '800ms'));
  const trigger = page.getByRole('button', { name: '设置与账号', exact: true });
  await trigger.click();
  await expect(page.getByRole('menu', { name: '设置与账号' })).toBeVisible();
  await page.keyboard.press('Escape');
  const exiting = page.locator('.motion-presence[data-state="exit"]');
  await expect(exiting).toHaveAttribute('inert', '');
  await expect(exiting).toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('menu', { name: '设置与账号' })).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole('menu', { name: '设置与账号' })).toBeVisible();
  await page.waitForTimeout(850);
  await expect(page.getByRole('menu', { name: '设置与账号' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.menu')).toHaveCount(0);
});

test('sidebar closes inertly, retains search and fits both desktop and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (width === 390) await expect(expand).toBeVisible();
    if (await expand.isVisible()) await expand.click();
    await expect(page.locator('.sidebar')).toBeVisible();
    const search = page.getByLabel('搜索会话', { exact: true });
    if (!(await search.isVisible()))
      await page.getByRole('button', { name: '搜索', exact: true }).click();
    await search.fill('动效状态保留');
    await page.getByRole('banner').getByRole('button', { name: '收起侧栏', exact: true }).click();
    await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
    await expect(page.locator('.sidebar')).toHaveCSS('visibility', 'hidden');
    await expand.click();
    await expect(search).toHaveValue('动效状态保留');
    await expect(page.locator('.sidebar')).not.toHaveAttribute('inert');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('native dialogs become inert during exit and return focus after closing', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--cds-dur-base', '800ms'));
  const trigger = page.getByRole('button', { name: '添加项目', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const before = (await dialog.boundingBox())!;
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.motion-presence[data-state="exit"] dialog')).toHaveAttribute(
    'inert',
    '',
  );
  const after = (await page.locator('dialog').boundingBox())!;
  expect(after.width).toBeCloseTo(before.width, 2);
  expect(after.height).toBeCloseTo(before.height, 2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(7);
  expect(await page.locator(':modal').count()).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await trigger.click();
  await expect(page.locator('dialog:modal')).toHaveCount(1);
  await page.locator('dialog input').first().fill('D:\\motion-reopen');
  await page.waitForTimeout(850);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('dialog input').first()).toHaveValue('D:\\motion-reopen');
  await expect(page.locator('dialog input').first()).toBeFocused();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a tall dialog keeps its dimensions and scrolling while exiting in a short narrow window', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.evaluate((element) => {
    const content = document.createElement('p');
    content.style.height = '1000px';
    content.textContent = '长内容的对话框';
    element.append(content);
    document.documentElement.style.setProperty('--cds-dur-base', '800ms');
  });
  const before = (await dialog.boundingBox())!;
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const ghost = page.locator('.motion-presence[data-state="exit"] dialog');
  await expect(ghost).toHaveAttribute('inert', '');
  const after = (await ghost.boundingBox())!;
  expect(after.width).toBeCloseTo(before.width, 2);
  expect(after.height).toBeCloseTo(before.height, 2);
  await expect(ghost).toHaveCSS('overflow-y', 'auto');
  expect(after.height).toBeLessThan(468.1);
});

test('sidebar motion preserves the viewport coordinates of the session tooltip', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  // The card comes only for a title the row cuts off.
  await createSession(page, '侧栏坐标：一个长到在侧栏里一定会被截断显示的会话标题');
  await expect(page.locator('.sidebar')).toHaveCSS('translate', 'none');
  const row = page.locator('.session-row.selected');
  await row.hover();
  const card = page.getByRole('tooltip');
  await expect(card).toBeVisible();
  const sidebar = (await page.locator('.sidebar').boundingBox())!;
  const tooltip = (await card.boundingBox())!;
  const session = (await row.boundingBox())!;
  expect(tooltip.x).toBe(sidebar.x + sidebar.width + 8);
  expect(tooltip.y).toBe(session.y);
});

test('a usage card opened below its trigger keeps its position throughout exit', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ stats: { enabled: true } })),
  );
  await page.goto('/');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const statsPath = '/src/TurnStats.tsx';
    const samplesPath = '/src/turnStats.ts';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { default: TurnStats } = await import(statsPath);
    const { sampleStats } = await import(samplesPath);
    const host = document.createElement('main');
    host.className = 'conversation';
    host.style.cssText = 'position:fixed;inset:40px 0 0;padding:10px';
    document.body.replaceChildren(host);
    document.documentElement.style.setProperty('--cds-dur-base', '800ms');
    createRoot(host).render(React.createElement(TurnStats, { stats: sampleStats }));
  });
  await page.locator('.turn-stats > button').click();
  const card = page.getByRole('dialog', { name: '本轮用量' });
  await expect(card).toHaveClass(/below/);
  const before = (await card.boundingBox())!;
  await page.keyboard.press('Escape');
  const ghost = page.locator('.motion-presence[data-state="exit"] .turn-stats-card');
  await expect(ghost).toHaveClass(/below/);
  const after = (await ghost.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 2);
  expect(after.y).toBeCloseTo(before.y, 2);
});

test('streaming reveals appended prose without fading history or changing Markdown text', async ({
  page,
}) => {
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
    document.body.replaceChildren(host);
    const root = createRoot(host);
    (
      window as unknown as { renderMotionText: (text: string, streaming: boolean) => void }
    ).renderMotionText = (text, streaming) =>
      root.render(React.createElement(RichText, { text, streaming }));
  });
  const render = (text: string, streaming: boolean) =>
    page.evaluate(
      ({ text, streaming }) => {
        (
          window as unknown as { renderMotionText: (text: string, streaming: boolean) => void }
        ).renderMotionText(text, streaming);
      },
      { text, streaming },
    );
  await render('已经显示的正文。', false);
  const paragraph = page.locator('main > p');
  await expect(paragraph).toHaveText('已经显示的正文。');
  await render('已经显示的正文。', true);
  await render('已经显示的正文。追加第一段。', true);
  await expect(page.locator('.stream-reveal')).toHaveText('追加第一段。');
  await expect(paragraph).toHaveCSS('opacity', '1');
  await expect(paragraph).toHaveText('已经显示的正文。追加第一段。');
  await render(
    '已经显示的正文。追加第一段。追加第二段。\n\n```js\nconst n = 1;\n```\n\n公式 $x^2$ 与 **强调**，内联 `code`。\n\n| 名称 | 数量 |\n| --- | --- |\n| 项目 | 2 |',
    true,
  );
  await expect(paragraph.first()).toHaveText('已经显示的正文。追加第一段。追加第二段。');
  await expect(page.locator('pre code')).toHaveText('const n = 1;\n');
  await expect(page.locator('strong')).toHaveText('强调');
  await expect(page.locator('.katex')).toBeVisible();
  await expect(page.locator('table')).toContainText('项目');
  await expect(page.locator('p code')).toHaveText('code');
  await expect(
    page.locator('code .stream-reveal, .katex .stream-reveal, table .stream-reveal'),
  ).toHaveCount(0);
  await expect(paragraph.first().locator('.stream-reveal')).toHaveText('追加第二段。');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.stream-reveal')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await render('连续追加：', true);
  await expect(paragraph).toHaveText('连续追加：');
  const burst = await page.evaluate(async () => {
    const { renderMotionText } = window as unknown as {
      renderMotionText: (text: string, streaming: boolean) => void;
    };
    let text = '连续追加：';
    let maxSpans = 0;
    for (let index = 0; index < 60; index++) {
      text += `片段${index}。`;
      renderMotionText(text, true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      maxSpans = Math.max(maxSpans, document.querySelectorAll('.stream-reveal').length);
    }
    return { text, maxSpans };
  });
  await expect(paragraph).toHaveText(burst.text);
  expect(burst.maxSpans).toBeLessThanOrEqual(1);
  await expect(paragraph.locator('.stream-reveal')).toHaveText('片段59。');
  await render('已经完成的回复。', false);
  await expect(page.locator('.stream-reveal')).toHaveCount(0);
  await expect(paragraph).toHaveText('已经完成的回复。');
});

// Motion pass M1 (2026-11-02): surfaces unfold from their control without changing size, leave faster than they
// came, and give the focus back to what opened them.
test('menus unfold in place from their control and hand the focus back on Esc, Tab and choosing', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const trigger = page.getByRole('button', { name: '设置与账号', exact: true });
  await page.evaluate(() => document.documentElement.style.setProperty('--cds-dur-base', '800ms'));
  await trigger.click();
  const menu = page.getByRole('menu', { name: '设置与账号' });
  await expect(menu).toBeVisible();
  // Unfolding is a clip: the box is already where and as large as it ends.
  const opening = await menu.evaluate((element) => ({
    names: element.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
    box: element.getBoundingClientRect().toJSON(),
    placement: (element as HTMLElement).dataset.placement,
  }));
  expect(opening.names).toEqual(expect.arrayContaining(['motion-fade-in', 'motion-unfold']));
  expect(opening.placement).toBe('above');
  await menu.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  expect(await menu.evaluate((element) => element.getBoundingClientRect().toJSON())).toEqual(
    opening.box,
  );
  await expect(menu).toHaveCSS('clip-path', 'none');
  // Home and End reach the ends of the list.
  const items = menu.locator('button:not(:disabled)');
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  // Esc puts the menu away and the focus back on its button; the exit is shorter than the entrance.
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  const exit = await page
    .locator('.motion-presence[data-state="exit"] > .menu')
    .evaluate((element) => element.getAnimations()[0]?.effect?.getTiming().duration);
  expect(exit).toBe(480);
  // Tab leaves the menu from its button.
  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  // A right-clicked session row gets the focus back as well.
  await createSession(page, '菜单焦点');
  const row = page.locator('.session-row.selected .session-select');
  await row.focus();
  await page.locator('.session-row.selected').click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
});

test('the column over a narrow window closes with Esc and returns the focus to its button', async ({
  page,
}) => {
  await page.setViewportSize({ width: 680, height: 800 });
  await page.goto('/');
  await login(page);
  const open = page.getByRole('button', { name: '展开会话列表', exact: true }).first();
  await open.click();
  await expect(page.locator('.sidebar-shade')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.shell')).toHaveClass(/side-closed/);
  await expect(open).toBeFocused();
  await open.click();
  await page.locator('.sidebar-shade').click({ position: { x: 300, y: 300 } });
  await expect(page.locator('.shell')).toHaveClass(/side-closed/);
  await expect(open).toBeFocused();
});

test('find and “回到底部” come and go with motion and leave the focus somewhere useful', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '动效查找');
  await send(page, Array.from({ length: 90 }, (_, index) => `第 ${index + 1} 行`).join('\n'));
  await settled(page);
  const input = page.getByRole('textbox', { name: '消息' });
  await input.focus();
  await page.keyboard.press('Control+f');
  const find = page.getByRole('search', { name: '对话内查找' });
  await expect(find).toBeVisible();
  expect(
    await find.evaluate((element) =>
      element.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
    ),
  ).toContain('motion-unfold');
  await page.keyboard.press('Escape');
  // Back where the reader was typing, and no ring drawn around the conversation.
  await expect(input).toBeFocused();
  await expect(page.locator('.conversation-find')).toHaveCount(0);
  await page.locator('.workspace .conversation').hover();
  await page.mouse.wheel(0, -1500);
  const back = page.getByRole('button', { name: '回到底部', exact: true });
  await expect(back).toBeVisible();
  expect(
    await back.evaluate((element) =>
      element.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
    ),
  ).toContain('motion-rise');
  await back.focus();
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await expect(back).toHaveCount(0);
  // Opened from the button, the find box gives the focus to the conversation without a keyboard ring.
  await page.getByRole('button', { name: '打开对话查找', exact: true }).click();
  await page.getByRole('button', { name: '关闭查找（Esc）', exact: true }).click();
  const conversation = page.locator('.workspace .conversation');
  await expect(page.getByRole('button', { name: '打开对话查找', exact: true })).toBeFocused();
  await page.keyboard.press('Control+f');
  await page.keyboard.press('Escape');
  expect(await conversation.evaluate((element) => element.matches(':focus-visible'))).toBe(false);
});

test('the session card fades in and out instead of popping', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '悬停卡片：一个长到在侧栏里一定会被截断显示的会话标题');
  const row = page.locator('.session-row.selected');
  await row.hover();
  const card = page.getByRole('tooltip');
  await expect(card).toBeVisible();
  await page.mouse.move(900, 400);
  await expect(page.locator('.motion-presence[data-state="exit"] > .session-card')).toHaveCount(1);
  await expect(page.locator('.session-card')).toHaveCount(0);
});

// Motion pass M2 (2026-11-02): the window's columns glide instead of jumping, the preview slides in and out, folds
// grow to their height, and the conversation fades back in after the settings.
const columnTransition = (page: Page) =>
  page.locator('.shell').evaluate((shell) =>
    shell
      .getAnimations()
      .filter(
        (animation): animation is CSSTransition =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === 'grid-template-columns',
      )
      .map((animation) => animation.effect?.getTiming().duration),
  );

test('folding the side column glides the page over instead of jumping', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--cds-dur-sheet', '1200ms'),
  );
  const workspace = page.locator('main.workspace');
  const start = (await workspace.boundingBox())!.x;
  await page.getByRole('banner').getByRole('button', { name: '收起侧栏', exact: true }).click();
  expect(await columnTransition(page)).toEqual([1200]);
  // Part of the way: neither where it was nor where it is going.
  await page.waitForTimeout(150);
  const during = (await workspace.boundingBox())!.x;
  expect(during).toBeLessThan(start - 4);
  expect(during).toBeGreaterThan(56);
  await page
    .locator('.shell')
    .evaluate((shell) => Promise.all(shell.getAnimations().map((animation) => animation.finished)));
  expect(Math.round((await workspace.boundingBox())!.x)).toBe(52);
  // Dragging the column's edge follows the pointer at once.
  await page.getByRole('button', { name: '展开会话列表', exact: true }).first().click();
  await page
    .locator('.shell')
    .evaluate((shell) => Promise.all(shell.getAnimations().map((animation) => animation.finished)));
  await page.locator('.shell').evaluate((shell) => shell.setAttribute('data-sidebar-resizing', ''));
  await page.evaluate(() => document.documentElement.style.setProperty('--sidebar-width', '320px'));
  expect(await columnTransition(page)).toEqual([]);
});

test('the preview slides in at its own width and slides out before it goes', async ({ page }) => {
  await page.goto('/test/fixtures/preview-sidebar.html');
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--cds-dur-sheet', '1200ms'),
  );
  await page.getByRole('button', { name: '打开文档', exact: true }).click();
  const pane = page.getByRole('complementary', { name: '文件与网站预览' });
  await expect(pane).toBeVisible();
  expect(await columnTransition(page)).toEqual([1200]);
  await page.waitForTimeout(150);
  const during = (await pane.boundingBox())!;
  // Already as wide as it will be, coming in from beyond the right edge.
  expect(during.x + during.width).toBeGreaterThan(1280 + 4);
  await page
    .locator('.shell')
    .evaluate((shell) => Promise.all(shell.getAnimations().map((animation) => animation.finished)));
  const rest = (await pane.boundingBox())!;
  expect(Math.round(rest.width)).toBe(Math.round(during.width));
  expect(Math.round(rest.x + rest.width)).toBe(1280);
  await page.getByRole('button', { name: '预览开关', exact: true }).click();
  // Leaving: still there, inert, going out the right edge; then gone.
  const leaving = page.locator('.preview-sidebar[data-leaving]');
  await expect(leaving).toHaveAttribute('inert', '');
  await expect(page.getByRole('complementary', { name: '文件与网站预览' })).toHaveCount(0);
  await expect(page.locator('.preview-sidebar')).toHaveCount(0);
});

test('a fold of steps grows to its height and the conversation fades back after the settings', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '折叠动效');
  await send(page, '查看工具', 'tool');
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await settled(page);
  const fold = page.locator('.turn-process');
  await expect(fold).not.toHaveAttribute('open');
  await page.evaluate(() =>
    document.documentElement.style.setProperty('--cds-dur-sheet', '1200ms'),
  );
  await fold.locator(':scope > summary').click();
  await expect(fold).toHaveAttribute('open', '');
  // (Chromium does not list ::details-content transitions in getAnimations(); the height tells.)
  const height = () => fold.evaluate((details) => details.getBoundingClientRect().height);
  await page.waitForTimeout(100);
  const opening = await height();
  await page.waitForTimeout(1300);
  const opened = await height();
  expect(opened - opening).toBeGreaterThan(8);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.locator('.page-title')).toBeVisible();
  await page
    .getByRole('button', { name: /返回会话/ })
    .first()
    .click();
  const names = await page
    .locator('main.workspace')
    .evaluate((main) =>
      main.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
    );
  expect(names).toContain('motion-fade-in');
});

// Motion pass M3 (2026-11-03): feedback at one pace, every control answers a press, the switch does not bounce,
// and with reduced motion surfaces still fade briefly while nothing moves.
test('hover is feedback at 60ms and every control answers a press', async ({ page }) => {
  await page.goto('/');
  await login(page);
  const row = page.locator('.sidebar .side-action.new-session');
  const durations = (locator: ReturnType<Page['locator']>) =>
    locator.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(await durations(row)).toMatch(/^0\.06s/);
  expect(await durations(page.getByRole('button', { name: '设置与账号', exact: true }))).toBe(
    '0.06s',
  );
  await createSession(page, '反馈节奏');
  expect(await durations(page.locator('.session-row').first())).toMatch(/^0\.06s/);
  for (const control of [page.locator('.workspace .chip:visible').first()]) {
    await control.hover();
    await page.mouse.down();
    await expect(control).toHaveCSS('scale', '0.98');
    await page.mouse.move(10, 790);
    await page.mouse.up();
  }
  const selected = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.background = 'var(--selected)';
    document.querySelector('.sidebar')!.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await row.hover();
  await page.mouse.down();
  await expect(row).toHaveCSS('background-color', selected);
  await page.mouse.move(10, 790);
  await page.mouse.up();
});

test('the switch slides without bouncing', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
  const timing = await page
    .locator('button[role="switch"]')
    .first()
    .evaluate((element) => getComputedStyle(element, '::after').transitionTimingFunction);
  expect(timing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
});

test('with reduced motion surfaces still fade briefly while nothing unfolds or slides', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  const menu = page.getByRole('menu', { name: '设置与账号' });
  await expect(menu).toBeVisible();
  const opening = await menu.evaluate((element) =>
    element
      .getAnimations()
      .map((animation) => [
        (animation as CSSAnimation).animationName,
        animation.effect?.getTiming().duration,
      ]),
  );
  expect(opening).toEqual([['motion-fade-in', 120]]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // The side column fades without sliding; the page takes its place at once.
  await page.getByRole('banner').getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('translate', 'none');
  expect(
    await page.locator('.shell').evaluate((shell) => getComputedStyle(shell).transitionDuration),
  ).toMatch(/^0s/);
  // Controls answer at once; the column's resize handle too.
  expect(
    await page
      .locator('.sidebar-resize')
      .evaluate((element) => getComputedStyle(element, '::after').transitionDuration),
  ).toBe('0s');
});
