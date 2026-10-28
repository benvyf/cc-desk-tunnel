import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const noOp = () => {};
    localStorage.setItem('proxy-url', 'wss://old-service.example/ws');
    (window as any).legacyLoginReads = 0;
    const api = {
      dev: false,
      platform: 'win32',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.7',
      managedUpdate: undefined,
      windowSettings: async () => ({ closeToTray: false }),
      connections: async () => [],
      loadSchedules: async (text: string) => ({ path: '', text }),
      workspaceRoots: async () => [],
      device: async () => ({ id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'test' }),
      loadLogin: async () => {
        (window as any).legacyLoginReads++;
        return {
          url: 'wss://old-service.example/ws',
          token: 'legacy-token',
          remember: true,
          autoLogin: true,
          mode: 'remote',
        };
      },
      access: {
        load: async () => null,
        login: async (input: { email: string; password: string }) => {
          if (input.password !== 'correct-password')
            throw Error('邮箱或密码不正确，或账号已停用。');
          return {
            email: input.email,
            workspaces: [
              { id: 'one', name: '我的 Ubuntu' },
              { id: 'two', name: '备用 Ubuntu' },
            ],
          };
        },
        ticket: async () => ({
          url: 'wss://fixture.example/ws',
          fingerprint: '',
          token: 'ccs_' + 'x'.repeat(43),
        }),
        logout: async () => {},
        onExpired: (callback: (message: string) => void) => {
          (window as unknown as { expireEmail: () => void }).expireEmail = () =>
            callback('登录已失效，请重新登录。同一账号仅允许一台电脑在线。');
          return noOp;
        },
      },
      connectProxy: async () => {
        throw Error('测试连接已到达本机通道');
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
  });
  await page.goto('/');
});

test('email-only login ignores legacy credentials, selects a workspace and exits on session expiry', async ({
  page,
}) => {
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).legacyLoginReads)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('proxy-url'))).toBeNull();
  await expect(page.getByRole('button', { name: '使用服务地址连接' })).toHaveCount(0);
  await expect(page.getByLabel('自动登录', { exact: true })).not.toBeChecked();
  await page.getByLabel('邮箱', { exact: true }).fill('me@example.com');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  await page.getByLabel('密码', { exact: true }).fill('correct-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择工作空间' })).toBeVisible();
  await page.getByRole('button', { name: '我的 Ubuntu' }).click();
  await expect(page.getByRole('alert')).toContainText('测试连接已到达本机通道');
  await page.getByRole('button', { name: '返回邮箱登录' }).click();
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('密码', { exact: true }).fill('correct-password');
  await page.getByLabel('自动登录', { exact: true }).check();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择工作空间' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { expireEmail: () => void }).expireEmail());
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('自动登录', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('记住登录', { exact: true })).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('同一账号仅允许一台电脑在线');
  await expect(page.getByRole('button', { name: '使用服务地址连接' })).toHaveCount(0);
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('email sign-in layout stays readable in both themes and supports password visibility', async ({
  page,
}) => {
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '显示密码' }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏密码' }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const [width, fontSize] of [
      [1240, 14],
      [390, 14],
      [320, 20],
    ]) {
      await page.setViewportSize({ width, height: width === 320 ? 560 : 900 });
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
      await page.getByRole('button', { name: '登录', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeInViewport();
      await page.screenshot({
        path: resolve(`.local/screenshots/email-only-${theme}-${width}-${fontSize}.png`),
        fullPage: true,
      });
    }
  }
});

test('remembered email login still restores automatically without reading a legacy token', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.desktop!.access.load = async () => ({
      email: 'remembered@example.com',
      remember: true,
      autoLogin: true,
    });
    window.desktop!.access.login = async (input) => {
      (window as any).restoredEmailInput = input;
      return {
        email: input.email,
        workspaces: [
          { id: 'one', name: '已分配工作空间' },
          { id: 'two', name: '备用工作空间' },
        ],
      };
    };
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '选择工作空间' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).restoredEmailInput)).toEqual({
    email: 'remembered@example.com',
    password: '',
    remember: true,
    autoLogin: true,
  });
  expect(await page.evaluate(() => (window as any).legacyLoginReads)).toBe(0);
});

test('missing email component never falls back to manual connection', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window.desktop as any).access;
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
  await page.getByLabel('邮箱', { exact: true }).fill('me@example.com');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱登录组件不可用');
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveCount(0);
});

test('local settings and help have no manual credential controls', async ({ page }) => {
  await page.keyboard.press('Control+Comma');
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  await expect(page.getByRole('switch', { name: '记住凭据', exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      '打开独立窗口，登录邮箱并选择管理中心分配的工作空间。各窗口的登录状态、草稿和定时任务独立，本机偏好共用。',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
});
