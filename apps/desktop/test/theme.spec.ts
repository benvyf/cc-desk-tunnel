import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { resolve } from 'node:path';
import { createSession, login, screenshots, sessionAction } from './helpers.ts';

async function contrast(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const [r, g, b] = color
        .match(/\d+/g)!
        .slice(0, 3)
        .map(Number)
        .map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const text = luminance(style.color),
      background = luminance(style.backgroundColor);
    return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
  });
}

test('theme previews fit narrow windows and preserve radio keyboard navigation', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  const choices = page.getByRole('radiogroup', { name: '主题', exact: true });
  for (const theme of ['浅色', '深色', '跟随系统']) {
    await choices.getByRole('radio', { name: theme, exact: true }).click();
    for (const width of [320, 390, 640, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await choices
        .locator('button')
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => button.scrollWidth > button.clientWidth)
            .map((button) => button.textContent),
        );
      expect.soft(overflow, `${theme} at ${width}px`).toEqual([]);
      expect
        .soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await expect(choices.getByRole('radio', { name: theme, exact: true })).toBeInViewport();
      if (width === 320)
        await page.screenshot({ path: resolve(screenshots, `theme-review-${theme}-mobile.png`) });
    }
  }
  const system = choices.getByRole('radio', { name: '跟随系统', exact: true });
  const dark = choices.getByRole('radio', { name: '深色', exact: true });
  await system.press('End');
  await expect(dark).toBeFocused();
  await dark.press('ArrowDown');
  await expect(system).toBeFocused();
  await system.press('ArrowUp');
  await expect(dark).toBeFocused();
  await dark.press('Home');
  await expect(system).toBeFocused();
  await system.press('Control+End');
  await expect(system).toHaveAttribute('aria-checked', 'true');
  await system.press('Tab');
  await expect(choices.locator(':focus')).toHaveCount(0);
});

test('terminal close and update icons remain readable in both themes without a real terminal', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const terminalPath = '/src/NativeTerminal.tsx';
    const railPath = '/src/Rail.tsx';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { default: Terminal } = await import(terminalPath);
    const { default: Rail } = await import(railPath);
    let receive: (message: unknown) => void = () => {};
    const requests: string[] = [];
    const client = {
      onTerminal(callback: typeof receive) {
        receive = callback;
        return () => {};
      },
      async request(command: { type: string }) {
        requests.push(command.type);
        if (command.type === 'terminal.open')
          receive({ type: 'terminal.opened', sessionId: 'theme-fixture', terminalId: 'fixture' });
      },
      terminalControl() {},
    };
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    createRoot(root).render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Terminal, { client, sessionId: 'theme-fixture', onClose() {} }),
        React.createElement(Rail, {
          page: 'chat',
          update: '有更新',
          go() {},
          openUpdate() {},
          openSettings() {},
        }),
      ),
    );
    Object.assign(window, { themeTerminalRequests: requests });
  });
  const close = page.getByRole('button', { name: '关闭原生终端', exact: true });
  const update = page.getByRole('button', { name: '更新', exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await close.hover();
    expect
      .soft(await contrast(close), `terminal close hover in ${theme}`)
      .toBeGreaterThanOrEqual(3);
    await expect.soft(close).toHaveCSS('color', 'rgb(222, 220, 214)');
    await expect.soft(close).toHaveCSS('background-color', 'rgb(32, 32, 30)');
    await update.hover();
    expect.soft(await contrast(update), `update hover in ${theme}`).toBeGreaterThanOrEqual(3);
  }
  await close.click();
  expect(
    await page.evaluate(
      () => (window as unknown as { themeTerminalRequests: string[] }).themeTerminalRequests,
    ),
  ).toEqual(['terminal.open', 'terminal.close']);
});

test('destructive action labels retain contrast in both themes', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '主题对比度');
  await sessionAction(page, '删除');
  const remove = page.getByRole('dialog').getByRole('button', { name: '删除', exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.mouse.move(0, 0);
    expect(await contrast(remove), `${theme} default`).toBeGreaterThanOrEqual(4.5);
    await remove.hover();
    expect(await contrast(remove), `${theme} hover`).toBeGreaterThanOrEqual(4.5);
  }
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('workbench surfaces and hover feedback remain consistent across pages and sidebar states', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '三栏复查');
  const colors = () =>
    page.evaluate(() =>
      ['.rail', '.sidebar', '.workspace'].map(
        (selector) => getComputedStyle(document.querySelector(selector)!).backgroundColor,
      ),
    );
  for (const name of ['浅色', '深色']) {
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '常规', exact: true })
      .click();
    await page.getByRole('radio', { name, exact: true }).click();
    const palette = await colors();
    expect(new Set(palette).size).toBe(3);
    for (const button of [
      page.getByRole('button', { name: '收起侧栏', exact: true }),
      page.getByRole('button', { name: '会话', exact: true }),
    ]) {
      await button.hover();
      expect
        .soft(await button.evaluate((element) => getComputedStyle(element).backgroundColor), name)
        .not.toBe(palette[0]);
    }
    await expect.soft(page.locator('.sidebar')).toHaveCSS('border-top-left-radius', '14px');
    for (const destination of ['会话', '定时任务']) {
      await page.getByRole('button', { name: destination, exact: true }).click();
      expect(await colors()).toEqual(palette);
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
      await expect(page.locator('.sidebar')).toBeHidden();
      await expect(page.locator('.workspace')).toHaveCSS('border-top-left-radius', '14px');
      await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
    }
    await page.setViewportSize({ width: 390, height: 600 });
    await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
    const panel = (await page.locator('.sidebar').boundingBox())!;
    expect(panel.x).toBe(44);
    expect(panel.y).toBe(40);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: resolve(screenshots, `theme-drawer-${name}.png`) });
    await page.locator('.sidebar-shade').click({ position: { x: 330, y: 300 } });
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.sidebar')).toBeVisible();
  }
});

test('notification popup stays inside narrow windows and dismisses with Escape', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 600 });
    if (width < 700) {
      await expect(page.locator('.sidebar')).toBeHidden();
      await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
    }
    await page.getByRole('button', { name: /^通知/ }).click();
    const popup = page.getByRole('dialog', { name: '通知', exact: true });
    const bounds = (await popup.boundingBox())!;
    expect.soft(bounds.x, `${width}px left`).toBeGreaterThanOrEqual(0);
    expect.soft(bounds.x + bounds.width, `${width}px right`).toBeLessThanOrEqual(width);
    if (width === 320)
      await page.screenshot({ path: resolve(screenshots, 'theme-notifications-mobile.png') });
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    if (width < 700) await page.mouse.click(width - 8, 350);
  }
});
