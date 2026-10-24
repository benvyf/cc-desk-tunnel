import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { screenshots } from './helpers.ts';

const errors = new WeakMap<Page, string[]>();

async function render(page: Page, text: string, streaming = false) {
  await page.evaluate(
    ({ text, streaming }) =>
      (
        window as unknown as { renderCodeFixture: (text: string, streaming: boolean) => void }
      ).renderCodeFixture(text, streaming),
    { text, streaming },
  );
}

test.beforeEach(async ({ page }) => {
  const found: string[] = [];
  errors.set(page, found);
  page.on('pageerror', (error) => found.push(error.message));
  await page.goto('/test/fixtures/code-blocks.html');
  await page.evaluate(() => {
    const copies: string[] = [];
    Object.assign(window, { codeCopies: copies });
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        copies.push(text);
      },
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test('code header labels its language, copies exact source and resets after 2.5 seconds', async ({
  page,
}) => {
  await expect(page.locator('.code-language')).toHaveText('typescript');
  const source = await page.locator('pre').textContent();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const button = page.getByRole('button', { name: '复制代码', exact: true });
  const before = await button.boundingBox();
  await button.click();
  const copied = page.getByRole('button', { name: '已复制', exact: true });
  await expect(copied).toHaveAttribute('data-status', 'copied');
  expect((await copied.boundingBox())?.width).toBe(before?.width);
  expect(
    await page.evaluate(() => (window as unknown as { codeCopies: string[] }).codeCopies),
  ).toEqual([source]);
  await page.clock.runFor(2499);
  await expect(copied).toBeVisible();
  await page.clock.runFor(1);
  await expect(button).toBeVisible();
});

test('repeated copy restarts feedback and each code block owns its timer', async ({ page }) => {
  await render(page, '```js\nfirst();\n```\n\n```\n第二段\n```');
  await expect(page.locator('.code-language')).toHaveText(['js', 'text']);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const first = page.locator('.code-block').first().getByRole('button');
  const second = page.locator('.code-block').last().getByRole('button');
  await first.click();
  await page.clock.runFor(2000);
  await first.click();
  await second.click();
  await page.clock.runFor(600);
  await expect(first).toHaveAccessibleName('已复制');
  await expect(second).toHaveAccessibleName('已复制');
  await page.clock.runFor(1900);
  await expect(first).toHaveAccessibleName('复制代码');
  await expect(second).toHaveAccessibleName('复制代码');
});

test('clipboard failures remain retryable and feedback never replaces copied text', async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => {
        throw new Error('denied');
      },
    }),
  );
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制失败，请重试', exact: true })).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) =>
        (window as unknown as { codeCopies: string[] }).codeCopies.push(text),
    }),
  );
  await page.getByRole('button', { name: '复制失败，请重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await render(page, '```python\n新内容 = "中文 👋"\n```', true);
  await page.getByRole('button', { name: '已复制', exact: true }).click();
  expect(
    (await page.evaluate(() => (window as unknown as { codeCopies: string[] }).codeCopies)).at(-1),
  ).toBe('新内容 = "中文 👋"\n');
});

test('late clipboard failures cannot overwrite a newer successful attempt', async ({ page }) => {
  await page.evaluate(() => {
    const pending: { resolve: () => void; reject: () => void }[] = [];
    Object.assign(window, { pendingCodeCopies: pending });
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: () =>
        new Promise<void>((resolve, reject) =>
          pending.push({ resolve, reject: () => reject(new Error('old attempt failed')) }),
        ),
    });
  });
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  await page.evaluate(() => {
    const pending = (
      window as unknown as { pendingCodeCopies: { resolve: () => void; reject: () => void }[] }
    ).pendingCodeCopies;
    pending[1].resolve();
    pending[0].reject();
  });
  await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制失败，请重试', exact: true })).toHaveCount(0);
});

for (const variant of ['code', 'default'] as const) {
  test(`a pending repeat does not extend ${variant} copy feedback beyond its deadline`, async ({
    page,
  }) => {
    if (variant === 'default')
      await page.evaluate(() =>
        (window as unknown as { renderCopyFixture: () => void }).renderCopyFixture(),
      );
    const label = variant === 'code' ? '复制代码' : '复制消息';
    const duration = variant === 'code' ? 2500 : 2000;
    const button = page.getByRole('button');
    await expect(button).toHaveAccessibleName(label);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await button.click();
    await expect(button).toHaveAccessibleName('已复制');
    await page.clock.runFor(1000);
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () =>
          new Promise<void>((resolve) => Object.assign(window, { resolveCopy: resolve })),
      });
    });
    await button.click();
    await page.clock.runFor(duration - 1000);
    await expect(button).toHaveAccessibleName(label, { timeout: 1000 });
    await page.clock.runFor(5000);
    await expect(button).toHaveAccessibleName(label);
    await page.evaluate(() => (window as unknown as { resolveCopy: () => void }).resolveCopy());
    await expect(button).toHaveAccessibleName('已复制');
    await page.clock.runFor(duration - 1);
    await expect(button).toHaveAccessibleName('已复制');
    await page.clock.runFor(1);
    await expect(button).toHaveAccessibleName(label);
  });
}

test('reference geometry, dark canvas and narrow scrolling work in both themes', async ({
  page,
}) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const code = page.locator('.code-block');
    await expect(code).toHaveCSS('border-radius', '12px');
    await expect(code).toHaveCSS('background-color', 'rgb(23, 23, 22)');
    const header = (await page.locator('.code-header').boundingBox())!;
    const body = (await page.locator('pre').boundingBox())!;
    expect(header.y + header.height).toBeLessThanOrEqual(body.y + 1);
    await code.screenshot({ path: `${screenshots}/code-block-${colorScheme}.png` });
    await page.screenshot({ path: `${screenshots}/code-block-page-${colorScheme}.png` });
    await page.getByRole('button', { name: '复制代码', exact: true }).click();
    await page.mouse.move(0, 0);
    await code.screenshot({ path: `${screenshots}/code-block-${colorScheme}-copied.png` });
    await page.reload();
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async () => {},
      }),
    );
  }
  await page.setViewportSize({ width: 320, height: 600 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('pre').evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeInViewport();
  await page.screenshot({ path: `${screenshots}/code-block-narrow.png` });
});

test('copy fade respects reduced motion and SVG source actions remain usable', async ({ page }) => {
  await page.getByRole('button', { name: '复制代码', exact: true }).click();
  const feedback = page.locator('.copy-feedback');
  await expect(feedback).toHaveCSS('animation-duration', '2.5s');
  await expect(feedback).toHaveCSS('animation-name', 'code-copy-feedback');
  const fading = await feedback.evaluate((element) => {
    const animation = element.getAnimations()[0];
    animation.pause();
    animation.currentTime = 2400;
    return Number(getComputedStyle(element).opacity);
  });
  expect(fading).toBeGreaterThan(0);
  expect(fading).toBeLessThan(1);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await expect(feedback).toHaveCSS('animation-name', 'none');
  await render(
    page,
    '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18"/></svg>\n```',
  );
  await expect(page.getByRole('img', { name: 'SVG 图像' })).toBeVisible();
  await page.getByRole('button', { name: '查看源码', exact: true }).click();
  await expect(page.locator('pre')).toContainText('<circle');
  await page.getByRole('button', { name: '查看图像', exact: true }).click();
  await expect(page.getByRole('img', { name: 'SVG 图像' })).toBeVisible();
});

test('keyboard copy keeps focus and reduced-motion feedback resets at 2.5 seconds', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.keyboard.press('Tab');
  const button = page.locator('.code-copy');
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAccessibleName('已复制');
  await expect(button).toBeFocused();
  await expect(page.locator('.copy-feedback')).toHaveCSS('opacity', '1');
  await page.clock.runFor(2499);
  await expect(page.locator('.copy-feedback')).toHaveCSS('opacity', '1');
  await page.clock.runFor(1);
  await expect(button).toHaveAccessibleName('复制代码');
  await expect(button).toBeFocused();
  await page.keyboard.press('Space');
  await expect(button).toHaveAccessibleName('已复制');
  expect(
    await page.evaluate(() => (window as unknown as { codeCopies: string[] }).codeCopies.length),
  ).toBe(2);
});

test('long language labels and nested SVG actions remain inside narrow containers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 600 });
  for (const source of [
    '```' + 'long-language-'.repeat(30) + '\n' + 'long_code_'.repeat(80) + '\n```',
    '> - 示例\n>\n>   ```svg\n>   <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18"/></svg>\n>   ```',
  ]) {
    await render(page, source);
    await expect(page.locator('.code-block')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const header = (await page.locator('.code-header').boundingBox())!;
    const buttons = page.locator('.code-actions button');
    for (const button of await buttons.all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(header.x);
      expect(box.x + box.width).toBeLessThanOrEqual(header.x + header.width);
      expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
      await expect(button).toBeInViewport();
    }
  }
});
