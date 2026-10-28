import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';

async function desktopLogin(page: Page, fingerprint = '') {
  await page.addInitScript((fingerprint) => {
    const noOp = () => {};
    const api = {
      dev: true,
      platform: 'win32',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.6',
      managedUpdate: undefined,
      windowSettings: async () => ({ closeToTray: false }),
      connections: async () => [],
      loadSchedules: async (text: string) => ({ path: '', text }),
      workspaceRoots: async () => [],
      device: async () => ({ id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'test' }),
      connectProxy: async (input: unknown) => {
        Object.defineProperty(window, 'loginAttempt', { value: input });
        throw Error('Fixture connection failed');
      },
      loadLogin: async () => ({
        url: 'wss://service.example/ws',
        mode: 'remote',
        token: '',
        fingerprint,
        remember: false,
        autoLogin: false,
      }),
      managedServer: {
        cancel: async () => {},
        check: async () => {
          throw Error('Unexpected update check');
        },
      },
    };
    Object.defineProperty(window, 'desktop', {
      value: new Proxy(api, {
        get: (target, key) =>
          key in target
            ? target[key as keyof typeof target]
            : String(key).startsWith('on')
              ? () => noOp
              : async () => undefined,
      }),
    });
  }, fingerprint);
  await page.goto('/');
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveValue(
    'wss://service.example/ws',
  );
}

test('login concentrates on connecting and reveals optional certificate configuration on demand', async ({
  page,
}) => {
  await desktopLogin(page);
  await expect(page.getByRole('button', { name: '本机设置', exact: true })).toHaveCount(0);
  await expect(page.locator('.login-links, .project-link')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveCSS('height', '44px');
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCSS('height', '44px');
  const fingerprint = page.getByLabel('服务证书指纹', { exact: true });
  await expect(fingerprint).toBeHidden();
  const advanced = page.getByText('高级连接选项', { exact: true });
  await advanced.click();
  await expect(fingerprint).toBeVisible();
  await fingerprint.fill('AB:CD');
  await advanced.click();
  await expect(fingerprint).toBeHidden();
  await advanced.click();
  await expect(fingerprint).toHaveValue('AB:CD');
  await page.getByLabel('自动登录', { exact: true }).check();
  await expect(page.getByLabel('记住凭据', { exact: true })).toBeChecked();
  await page.getByLabel('记住凭据', { exact: true }).uncheck();
  await expect(page.getByLabel('自动登录', { exact: true })).not.toBeChecked();
});

test('keyboard disclosure retains a collapsed fingerprint when submitting the login form', async ({
  page,
}) => {
  await desktopLogin(page, 'AB:CD:EF');
  const advanced = page.locator('.login-advanced summary');
  await advanced.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('服务证书指纹', { exact: true })).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('记住凭据', { exact: true })).toBeFocused();
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('fixture-token-with-at-least-24-characters');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Fixture connection failed');
  expect(await page.evaluate(() => (window as any).loginAttempt)).toMatchObject({
    url: 'wss://service.example/ws',
    fingerprint: 'AB:CD:EF',
  });
});

test('expanded certificate configuration remains reachable in a short narrow window', async ({
  page,
}) => {
  await desktopLogin(page, 'AB:'.repeat(31) + 'CD');
  await page.setViewportSize({ width: 320, height: 560 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.fontSize = '20px';
    }, theme);
    await page.screenshot({
      path: resolve(`.local/screenshots/login-expanded-${theme}-320.png`),
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '连接', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '连接', exact: true })).toBeInViewport();
    await page.getByLabel('服务地址', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('服务地址', { exact: true })).toBeInViewport();
  }
});

test('saved certificate fingerprints are immediately visible and local settings retain keyboard access', async ({
  page,
}) => {
  await desktopLogin(page, 'AB:CD:EF');
  const fingerprint = page.getByLabel('服务证书指纹', { exact: true });
  await expect(fingerprint).toBeVisible();
  await expect(fingerprint).toHaveValue('AB:CD:EF');
  await page.keyboard.press('Control+Comma');
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await expect(fingerprint).toHaveValue('AB:CD:EF');
});

test('login card stays centered and readable in both themes, narrow windows and large interface fonts', async ({
  page,
}) => {
  await desktopLogin(page);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const [width, fontSize] of [
      [1240, 14],
      [320, 14],
      [320, 20],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      const geometry = await page.locator('.login-card').evaluate((card) => {
        const rect = card.getBoundingClientRect();
        return {
          center: Math.abs(rect.left + rect.width / 2 - innerWidth / 2),
          fits: rect.left >= 0 && rect.right <= innerWidth,
        };
      });
      expect(geometry.center).toBeLessThan(1);
      expect(geometry.fits).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(page.getByRole('button', { name: '连接', exact: true })).toBeInViewport();
      await page.screenshot({
        path: resolve(`.local/screenshots/login-layout-${theme}-${width}-${fontSize}.png`),
        fullPage: true,
      });
    }
  }
});

test('advanced options expand and collapse smoothly without moving the brand or form heading', async ({
  page,
}) => {
  await desktopLogin(page);
  const measure = () =>
    page.evaluate(() => {
      const top = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect().top;
      return {
        brand: top('.login-content > .brand'),
        heading: top('#login-heading'),
        trigger: top('.login-advanced summary'),
      };
    });
  const before = await measure();
  for (const open of [true, false]) {
    const heights = await page.evaluate(async () => {
      const card = document.querySelector('.login-card')!;
      const heights = [card.getBoundingClientRect().height];
      (document.querySelector('.login-advanced summary') as HTMLElement).click();
      const start = performance.now();
      while (performance.now() - start < 400) {
        await new Promise(requestAnimationFrame);
        heights.push(card.getBoundingClientRect().height);
      }
      return heights;
    });
    const after = await measure();
    expect
      .soft(Math.abs(after.brand - before.brand), `brand anchor after open=${open}`)
      .toBeLessThan(1);
    expect
      .soft(Math.abs(after.heading - before.heading), `heading anchor after open=${open}`)
      .toBeLessThan(1);
    expect
      .soft(Math.abs(after.trigger - before.trigger), `trigger anchor after open=${open}`)
      .toBeLessThan(1);
    const min = Math.min(...heights),
      max = Math.max(...heights);
    expect.soft(max - min).toBeGreaterThan(50);
    expect
      .soft(
        heights.some((height) => height > min + 2 && height < max - 2),
        `intermediate animation frame for open=${open}`,
      )
      .toBe(true);
  }
});

test('advanced options handle rapid reversal and reduced motion while preserving keyboard access', async ({
  page,
}) => {
  await desktopLogin(page);
  const advanced = page.locator('.login-advanced');
  const trigger = advanced.locator('summary');
  await trigger.click();
  const fingerprint = page.getByLabel('服务证书指纹', { exact: true });
  await fingerprint.fill('AB:CD');
  await page.evaluate(async () => {
    const trigger = document.querySelector('.login-advanced summary') as HTMLElement;
    for (let i = 0; i < 4; i++) {
      trigger.click();
      await new Promise(requestAnimationFrame);
    }
  });
  await expect(advanced).toHaveAttribute('open', '');
  await expect(fingerprint).toBeVisible();
  await expect(fingerprint).toHaveValue('AB:CD');
  await expect(advanced.locator('.login-advanced-grid')).not.toHaveAttribute('inert');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(fingerprint).toBeHidden();
  await expect(advanced.locator('.login-advanced-grid')).toHaveAttribute('inert', '');
  await expect(advanced.locator('.login-advanced-grid')).toHaveCSS('transition-duration', '0s');
  await trigger.focus();
  await page.keyboard.press('Space');
  await expect(fingerprint).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(fingerprint).toBeFocused();
});

test('certificate keyboard focus is fully visible inside the animated disclosure', async ({
  page,
}) => {
  await desktopLogin(page, 'AB:CD:EF');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1240, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '20px';
      });
      await page.locator('.login-advanced summary').focus();
      await page.keyboard.press('Tab');
      const input = page.getByLabel('服务证书指纹', { exact: true });
      await expect(input).toBeFocused();
      await expect(page.locator('.login-advanced-grid')).toHaveCSS('opacity', '1');
      const clearance = await input.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const clip = element.closest('.login-advanced-content')!.getBoundingClientRect();
        const style = getComputedStyle(element);
        const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const address = document
          .querySelector<HTMLInputElement>('input[type="url"]')!
          .getBoundingClientRect();
        return {
          left: box.left - clip.left,
          right: clip.right - box.right,
          ring,
          alignment: Math.abs(box.left - address.left),
          widthDifference: Math.abs(box.width - address.width),
        };
      });
      await page.screenshot({
        path: resolve(`.local/screenshots/login-certificate-focus-${theme}-${width}.png`),
        fullPage: true,
      });
      expect
        .soft(clearance.left, `${theme}/${width}: left focus ring clearance`)
        .toBeGreaterThanOrEqual(clearance.ring);
      expect
        .soft(clearance.right, `${theme}/${width}: right focus ring clearance`)
        .toBeGreaterThanOrEqual(clearance.ring);
      expect.soft(clearance.alignment).toBeLessThan(1);
      expect.soft(clearance.widthDifference).toBeLessThan(1);
    }
  }
});

test('brand and field anchors remain stable throughout every animation frame across window sizes', async ({
  page,
}) => {
  await desktopLogin(page);
  for (const theme of ['light', 'dark']) {
    for (const [width, height, font] of [
      [1240, 800, 14],
      [320, 900, 20],
      [320, 560, 20],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        ({ theme, font }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.fontSize = `${font}px`;
          window.scrollTo(0, 0);
        },
        { theme, font },
      );
      for (const open of [true, false]) {
        const frames = await page.evaluate(async () => {
          const sample = () => {
            const brand = document
              .querySelector('.login-content > .brand')!
              .getBoundingClientRect();
            const address = document.querySelector('input[type="url"]')!.getBoundingClientRect();
            return [brand.left, brand.top + scrollY, address.left, address.top + scrollY];
          };
          const frames = [sample()];
          (document.querySelector('.login-advanced summary') as HTMLElement).click();
          const start = performance.now();
          while (performance.now() - start < 300) {
            await new Promise(requestAnimationFrame);
            frames.push(sample());
          }
          return frames;
        });
        for (let axis = 0; axis < frames[0].length; axis++) {
          const values = frames.map((frame) => frame[axis]);
          expect(
            Math.max(...values) - Math.min(...values),
            `${theme}/${width}×${height}/font${font}/open=${open}/axis${axis}`,
          ).toBeLessThan(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
  }
});

test('disclosure visibility and keyboard access change together before the delayed native toggle event', async ({
  page,
}) => {
  await desktopLogin(page);
  for (const open of [true, false]) {
    const state = await page.evaluate(async () => {
      (document.querySelector('.login-advanced summary') as HTMLElement).click();
      // Native toggle events are queued as a later task; discrete React updates finish in this microtask.
      await Promise.resolve();
      const details = document.querySelector('.login-advanced') as HTMLDetailsElement;
      const content = details.querySelector('.login-advanced-grid') as HTMLElement;
      return {
        open: details.open,
        inert: content.inert,
        hidden: content.getAttribute('aria-hidden'),
      };
    });
    expect(state).toEqual({ open, inert: !open, hidden: String(!open) });
  }
});

for (const key of ['Enter', 'Space']) {
  test(`Tab immediately after opening with ${key} reaches the certificate during the animation`, async ({
    page,
  }) => {
    await desktopLogin(page);
    await page.locator('.login-advanced summary').focus();
    await page.keyboard.press(key);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('服务证书指纹', { exact: true })).toBeFocused();
  });
}
