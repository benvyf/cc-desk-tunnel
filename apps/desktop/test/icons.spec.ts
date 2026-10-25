import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

test('page and settings navigation use bold selected glyphs and restore regular glyphs', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const rail = page.getByRole('navigation', { name: '页面', exact: true });
  const chat = rail.getByRole('button', { name: '会话', exact: true });
  const schedules = rail.getByRole('button', { name: '定时任务', exact: true });
  const chatGlyph = chat.locator('svg');
  await expect(chatGlyph).toHaveAttribute('viewBox', '0 0 256 256');
  await expect(chatGlyph).toHaveAttribute('data-weight', 'bold');
  const boldPath = await chatGlyph.locator('path').first().getAttribute('d');
  await schedules.click();
  await expect(chatGlyph).toHaveAttribute('data-weight', 'regular');
  expect(await chatGlyph.locator('path').first().getAttribute('d')).not.toBe(boldPath);
  await expect(schedules.locator('svg')).toHaveAttribute('data-weight', 'bold');
  await chat.click();
  await expect(chatGlyph.locator('path').first()).toHaveAttribute('d', boldPath!);
  await expect(schedules.locator('svg')).toHaveAttribute('data-weight', 'regular');
  await rail.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const categories = page.getByRole('navigation', { name: '设置分类', exact: true });
  const general = categories.getByRole('button', { name: '常规', exact: true });
  const shortcuts = categories.getByRole('button', { name: '快捷键', exact: true });
  await general.click();
  await expect(general.locator('svg')).toHaveAttribute('data-weight', 'bold');
  await shortcuts.click();
  await expect(general.locator('svg')).toHaveAttribute('data-weight', 'regular');
  await expect(shortcuts.locator('svg')).toHaveAttribute('data-weight', 'bold');
  await expect(shortcuts).toHaveAccessibleName('快捷键');
  await categories.getByRole('button', { name: '关于与更新', exact: true }).click();
  const homepage = page.getByRole('button', { name: '项目主页 · CC SPACE', exact: true });
  await expect(homepage.locator('svg')).toHaveCSS('width', '16px');
  await expect(homepage.locator('svg')).toHaveCSS('height', '16px');
  await expect(homepage.locator('svg')).toHaveAttribute('viewBox', '0 0 16 16');
  await shortcuts.click();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.screenshot({ path: resolve(screenshots, `icons-settings-${theme}-${width}.png`) });
    }
  }
});

test('glyph scales, baseline, spinner and keyboard copy feedback survive the migration', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const iconsPath = '/src/icons.tsx';
    const copyPath = '/src/copy.tsx';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { Search, Spark, LoaderCircle, ArrowRight } = await import(iconsPath);
    const { CopyButton } = await import(copyPath);
    const root = document.createElement('main');
    document.body.replaceChildren(root);
    root.style.padding = '24px';
    createRoot(root).render(
      React.createElement(
        React.Fragment,
        null,
        ...['xs', 'sm', 'md', 'lg', 'xl'].map((scale) =>
          React.createElement(
            'p',
            { key: scale, 'data-scale': scale },
            React.createElement(Search, { scale }),
            '搜索',
          ),
        ),
        React.createElement('p', { 'data-testid': 'spark' }, React.createElement(Spark), '思考'),
        React.createElement(
          'p',
          { 'data-testid': 'spinner' },
          React.createElement(LoaderCircle, { className: 'spinning' }),
          '加载',
        ),
        React.createElement(
          'button',
          { className: 'send-button', 'aria-label': '发送消息' },
          React.createElement(ArrowRight),
        ),
        React.createElement(CopyButton, { text: '图标复制验证', label: '复制内容' }),
      ),
    );
  });
  for (const [scale, size] of [
    ['xs', 12],
    ['sm', 16],
    ['md', 20],
    ['lg', 24],
    ['xl', 32],
  ] as const) {
    const glyph = page.locator(`[data-scale="${scale}"] svg`);
    await expect(glyph).toHaveCSS('width', `${size}px`);
    await expect(glyph).toHaveCSS('height', `${size}px`);
    await expect(glyph).toHaveCSS('vertical-align', '-1.75px');
    await expect(glyph).toHaveAttribute('aria-hidden', 'true');
    await expect(glyph).toHaveAttribute('focusable', 'false');
    await expect(glyph).toHaveAttribute('data-weight', 'regular');
  }
  await expect(page.getByTestId('spark').locator('svg')).toHaveAttribute('viewBox', '0 0 256 256');
  await expect(page.getByTestId('spinner').locator('svg')).toHaveCSS('animation-name', 'spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByTestId('spinner').locator('svg')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const copy = page.locator('button.copy-button');
  await expect(copy).toHaveAccessibleName('复制内容');
  const original = await copy.locator('path').getAttribute('d');
  await copy.focus();
  await copy.press('Enter');
  await expect(copy.locator('path')).not.toHaveAttribute('d', original!);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('图标复制验证');
  await expect(copy.locator('path')).toHaveAttribute('d', original!);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: resolve(screenshots, `icons-glyphs-${theme}.png`) });
  }
});
