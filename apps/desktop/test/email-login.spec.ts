import { expect, test } from '@playwright/test';

test('email login keeps node details out of the form, handles workspace selection and manual fallback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const noOp = () => {};
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
      loadLogin: async () => null,
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
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: '使用服务地址连接' }).click();
  await expect(page.getByLabel('服务地址', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '使用邮箱登录' }).click();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
