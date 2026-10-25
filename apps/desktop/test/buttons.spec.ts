import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

async function controls(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const uiPath = '/src/ui.tsx';
    const iconPath = '/src/icons.tsx';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { Button, IconButton } = await import(uiPath);
    const { Plus } = await import(iconPath);
    const root = document.createElement('main');
    root.style.cssText = 'padding:24px;display:grid;gap:24px;max-width:640px';
    document.body.replaceChildren(root);
    createRoot(root).render(
      React.createElement(
        React.Fragment,
        null,
        ...['xs', 'sm', 'md', 'lg'].map((size) =>
          React.createElement(
            'div',
            { key: size, style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
            ...['primary', 'secondary', 'ghost'].map((variant) =>
              React.createElement(
                Button,
                { key: variant, size, variant, 'data-testid': `${variant}-${size}` },
                React.createElement(Plus),
                `${variant} ${size}`,
              ),
            ),
            React.createElement(
              IconButton,
              { size, title: `添加 ${size}` },
              React.createElement(Plus),
            ),
          ),
        ),
        React.createElement(
          'form',
          {
            onSubmit(event: Event) {
              event.preventDefault();
              root.dataset.submits = String(Number(root.dataset.submits ?? 0) + 1);
            },
            style: { display: 'flex', flexWrap: 'wrap', gap: 12 },
          },
          React.createElement(
            Button,
            {
              onClick() {
                root.dataset.clicks = String(Number(root.dataset.clicks ?? 0) + 1);
              },
            },
            '默认操作',
          ),
          React.createElement(
            Button,
            {
              disabled: true,
              onClick() {
                root.dataset.disabled = 'clicked';
              },
            },
            '禁用操作',
          ),
          React.createElement(Button, { type: 'submit', variant: 'primary' }, '提交'),
        ),
        React.createElement(
          Button,
          { variant: 'secondary', size: 'xs', style: { width: 180 }, 'data-testid': 'long' },
          React.createElement(Plus),
          'LongUnbrokenConnectionName0123456789ABCDEFGHIJKLMN 连接并同步全部配置',
        ),
      ),
    );
  });
  await expect(page.getByTestId('primary-md')).toBeVisible();
}

for (const theme of ['light', 'dark']) {
  test(`button variants and sizes in ${theme}`, async ({ page }) => {
    await controls(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const [size, height] of [
      ['xs', 24],
      ['sm', 28],
      ['md', 32],
      ['lg', 40],
    ] as const) {
      for (const variant of ['primary', 'secondary', 'ghost']) {
        const button = page.getByTestId(`${variant}-${size}`);
        expect((await button.boundingBox())!.height).toBe(height);
      }
      const icon = await page
        .getByRole('button', { name: `添加 ${size}`, exact: true })
        .boundingBox();
      expect(icon!.width).toBe(height);
      expect(icon!.height).toBe(height);
    }
    const primary = page.getByTestId('primary-md');
    const ratio = () =>
      primary.evaluate((button) => {
        const style = getComputedStyle(button);
        const luminance = (color: string) => {
          const channels = color
            .match(/\d+/g)!
            .slice(0, 3)
            .map(Number)
            .map((c) => {
              const v = c / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const foreground = luminance(style.color),
          background = luminance(style.backgroundColor);
        return (
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        );
      });
    await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(primary.locator('svg')).toHaveCSS('color', 'rgb(255, 255, 255)');
    expect(await ratio()).toBeGreaterThanOrEqual(4.5);
    const resting = await primary.evaluate((button) => getComputedStyle(button).backgroundColor);
    await primary.hover();
    await expect
      .poll(() => primary.evaluate((button) => getComputedStyle(button).backgroundColor))
      .not.toBe(resting);
    await expect(primary).toHaveCSS('background-color', 'rgb(163, 68, 39)');
    expect(await ratio()).toBeGreaterThanOrEqual(4.5);
    const secondary = page.getByTestId('secondary-md');
    const ghost = page.getByTestId('ghost-md');
    await expect(secondary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(secondary).toHaveCSS('border-top-width', '1px');
    await expect(ghost).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(ghost).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await ghost.hover();
    await expect(ghost).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.mouse.move(0, 0);
    await expect(ghost).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.screenshot({
      animations: 'disabled',
      path: resolve(screenshots, `buttons-${theme}.png`),
    });
    await page.setViewportSize({ width: 320, height: 1000 });
    const long = page.getByTestId('long');
    expect((await long.boundingBox())!.height).toBeGreaterThan(24);
    expect(await long.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      animations: 'disabled',
      path: resolve(screenshots, `buttons-${theme}-narrow.png`),
    });
  });
}

test('buttons retain native form, disabled and keyboard semantics', async ({ page }) => {
  await controls(page);
  const action = page.getByRole('button', { name: '默认操作', exact: true });
  await action.click();
  await expect(page.locator('main')).toHaveAttribute('data-clicks', '1');
  await expect(page.locator('main')).not.toHaveAttribute('data-submits');
  await action.press('Tab');
  const submit = page.getByRole('button', { name: '提交', exact: true });
  await expect(submit).toBeFocused();
  await expect(submit).toHaveCSS('outline-style', 'solid');
  await expect(submit).toHaveCSS('outline-width', '2px');
  await submit.press('Enter');
  await expect(page.locator('main')).toHaveAttribute('data-submits', '1');
  await page.getByRole('button', { name: '禁用操作' }).dispatchEvent('click');
  await expect(page.locator('main')).not.toHaveAttribute('data-disabled');
  await action.focus();
  await action.press('Space');
  await expect(page.locator('main')).toHaveAttribute('data-clicks', '2');
});

test('system theme, explicit theme and reduced motion apply to every button variant', async ({
  page,
}) => {
  await controls(page);
  const secondary = page.getByTestId('secondary-md');
  const ghost = page.getByTestId('ghost-md');
  for (const [theme, text, muted] of [
    ['light', 'rgb(32, 32, 30)', 'rgb(107, 104, 99)'],
    ['dark', 'rgb(222, 220, 214)', 'rgb(164, 161, 155)'],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'system';
    });
    await expect(secondary).toHaveCSS('color', text);
    await expect(ghost).toHaveCSS('color', muted);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' });
    await expect(secondary).toHaveCSS('color', text);
    await expect(ghost).toHaveCSS('color', muted);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const variant of ['primary', 'secondary', 'ghost']) {
    const button = page.getByTestId(`${variant}-md`);
    await expect(button).toHaveCSS('transition-duration', '0s, 0s, 0s, 0s');
    await button.hover();
    const bounds = (await button.boundingBox())!;
    const icon = (await button.locator('svg').boundingBox())!;
    expect(icon.y + icon.height / 2).toBeCloseTo(bounds.y + bounds.height / 2, 2);
    const restingScale = await button.evaluate((element) => getComputedStyle(element).scale);
    await page.mouse.down();
    await expect(button).toHaveCSS('scale', '0.98');
    await page.mouse.up();
    await expect(button).toHaveCSS('scale', restingScale);
  }
});

test('disabled variants keep their resting appearance under the pointer and enlarged labels fit', async ({
  page,
}) => {
  await controls(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const variant of ['primary', 'secondary', 'ghost']) {
    const button = page.getByTestId(`${variant}-md`);
    await button.evaluate((element: HTMLButtonElement) => {
      element.disabled = true;
    });
    const resting = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
        border: style.borderTopColor,
      };
    });
    await button.hover();
    await expect(button).toHaveCSS('background-color', resting.background);
    await expect(button).toHaveCSS('color', resting.color);
    await expect(button).toHaveCSS('border-top-color', resting.border);
    await expect(button).toHaveCSS('cursor', 'not-allowed');
    await page.mouse.down();
    await expect(button).not.toHaveCSS('scale', '0.98');
    await page.mouse.up();
  }
  await page.setViewportSize({ width: 640, height: 1000 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  const long = page.getByTestId('long');
  expect(await long.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('real login and dialog use large and default actions without changing submission', async ({
  page,
}) => {
  await page.goto('/');
  const connect = page.getByRole('button', { name: '连接', exact: true });
  expect((await connect.boundingBox())!.height).toBe(44);
  await expect(connect).toHaveCSS('color', 'rgb(255, 255, 255)');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({
      animations: 'disabled',
      path: resolve(screenshots, `buttons-login-${theme}.png`),
    });
  }
  await login(page);
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const add = dialog.getByRole('button', { name: '添加', exact: true });
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  expect((await add.boundingBox())!.height).toBeCloseTo(32, 2);
  expect((await cancel.boundingBox())!.height).toBeCloseTo(32, 2);
  await page.screenshot({
    animations: 'disabled',
    path: resolve(screenshots, 'buttons-dialog.png'),
  });
  await cancel.click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\工作\\按钮控件');
  await page.getByLabel('本机项目目录').press('Enter');
  await expect(dialog).not.toBeVisible();
});

test('real settings, account and schedule actions preserve their contextual tiers', async ({
  page,
}) => {
  await page.goto('/');
  await page.keyboard.press('Control+Comma');
  await page.getByRole('button', { name: '快捷键', exact: true }).click();
  const reset = page.getByRole('button', { name: '恢复默认组合键', exact: true });
  await expect(reset).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(reset).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await reset.click();
  await expect(page.getByRole('switch', { name: '启用快捷键' })).toBeVisible();
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: /^账号/ }).click();
  const log = page.getByRole('button', { name: '调用日志', exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 320, height: 844 });
    expect((await log.boundingBox())!.height).toBeCloseTo(28, 2);
    expect(await log.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: resolve(screenshots, `buttons-account-${theme}-narrow.png`),
    });
  }
  await log.click();
  await expect(page.getByRole('button', { name: '返回账号', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  const name = `按钮尺寸 ${Date.now()}`;
  await page.getByLabel('任务名称').fill(name);
  await page.getByLabel('提示词', { exact: true }).fill('检查按钮');
  await page.getByLabel('重复规则').selectOption('interval');
  await page.getByLabel('间隔分钟').fill('60');
  await page.getByLabel('发送到').selectOption('new');
  await page.getByLabel('项目目录', { exact: true }).fill('D:\\工作\\按钮控件');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('button', { name: `删除 ${name}`, exact: true }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  const remove = page.getByRole('button', { name: '确认删除', exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect(remove).toBeInViewport();
    expect((await remove.boundingBox())!.height).toBeCloseTo(24, 2);
    expect(await remove.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: resolve(screenshots, `buttons-schedule-${theme}-narrow.png`),
    });
  }
  await remove.click();
  await expect(page.locator('.schedule-row')).toHaveCount(0);
});
