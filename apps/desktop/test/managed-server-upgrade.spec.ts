import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

async function setup(
  page: import('@playwright/test').Page,
  reason = 'available',
  terminal = 'committed',
  mode = 'mismatch',
) {
  await page.addInitScript(
    ({ reason, terminal, protocol, mode }) => {
      let installed = false,
        checks = 0,
        disconnected = false,
        installInput: unknown;
      const candidate = { build: 2, appVersion: '0.3.6', protocol, sha256: 'b'.repeat(64) };
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
        disconnectProxy: async () => {
          disconnected = true;
        },
        managedServer: {
          check: async () => {
            if (mode === 'connected' && !disconnected)
              throw Error('Connection must close before checking');
            checks++;
            return {
              schema: 1,
              reason,
              candidate: reason === 'available' ? candidate : null,
              compatible: reason === 'available',
            };
          },
          install: async (input: unknown) => {
            installed = true;
            installInput = input;
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
      Object.defineProperty(window, 'upgradeFixture', {
        value: () => ({ installed, checks, disconnected, installInput }),
      });
    },
    { reason, terminal, protocol: PROTOCOL_VERSION, mode },
  );
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'auth')
        route.send(
          JSON.stringify({
            ...(mode === 'connected'
              ? {
                  type: 'ready',
                  protocolVersion: PROTOCOL_VERSION,
                  version: '0.3.6',
                  connectionId: randomUUID(),
                  adapter: 'claude-code',
                  sessions: [],
                }
              : {
                  type: 'connection.error',
                  code: 'version_mismatch',
                  message: '协议不匹配。',
                  service: '0.3.6',
                }),
          }),
        );
      else if (message.requestId)
        route.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true }));
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('wss://service.example/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('fixture-token-with-at-least-24-characters');
  if (mode !== 'none') await page.getByRole('button', { name: '连接', exact: true }).click();
}

test('same semantic version protocol mismatch checks signed target then requires explicit installation confirmation', async ({
  page,
}) => {
  await setup(page);
  const upgrade = page.getByRole('button', { name: '检查服务端更新', exact: true });
  await expect(upgrade).toBeVisible();
  await upgrade.click();
  await expect(
    page.getByText(new RegExp(`0.3.6.*Build 2.*协议 ${PROTOCOL_VERSION}`)),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as { upgradeFixture: () => unknown }).upgradeFixture(),
    ),
  ).toMatchObject({ installed: false, checks: 1 });
  await page.getByRole('button', { name: '确认升级到 Build 2', exact: true }).click();
  await expect(page.getByText(/升级已完成.*手动连接/)).toBeVisible();
});

test('first Ubuntu bootstrap instruction links fixed CC management center for disabled service', async ({
  page,
}) => {
  await setup(page, 'disabled');
  await page.getByRole('button', { name: '检查服务端更新', exact: true }).click();
  await expect(page.getByText(/首次.*Ubuntu.*接入命令/)).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 CC管理中心' })).toBeVisible();
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
});

test('rollback is terminal and form changes erase the displayed confirmation', async ({ page }) => {
  await setup(page, 'available', 'rolled-back');
  await page.getByRole('button', { name: '检查服务端更新', exact: true }).click();
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('changed-fixture-token-at-least-24-characters');
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  await page.getByRole('button', { name: '检查服务端更新', exact: true }).click();
  await page.getByRole('button', { name: '确认升级到 Build 2', exact: true }).click();
  await expect(page.getByText(/已回滚.*原版本/)).toBeVisible();
});

test('connection page checks builds without requiring a prior protocol mismatch', async ({
  page,
}) => {
  await setup(page, 'available', 'committed', 'none');
  await page.getByRole('button', { name: '检查服务端更新', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认升级到 Build 2', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: false,
    checks: 1,
  });
  await page.getByRole('button', { name: '取消等待', exact: true }).click();
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
});

test('connected settings confirms disconnect, retains unsaved credentials, then checks the same protocol build', async ({
  page,
}) => {
  await setup(page, 'available', 'committed', 'connected');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '关于与更新', exact: true })
    .click();
  const check = page.getByRole('button', { name: '检查服务端更新', exact: true });
  await expect(check).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await check.click();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    checks: 0,
    disconnected: false,
  });
  page.once('dialog', (dialog) => void dialog.accept());
  await check.click();
  await expect(page.getByRole('button', { name: '确认升级到 Build 2', exact: true })).toBeVisible();
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveValue(
    'fixture-token-with-at-least-24-characters',
  );
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    checks: 1,
    disconnected: true,
    installed: false,
  });
  await page.screenshot({ path: '.local/client-server-update-confirm.png', fullPage: true });
  await page.getByRole('button', { name: '确认升级到 Build 2', exact: true }).click();
  await expect(page.getByText(/升级已完成.*手动连接/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: true,
    installInput: {
      url: 'wss://service.example/ws',
      token: 'fixture-token-with-at-least-24-characters',
      confirmed: true,
      build: 2,
      sha256: 'b'.repeat(64),
    },
  });
});

test('a current build reports no upgrade without asking for installation', async ({ page }) => {
  await setup(page, 'current', 'committed', 'none');
  await page.getByRole('button', { name: '检查服务端更新', exact: true }).click();
  await expect(page.getByText(/当前可用构建，无需升级/)).toBeVisible();
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: false,
    checks: 1,
  });
});
