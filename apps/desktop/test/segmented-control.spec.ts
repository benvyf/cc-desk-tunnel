import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

async function fixture(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const fixturePath = '/test/fixtures/segmented-control.tsx';
    (await import(fixturePath)).mount();
  });
  await expect(page.getByRole('group', { name: '导航', exact: true })).toBeVisible();
}

async function aligned(control: Locator, name: string, role: 'button' | 'radio' = 'button') {
  await expect(async () => {
    const selected = (await control.getByRole(role, { name, exact: true }).boundingBox())!;
    const indicator = (await control.locator('.segmented-indicator').boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(selected[key] - indicator[key])).toBeLessThan(0.1);
    const bounds = (await control.boundingBox())!;
    // Scroll offsets are rounded to device pixels; grid/indicator geometry above is subpixel precise.
    expect(selected.x).toBeGreaterThanOrEqual(bounds.x + 1.5);
    expect(selected.x + selected.width).toBeLessThanOrEqual(bounds.x + bounds.width - 1.5);
  }).toPass();
}

for (const theme of ['light', 'dark']) {
  test(`capsule geometry, theme and fractional resize: ${theme}`, async ({ page }) => {
    await fixture(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const control = page.getByRole('group', { name: '导航', exact: true });
    await expect(control).toHaveCSS('height', '36px');
    await expect(control).toHaveCSS('border-radius', '999px');
    await expect(control).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(233, 233, 233)' : 'rgb(37, 37, 37)',
    );
    await expect(control.locator('.segmented-indicator')).toHaveCSS(
      'background-color',
      theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(68, 68, 68)',
    );
    const bounds = (await control.boundingBox())!;
    const button = (await control
      .getByRole('button', { name: 'Chat', exact: true })
      .boundingBox())!;
    expect(bounds.width).toBe(420);
    expect(button.x - bounds.x).toBe(2);
    expect(button.y - bounds.y).toBe(2);
    expect(button.height).toBe(32);
    await aligned(control, 'Chat');
    await control.getByRole('button', { name: 'Settings', exact: true }).click();
    await aligned(control, 'Settings');
    await page.locator('#resizer').evaluate((el) => {
      el.style.width = '317.5px';
    });
    await aligned(control, 'Settings');
    const widths = await control
      .locator('button')
      .evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().width));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.1);
    await page.locator('#resizer').evaluate((el) => {
      el.style.width = '420px';
    });
    await aligned(control, 'Settings');
    await page.screenshot({
      path: resolve(screenshots, `segmented-${theme}.png`),
      animations: 'disabled',
    });
  });
}

test('keyboard selection skips disabled items, respects modifiers and never submits', async ({
  page,
}) => {
  await fixture(page);
  const group = page.getByRole('radiogroup', { name: '展示', exact: true });
  const chat = group.getByRole('radio', { name: 'Chat', exact: true });
  await chat.focus();
  await chat.press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Projects', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Settings', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(chat).toBeChecked();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+ArrowLeft');
  const settings = group.getByRole('radio', { name: 'Settings', exact: true });
  await expect(settings).toBeFocused();
  await expect(settings).toBeChecked();
  await expect(settings).toHaveCSS('outline-style', 'solid');
  expect(await group.locator('button[tabindex="0"]').count()).toBe(1);
  await settings.press('Enter');
  await expect(page.locator('main')).not.toHaveAttribute('data-submitted');
});

test('narrow tracks preserve labels, scrolling, dynamic options and hidden reveal', async ({
  page,
}) => {
  await fixture(page);
  const group = page.getByRole('group', { name: '导航', exact: true });
  await page.locator('#resizer').evaluate((el) => {
    el.style.width = '240px';
  });
  await expect(group.locator('.segmented-icon').first()).toBeHidden();
  await expect(group.getByRole('button', { name: 'Chat', exact: true })).toContainText('Chat');
  await page.getByRole('button', { name: '动态选项', exact: true }).click();
  const last = group.getByRole('button', { name: '本期 Sonnet 每周额度', exact: true });
  await last.click();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await aligned(group, '本期 Sonnet 每周额度');
  expect(await group.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollLeft > 0)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByText('展开示例', { exact: true }).click();
  await aligned(page.getByRole('group', { name: '隐藏导航', exact: true }), '本期 Sonnet 每周额度');
  // Removing the selected value leaves no stale selection and retains a reachable tab stop.
  await page.getByRole('button', { name: '动态选项', exact: true }).click();
  await expect(group.locator('.segmented-indicator')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute(
    'tabindex',
    '0',
  );
  await group.getByRole('button', { name: 'Chat', exact: true }).focus();
  await page.keyboard.press('End');
  await aligned(group, 'Settings');
  await page.screenshot({
    path: resolve(screenshots, 'segmented-narrow.png'),
    animations: 'disabled',
  });
});

test('RTL arrows and indicator align after wrapping and double scale', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
  });
  const group = page.getByRole('group', { name: '导航', exact: true });
  const chat = group.getByRole('button', { name: 'Chat', exact: true });
  await aligned(group, 'Chat');
  await chat.focus();
  await page.keyboard.press('ArrowRight');
  const last = group.getByRole('button', { name: 'Settings', exact: true });
  await expect(last).toBeFocused();
  await aligned(group, 'Settings');
  await page.evaluate(() => {
    document.body.style.zoom = '2';
  });
  await aligned(group, 'Settings');
});

test('sliding uses motion tokens and disables movement for reduced motion', async ({ page }) => {
  await fixture(page);
  const control = page.getByRole('group', { name: '导航', exact: true });
  const indicator = control.locator('.segmented-indicator');
  await expect(indicator).toHaveCSS('transition-duration', '0.2s');
  await control.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(
    await indicator.evaluate((el) =>
      el.getAnimations().some((animation) => animation.playState === 'running'),
    ),
  ).toBe(true);
  await aligned(control, 'Settings');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(indicator).toHaveCSS('transition-duration', '0s');
  await control.getByRole('button', { name: 'Chat', exact: true }).click();
  await aligned(control, 'Chat');
});

test('overflowed selection stays visible at double scale without scrolling the page', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '动态选项', exact: true }).click();
  await page.locator('#resizer').evaluate((el) => {
    el.style.width = '240px';
  });
  await page.evaluate(() => {
    document.body.style.zoom = '2';
  });
  const group = page.getByRole('group', { name: '导航', exact: true });
  await group.getByRole('button', { name: 'Chat', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await aligned(group, 'Projects');
  await page.keyboard.press('ArrowRight');
  await aligned(group, 'Settings');
  await page.keyboard.press('End');
  await aligned(group, '本期 Sonnet 每周额度');
  await page.keyboard.press('ArrowLeft');
  await aligned(group, 'Settings');
  await page.keyboard.press('ArrowLeft');
  await aligned(group, 'Projects');
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('button', { name: '更多选项', exact: true }).click();
  await group.getByRole('button', { name: 'Chat', exact: true }).focus();
  await page.keyboard.press('Home');
  for (const name of [
    'Projects',
    'Settings',
    '本期 Sonnet 每周额度',
    '本期模型 0 每周额度',
    '本期模型 1 每周额度',
  ]) {
    await page.keyboard.press('ArrowRight');
    await aligned(group, name);
  }
});

test('real usage controls remain aligned and usable across themes and narrow layouts', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: /^账号/ }).click();
  await page.getByRole('button', { name: '调用日志', exact: true }).click();
  const ranges = page.getByRole('group', { name: '时间范围', exact: true });
  const measures = page.getByRole('group', { name: '图表指标', exact: true });
  await ranges.getByRole('button', { name: '自定义', exact: true }).click();
  await measures.getByRole('button', { name: 'Token', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await aligned(ranges, '自定义');
      await aligned(measures, 'Token');
      await expect(page.getByLabel('开始时间', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: resolve(screenshots, `segmented-usage-${theme}-${width}.png`),
        animations: 'disabled',
      });
    }
  }
});

test('Windows forced colors retain a distinct selected capsule and keyboard focus', async ({
  page,
}) => {
  await fixture(page);
  await page.emulateMedia({ forcedColors: 'active' });
  const group = page.getByRole('group', { name: '导航', exact: true });
  const selected = group.getByRole('button', { name: 'Chat', exact: true });
  const track = await group.evaluate((el) => getComputedStyle(el).backgroundColor);
  const indicator = group.locator('.segmented-indicator');
  expect(await indicator.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(track);
  await selected.focus();
  await expect(selected).toHaveCSS('outline-style', 'solid');
  // The selected text and its focus ring must both contrast with the system highlight.
  const readContrast = () =>
    group.evaluate((el) => {
      const active = getComputedStyle(el.querySelector('[aria-pressed="true"]')!);
      const bg = getComputedStyle(el.querySelector('.segmented-indicator')!).backgroundColor;
      const luminance = (color: string) => {
        const [r, g, b] = color
          .match(/\d+/g)!
          .slice(0, 3)
          .map(Number)
          .map((c) => {
            const v = c / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const background = luminance(bg);
      return [active.color, active.outlineColor].map((color) => {
        const fg = luminance(color);
        return (Math.max(fg, background) + 0.05) / (Math.min(fg, background) + 0.05);
      });
    });
  const contrast = await readContrast();
  expect(contrast[0]).toBeGreaterThanOrEqual(4.5);
  expect(contrast[1]).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--cds-dur-snap', '2000ms');
  });
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect((await readContrast())[0]).toBeGreaterThanOrEqual(4.5);
  await aligned(group, 'Projects');
  await page.screenshot({
    path: resolve(screenshots, 'segmented-forced-colors.png'),
    animations: 'disabled',
  });
});

test('enabling reduced motion cancels a slide already in progress', async ({ page }) => {
  await fixture(page);
  // Lengthen the same token so browser scheduling cannot finish the slide before the preference changes.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--cds-dur-base', '2000ms');
  });
  const group = page.getByRole('group', { name: '导航', exact: true });
  const indicator = group.locator('.segmented-indicator');
  await group.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(
    await indicator.evaluate((el) => el.getAnimations().some((a) => a.playState === 'running')),
  ).toBe(true);
  // Restore the normal token; changing a duration alone does not cancel an existing transition.
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--cds-dur-base');
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await indicator.evaluate(async (el) => {
      await new Promise(requestAnimationFrame);
      return el.getAnimations().some((a) => a.playState === 'running');
    }),
  ).toBe(false);
  await aligned(group, 'Settings');
});

test('RTL overflowing tracks preserve the selected option while resizing and zooming', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: '动态选项', exact: true }).click();
  await page.getByRole('button', { name: '更多选项', exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.dir = 'rtl';
    document.body.style.zoom = '1.25';
  });
  await page.locator('#resizer').evaluate((el) => {
    el.style.width = '239.5px';
  });
  const group = page.getByRole('group', { name: '导航', exact: true });
  await group.getByRole('button', { name: 'Chat', exact: true }).focus();
  for (const name of ['Projects', 'Settings', '本期 Sonnet 每周额度', '本期模型 0 每周额度']) {
    await page.keyboard.press('ArrowLeft');
    await aligned(group, name);
  }
  await page.keyboard.press('End');
  await aligned(group, '本期模型 4 每周额度');
  await page.keyboard.press('Home');
  await aligned(group, 'Chat');
});

test('rapid keyboard reversals settle on one selection without moving focus or submitting', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture(page);
  const group = page.getByRole('group', { name: '导航', exact: true });
  await group.getByRole('button', { name: 'Chat', exact: true }).focus();
  for (const key of [
    'End',
    'Home',
    'ArrowLeft',
    'ArrowRight',
    'ArrowRight',
    'ArrowRight',
    'ArrowLeft',
  ]) {
    await page.keyboard.press(key);
  }
  const selected = group.getByRole('button', { name: 'Projects', exact: true });
  await expect(selected).toBeFocused();
  await expect(group.locator('[aria-pressed="true"]')).toHaveCount(1);
  await aligned(group, 'Projects');
  await page.keyboard.press('Space');
  await expect(selected).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('data-submitted');
  await page.keyboard.press('Tab');
  await expect(
    page
      .getByRole('radiogroup', { name: '展示', exact: true })
      .getByRole('radio', { name: 'Projects', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(selected).toBeFocused();
  expect(errors).toEqual([]);
});

test('container breakpoint, text scaling and reveal remain precise after repeated hide/show', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture(page);
  const group = page.getByRole('group', { name: '导航', exact: true });
  await group.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const width of ['255px', '254px', '253.5px', '420px']) {
    await page.locator('#resizer').evaluate((el, width) => {
      el.style.width = width;
    }, width);
    if (Number.parseFloat(width) <= 254)
      await expect(group.locator('.segmented-icon').first()).toBeHidden();
    else await expect(group.locator('.segmented-icon').first()).toBeVisible();
    await aligned(group, 'Settings');
  }
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-caption', '24px');
  });
  await aligned(group, 'Settings');
  for (let index = 0; index < 3; index++) {
    await page.getByText('展开示例', { exact: true }).click();
    await aligned(page.getByRole('group', { name: '隐藏导航', exact: true }), 'Settings');
    await page.getByText('展开示例', { exact: true }).click();
  }
  expect(errors).toEqual([]);
});
