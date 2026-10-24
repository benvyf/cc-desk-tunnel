import { expect, test } from '@playwright/test';
import { createSession, login } from './helpers.ts';

test('narrow standalone settings remain interactive while connected settings follow the sidebar toggle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  await expect(page.locator('.settings-only .sidebar')).not.toHaveAttribute('inert');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '快捷键', exact: true })
    .click();
  await expect(page.locator('.page-title')).toHaveText('快捷键');
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await login(page);
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
  await createSession(page, '侧栏坐标');
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
  await expect(page.locator('.stream-reveal').first()).toHaveCSS('animation-name', 'none');
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
