import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

async function setup(
  page: import('@playwright/test').Page,
  reason = 'available',
  terminal = 'committed',
  mode = 'connected',
) {
  await page.addInitScript(
    ({ reason, terminal, protocol, mode }) => {
      let installed = false,
        checks = 0,
        cancellations = 0,
        disconnected = false,
        installInput: unknown;
      let finishCheck: (() => void) | undefined;
      const candidate = { build: 2, appVersion: '0.3.6', protocol, sha256: 'b'.repeat(64) };
      const noOp = () => {};
      const api = {
        dev: true,
        platform: 'win32',
        boot: { connection: '', shared: { connections: [], busy: [] } },
        device: async () => {
          if (mode === 'identity-pending') await new Promise(() => {});
          return { id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'test' };
        },
        version: async () => '0.3.6',
        loadLogin: async () => null,
        workspaceRoots: async () => [],
        foldersExist: async (folders: string[]) => folders.map(() => true),
        windowSettings: async () => ({ closeToTray: false }),
        connections: async () => [],
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
            if (reason === 'missing-credential')
              throw Error(
                "Error invoking remote method 'managed-server:check': Error: 请先在管理中心配置此工作空间的服务凭据。",
              );
            if (reason === 'pending')
              await new Promise<void>((resolve) => {
                finishCheck = resolve;
              });
            return {
              schema: 1,
              current: { build: 1, appVersion: '0.3.6', protocol, sha256: null },
              reason: reason === 'pending' ? 'available' : reason,
              candidate: ['available', 'pending'].includes(reason) ? candidate : null,
              compatible: ['available', 'pending'].includes(reason),
            };
          },
          install: async (input: unknown) => {
            installed = true;
            installInput = input;
          },
          status: async () => ({ phase: terminal, current: candidate, target: candidate }),
          cancel: async () => {
            cancellations++;
          },
        },
        managedUpdate: {
          state: async () => ({ phase: 'disabled' }),
          subscribe: () => noOp,
          activity: async () => {},
        },
      };
      if (reason === 'missing-credential')
        Object.assign(api, {
          dev: false,
          access: {
            load: async () => null,
            login: async () => ({
              email: 'owner@example.com',
              workspaces: [{ id: 'ubuntu-cc', name: 'Ubuntu' }],
            }),
            ticket: async () => ({
              url: 'wss://service.example/ws',
              fingerprint: '',
              token: 'ccs_' + 'x'.repeat(43),
            }),
            logout: async () => {},
            onExpired: () => noOp,
          },
        });
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
        value: () => ({ installed, checks, cancellations, disconnected, installInput }),
      });
      Object.defineProperty(window, 'finishUpgradeCheck', { value: () => finishCheck?.() });
    },
    { reason, terminal, protocol: PROTOCOL_VERSION, mode },
  );
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'auth')
        route.send(
          JSON.stringify({
            ...(mode === 'connected' || mode === 'active'
              ? {
                  type: 'ready',
                  protocolVersion: PROTOCOL_VERSION,
                  version: '0.3.6',
                  connectionId: randomUUID(),
                  adapter: 'claude-code',
                  sessions:
                    mode === 'active'
                      ? [
                          {
                            id: randomUUID(),
                            title: 'Running session',
                            projectPath: 'C:/fixture',
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            activeRun: {
                              id: randomUUID(),
                              connectionId: randomUUID(),
                              status: 'running',
                            },
                          },
                        ]
                      : [],
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
  if (reason === 'missing-credential') {
    await page.getByLabel('邮箱', { exact: true }).fill('owner@example.com');
    await page.getByLabel('密码', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '设置与账号', exact: true })).toBeVisible();
    return;
  }
  await page.getByLabel('服务地址', { exact: true }).fill('wss://service.example/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('fixture-token-with-at-least-24-characters');
  if (mode !== 'none') await page.getByRole('button', { name: '连接', exact: true }).click();
}

async function openMaintenance(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('menuitem', { name: '检查服务端更新', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '配套服务端更新' })).toBeVisible();
}

test('settings checks a signed target then requires explicit installation confirmation', async ({
  page,
}) => {
  await setup(page);
  await openMaintenance(page);
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
  await openMaintenance(page);
  await expect(page.getByText(/首次.*Ubuntu.*接入命令/)).toBeVisible();
  await expect(page.getByRole('button', { name: '打开 CC管理中心' })).toBeVisible();
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
});

test('legacy management failure shows concise text and spaced footer buttons', async ({
  page,
}, testInfo) => {
  await setup(page, 'missing-credential');
  await openMaintenance(page);
  const dialog = page.getByRole('dialog', { name: '配套服务端更新' });
  await expect(dialog.getByRole('status')).toHaveText('服务端暂时无法更新，请稍后重试。');
  await expect(dialog.getByRole('status')).not.toContainText('Error invoking remote method');
  await expect(dialog.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  const reconnect = dialog.getByRole('button', { name: '重新连接', exact: true });
  const manager = dialog.getByRole('button', { name: '打开 CC管理中心', exact: true });
  const a = (await reconnect.boundingBox())!;
  const b = (await manager.boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(1);
  expect(b.x - a.x - a.width).toBeCloseTo(8, 0);
  await dialog.screenshot({ path: testInfo.outputPath('server-update-missing-credential.png') });
  await page.setViewportSize({ width: 320, height: 560 });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await manager.scrollIntoViewIfNeeded();
  await expect(manager).toBeInViewport();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: false,
  });
});

test('closing maintenance discards confirmation and reconnecting can recheck a rollback target', async ({
  page,
}) => {
  await setup(page, 'available', 'rolled-back');
  await openMaintenance(page);
  await expect(page.getByRole('button', { name: '确认升级到 Build 2', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('changed-fixture-token-at-least-24-characters');
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await openMaintenance(page);
  await page.getByRole('button', { name: '确认升级到 Build 2', exact: true }).click();
  await expect(page.getByText(/已回滚.*原版本/)).toBeVisible();
});

test('ordinary login omits service maintenance and makes no update checks', async ({ page }) => {
  await setup(page, 'available', 'committed', 'none');
  await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: false,
    checks: 0,
  });
});

test('settings cannot start maintenance while login is waiting for the device identity', async ({
  page,
}) => {
  await setup(page, 'available', 'committed', 'identity-pending');
  await page.keyboard.press('Control+Comma');
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '关于与更新', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({ checks: 0 });
});

test('protocol mismatch recovery opens maintenance from the login form', async ({ page }) => {
  await setup(page, 'available', 'committed', 'mismatch');
  await expect(page.getByRole('alert')).toContainText('协议不匹配');
  await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '处理连接版本不匹配', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '配套服务端更新' })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认升级到 Build 2', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    checks: 1,
    installed: false,
  });
});

test('connected settings confirms disconnect, retains unsaved credentials, then checks the same protocol build', async ({
  page,
}) => {
  await setup(page, 'available', 'committed', 'connected');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  const check = page.getByRole('menuitem', { name: '检查服务端更新', exact: true });
  await expect(check).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await check.click();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    checks: 0,
    disconnected: false,
  });
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
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
  await setup(page, 'current');
  await openMaintenance(page);
  await expect(page.getByText(/当前可用构建，无需升级/)).toBeVisible();
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: false,
    checks: 1,
  });
});

test('disconnecting an active session returns to a usable login without starting maintenance', async ({
  page,
}) => {
  await setup(page, 'available', 'committed', 'active');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '检查服务端更新', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({ checks: 0 });
});

for (const shortcuts of [
  { enabled: false, keys: {} },
  { enabled: true, keys: { settings: '' } },
]) {
  test(`version mismatch recovery works without a settings shortcut: ${JSON.stringify(shortcuts)}`, async ({
    page,
  }) => {
    await page.addInitScript((shortcuts) => {
      localStorage.setItem('proxy-prefs', JSON.stringify({ shortcuts }));
    }, shortcuts);
    await setup(page, 'available', 'committed', 'mismatch');
    await expect(page.getByRole('alert')).toContainText('协议不匹配');
    await page.getByRole('button', { name: '处理连接版本不匹配', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '确认升级到 Build 2', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
      checks: 1,
      installed: false,
    });
  });
}

test('maintenance fits a short narrow window with a large interface font in both themes', async ({
  page,
}) => {
  await setup(page);
  await openMaintenance(page);
  await expect(page.getByRole('button', { name: '确认升级到 Build 2', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 560 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.fontSize = '20px';
    }, theme);
    const dialog = page.getByRole('dialog', { name: '配套服务端更新' });
    await page.screenshot({
      path: `.local/screenshots/login-maintenance-${theme}-320.png`,
      fullPage: true,
    });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await dialog
      .getByRole('button', { name: '确认升级到 Build 2', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole('button', { name: '确认升级到 Build 2', exact: true }),
    ).toBeInViewport();
  }
});

test('Escape closes maintenance and restores keyboard focus to the login form', async ({
  page,
}) => {
  await setup(page);
  await openMaintenance(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('服务地址', { exact: true })).toBeFocused();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    installed: false,
  });
});

test('closing an in-flight check cancels it and ignores its late result', async ({ page }) => {
  await setup(page, 'pending');
  await openMaintenance(page);
  await expect(page.getByRole('status')).toContainText('正在验证配套服务端发布签名');
  const before = await page.evaluate(() => (window as any).upgradeFixture().cancellations);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).upgradeFixture().cancellations)).toBeGreaterThan(
    before,
  );
  await page.evaluate(() => (window as any).finishUpgradeCheck());
  await expect(page.getByRole('button', { name: /确认升级到/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).upgradeFixture())).toMatchObject({
    checks: 1,
    installed: false,
  });
});
