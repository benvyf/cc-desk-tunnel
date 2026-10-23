import { expect, test } from '@playwright/test';

async function setup(
  page: import('@playwright/test').Page,
  reason = 'available',
  terminal = 'committed',
) {
  await page.addInitScript(
    ({ reason, terminal }) => {
      let installed = false,
        checks = 0;
      const candidate = { build: 2, appVersion: '0.3.6', protocol: 999, sha256: 'b'.repeat(64) };
      const noOp = () => {};
      const api = {
        dev: false,
        platform: 'win32',
        boot: { connection: '', shared: { connections: [], busy: [] } },
        device: async () => ({ id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'test' }),
        version: async () => '0.3.6',
        loadLogin: async () => null,
        workspaceRoots: async () => [],
        loadSchedules: async (text: string) => ({ path: '', text }),
        connectProxy: async () => ({ url: 'ws://127.0.0.1:18889/ws' }),
        managedServer: {
          check: async () => {
            checks++;
            return {
              schema: 1,
              reason,
              candidate: reason === 'available' ? candidate : null,
              compatible: reason === 'available',
            };
          },
          install: async () => {
            installed = true;
          },
          status: async () => ({ phase: terminal, current: candidate, target: candidate }),
          cancel: async () => {},
        },
        managedUpdate: {
          state: async () => ({ phase: 'disabled' }),
          subscribe: () => noOp,
          activity: async () => {},
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
      Object.defineProperty(window, 'upgradeFixture', { value: () => ({ installed, checks }) });
    },
    { reason, terminal },
  );
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    route.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'auth')
        route.send(
          JSON.stringify({
            type: 'connection.error',
            code: 'version_mismatch',
            message: '协议不匹配。',
            service: '0.3.6',
          }),
        );
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('wss://service.example/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('fixture-token-with-at-least-24-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

test('same semantic version protocol mismatch checks signed target then requires explicit installation confirmation', async ({
  page,
}) => {
  await setup(page);
  const upgrade = page.getByRole('button', { name: '升级配套服务端', exact: true });
  await expect(upgrade).toBeVisible();
  await upgrade.click();
  await expect(page.getByText(/0.3.6.*Build 2.*协议 999/)).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { upgradeFixture: () => unknown }).upgradeFixture(),
    ),
  ).toEqual({ installed: false, checks: 1 });
  await page.getByRole('button', { name: '确认升级到 Build 2', exact: true }).click();
  await expect(page.getByText(/升级已完成.*手动连接/)).toBeVisible();
});

test('first Ubuntu bootstrap instruction links fixed CC management center for disabled service', async ({
  page,
}) => {
  await setup(page, 'disabled');
  await page.getByRole('button', { name: '升级配套服务端', exact: true }).click();
  await expect(page.getByText(/首次.*Ubuntu.*接入命令/)).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 CC管理中心' })).toBeVisible();
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
});

test('rollback is terminal and form changes erase the displayed confirmation', async ({ page }) => {
  await setup(page, 'available', 'rolled-back');
  await page.getByRole('button', { name: '升级配套服务端', exact: true }).click();
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('changed-fixture-token-at-least-24-characters');
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  await page.getByRole('button', { name: '升级配套服务端', exact: true }).click();
  await page.getByRole('button', { name: '确认升级到 Build 2', exact: true }).click();
  await expect(page.getByText(/已回滚.*原版本/)).toBeVisible();
});
