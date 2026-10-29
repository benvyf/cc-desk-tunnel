import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { ManagedUpdateState } from '../src/managed-update.ts';

declare global {
  interface Window {
    updateFixture: {
      offer: (protocol?: number, build?: number) => void;
      publish: (change: Partial<ManagedUpdateState>) => void;
      finish: () => void;
      fail: () => void;
      calls: string[];
    };
    finishInitialUpdateRead: () => void;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((protocol) => {
    const noOp = () => {};
    const calls: string[] = [];
    const listeners = new Set<(state: ManagedUpdateState) => void>();
    const identity = { appVersion: '0.3.7', build: 18, protocol, channel: 'pilot' };
    let state: ManagedUpdateState = { phase: 'idle', identity };
    let finish = noOp;
    let fail = noOp;
    let failureMessage = '下载连接中断，请重试。';
    const publish = (change: Partial<ManagedUpdateState>) => {
      state = { ...state, ...change };
      listeners.forEach((listener) => listener(state));
    };
    window.updateFixture = {
      calls,
      publish,
      offer: (nextProtocol = protocol, build = 19) =>
        publish({
          phase: nextProtocol === protocol ? 'available' : 'idle',
          release: {
            appVersion: '0.3.7',
            build,
            protocol: nextProtocol,
            notes: '## 更新内容\n\n修复连接问题，保留定制功能。',
            size: 1024,
          },
        }),
      finish: () => finish(),
      fail: () => fail(),
    };
    const api = {
      dev: true,
      platform: 'win32',
      boot: { connection: '', shared: { connections: [], busy: [] } },
      version: async () => '0.3.7',
      loadLogin: async () => null,
      workspaceRoots: async () => [],
      windowSettings: async () => ({ closeToTray: false }),
      connections: async () => [],
      loadSchedules: async (text: string) => ({ path: '', text }),
      device: async () => ({ id: 'e04aef32-195f-48c0-a45a-34ebd8b0aa94', name: 'fixture' }),
      connectProxy: async () => ({ url: 'ws://127.0.0.1:18889/ws' }),
      access: undefined,
      managedServer: undefined,
      managedUpdate: {
        state: async () => state,
        subscribe: (listener: (state: ManagedUpdateState) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        activity: async ({ blocked }: { blocked: boolean }) => {
          calls.push(`activity:${blocked}`);
        },
        download: () => {
          calls.push('download');
          failureMessage = '下载连接中断，请重试。';
          publish({ phase: 'downloading', received: 512 });
          return new Promise<ManagedUpdateState>((resolve, reject) => {
            finish = () => {
              publish({ phase: 'ready', received: 1024 });
              resolve(state);
            };
            fail = () => {
              publish({ phase: 'error', message: failureMessage });
              reject(Error('IPC operation rejected'));
            };
          });
        },
        check: async () => {
          calls.push('check');
          publish({ phase: 'available', message: undefined });
          return state;
        },
        cancel: async () => {
          calls.push('cancel');
          failureMessage = '更新已取消。';
          fail();
          return state;
        },
        install: async () => {
          calls.push('install');
          publish({ phase: 'preparing' });
          return state;
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
  }, PROTOCOL_VERSION);
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'auth')
        route.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.7',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions: [],
            update: { state: 'available', latest: '99.0.0' },
            client: { version: '99.0.0', size: 1, sha256: 'a'.repeat(64) },
          }),
        );
      else if (message.requestId)
        route.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true }));
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('wss://fixture.example/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('fixture-token-at-least-24-characters');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('button', { name: '设置与账号', exact: true })).toBeVisible();
});

test('a newer Build exposes the rail action, downloads, then installs after disconnect', async ({
  page,
}, testInfo) => {
  const update = page.getByRole('button', { name: '更新', exact: true });
  await expect(update).toHaveCount(0);
  await page.evaluate(() => window.updateFixture.offer(undefined, 18));
  await expect(update).toHaveCount(0);
  await page.evaluate(() => window.updateFixture.offer());
  await expect(update).toHaveAttribute('aria-haspopup', 'dialog');
  const updateBox = await update.boundingBox();
  const settingsBox = await page
    .getByRole('button', { name: '设置与账号', exact: true })
    .boundingBox();
  expect(updateBox!.y + updateBox!.height).toBeLessThanOrEqual(settingsBox!.y);
  await update.click();
  const dialog = page.getByRole('dialog', { name: '更新', exact: true });
  await expect(dialog).toContainText('目标版本：0.3.7 · Build 19');
  await expect(dialog).toContainText('修复连接问题，保留定制功能。');
  await expect(update).toHaveCSS('background-color', 'rgb(10, 132, 255)');
  await page.screenshot({ path: testInfo.outputPath('update-dialog.png') });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(dialog.getByRole('button', { name: '下载更新' })).toBeInViewport();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('update-dialog-dark-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await dialog.getByRole('button', { name: '下载更新' }).click();
  await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '50');
  await page.evaluate(() => window.updateFixture.finish());
  await expect(dialog.getByRole('button', { name: '安装并重启' })).toBeDisabled();
  await dialog.getByRole('button', { name: '断开当前连接' }).click();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '安装并重启' })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await update.click();
  await page.getByRole('button', { name: '安装并重启' }).click();
  await expect(page.getByRole('heading', { name: '正在准备安装更新' })).toBeVisible();
  expect(await page.evaluate(() => window.updateFixture.calls.slice(-2))).toEqual([
    'activity:false',
    'install',
  ]);
});

test('ready update keeps install and close together on desktop and narrow windows', async ({
  page,
}, testInfo) => {
  await page.evaluate(() => {
    window.updateFixture.offer();
    window.updateFixture.publish({ phase: 'ready' });
  });
  await page.getByRole('button', { name: '更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新', exact: true });
  const install = dialog.getByRole('button', { name: '安装并重启', exact: true });
  const close = dialog.getByRole('button', { name: '关闭', exact: true }).last();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(install).toBeDisabled();
    await expect(close).toBeInViewport();
    const a = (await install.boundingBox())!;
    const b = (await close.boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(b.x - a.x - a.width).toBeCloseTo(8, 0);
    expect(b.x + b.width).toBeLessThanOrEqual(width);
  }
  await dialog.getByRole('button', { name: '断开当前连接' }).click();
  await expect(install).toBeEnabled();
  await page.setViewportSize({ width: 734, height: 600 });
  await dialog.screenshot({ path: testInfo.outputPath('update-ready-footer.png') });
  await close.click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.updateFixture.calls.includes('install'))).toBe(false);
});

test('incompatible releases direct the user to the management center without offering installation', async ({
  page,
}) => {
  await page.evaluate((protocol) => window.updateFixture.offer(protocol + 1), PROTOCOL_VERSION);
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('安排客户端与服务端配套升级');
  await expect(page.getByRole('button', { name: /下载更新|安装并重启/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.updateFixture.calls.includes('download'))).toBe(false);
});

test('download errors remain visible and can be retried', async ({ page }) => {
  await page.evaluate(() => window.updateFixture.offer());
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('button', { name: '下载更新' }).click();
  await page.evaluate(() => window.updateFixture.fail());
  await expect(page.getByRole('alert')).toContainText('下载连接中断');
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '下载更新' }).click();
  await page.getByRole('button', { name: '取消下载' }).click();
  await expect(page.getByRole('alert')).toHaveText('更新已取消。');
  expect(await page.evaluate(() => window.updateFixture.calls.includes('cancel'))).toBe(true);
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible();
});

test('late initial state cannot erase a newer update notification', async ({ page }) => {
  await page.addInitScript(() => {
    const pending: ((state: ManagedUpdateState) => void)[] = [];
    window.desktop!.managedUpdate.state = () => new Promise((resolve) => pending.push(resolve));
    window.finishInitialUpdateRead = () => {
      pending.forEach((resolve) => resolve({ phase: 'idle' }));
    };
  });
  await page.reload();
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeVisible();
  await page.evaluate(() => window.updateFixture.offer());
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible();
  await page.evaluate(() => window.finishInitialUpdateRead());
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible();
});

test('a successful update from another window clears the previous local error', async ({
  page,
}) => {
  await page.evaluate(() => window.updateFixture.offer());
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('button', { name: '下载更新' }).click();
  await page.evaluate(() => window.updateFixture.fail());
  await expect(page.getByRole('alert')).toContainText('下载连接中断');
  await page.evaluate(() => window.updateFixture.publish({ phase: 'ready', message: undefined }));
  await expect(page.getByRole('button', { name: '安装并重启' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('initial state read failures have a visible retry entry', async ({ page }) => {
  await page.addInitScript(() => {
    const api = window.desktop!.managedUpdate;
    const read = api.state;
    api.state = async () => {
      throw Error('fixture read failure');
    };
    api.check = async () => {
      window.updateFixture.offer();
      return read();
    };
  });
  await page.reload();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法读取更新状态');
  await page.getByRole('button', { name: '重新检查' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下载更新' })).toBeEnabled();
});

test('email sign-in survives disconnecting for installation without starting another automatic login', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.desktop!.dev = false;
    window.desktop!.access = {
      load: async () => null,
      login: async ({ email }) => {
        window.updateFixture.calls.push('email-login');
        return { email, workspaces: [{ id: 'fixture', name: '我的 Ubuntu' }] };
      },
      ticket: async () => ({
        url: 'wss://fixture.example/ws',
        fingerprint: '',
        token: 'ccs_' + 'x'.repeat(43),
      }),
      logout: async () => {
        window.updateFixture.calls.push('email-logout');
      },
      onExpired: () => () => {},
    };
  });
  await page.reload();
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.com');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByLabel('自动登录', { exact: true }).check();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '设置与账号', exact: true })).toBeVisible();
  await page.evaluate(() => window.updateFixture.offer());
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('button', { name: '下载更新' }).click();
  await page.evaluate(() => window.updateFixture.finish());
  await page.getByRole('button', { name: '断开当前连接' }).click();
  await expect(page.getByRole('heading', { name: '登录 CC SPACE' })).toBeVisible();
  await expect(page.getByLabel('自动登录', { exact: true })).toBeChecked();
  await expect(page.getByLabel('记住登录', { exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '安装并重启' })).toBeEnabled();
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('button', { name: '安装并重启' }).click();
  await expect(page.getByRole('heading', { name: '正在准备安装更新' })).toBeVisible();
  expect(
    await page.evaluate(() => window.updateFixture.calls.filter((call) => call === 'email-login')),
  ).toHaveLength(1);
  expect(await page.evaluate(() => window.updateFixture.calls)).not.toContain('email-logout');
});

for (const scenario of ['success', 'lost-response', 'current', 'skip', 'mismatch'] as const) {
  test(`email server update ${scenario} preserves authorization and reconnects`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      ({ protocol, scenario }) => {
        window.desktop!.dev = false;
        const record = (action: string, input?: unknown) =>
          window.updateFixture.calls.push(action + ':' + JSON.stringify(input));
        window.desktop!.access = {
          load: async () => null,
          login: async ({ email }) => ({
            email,
            workspaces: [{ id: 'fixture', name: '我的 Ubuntu' }],
          }),
          ticket: async () => {
            record('ticket');
            return {
              url: 'wss://fixture.example/ws',
              fingerprint: '',
              token: 'ccs_' + 'x'.repeat(43),
            };
          },
          logout: async () => {
            record('logout');
          },
          onExpired: () => () => {},
        };
        let polls = 0;
        const release = { appVersion: '0.3.7', build: 6, protocol, sha256: 'b'.repeat(64) };
        window.desktop!.managedServer = {
          check: async (input) => {
            record('check', input);
            return {
              schema: 1,
              current: { appVersion: '0.3.7', build: 5, protocol, sha256: null },
              candidate: scenario === 'current' ? null : release,
              compatible: true,
              reason: scenario === 'current' ? 'current' : 'available',
            } as any;
          },
          install: async (input) => {
            record('install', input);
            if (scenario === 'lost-response')
              throw Error('服务管理网络请求失败；请稍候查询升级状态。');
            return { accepted: true, build: input.build, sha256: input.sha256 };
          },
          status: async (input) => {
            record('status', input);
            if (++polls === 1) throw Error('服务管理网络请求失败；正在重启。');
            return { schema: 1, phase: 'committed', current: release, target: release } as any;
          },
          cancel: async () => {},
          openManager: async () => {},
        };
      },
      { protocol: PROTOCOL_VERSION, scenario },
    );
    if (scenario === 'mismatch') {
      let attempts = 0;
      await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
        route.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === 'auth')
            route.send(
              JSON.stringify(
                ++attempts === 1
                  ? {
                      type: 'connection.error',
                      code: 'version_mismatch',
                      message: '协议不匹配。',
                      service: '0.3.6',
                    }
                  : {
                      type: 'ready',
                      protocolVersion: PROTOCOL_VERSION,
                      version: '0.3.7',
                      connectionId: randomUUID(),
                      adapter: 'claude-code',
                      sessions: [],
                    },
              ),
            );
          else if (message.requestId)
            route.send(
              JSON.stringify({ type: 'response', requestId: message.requestId, ok: true }),
            );
        });
      });
    }
    await page.reload();
    await page.getByLabel('邮箱', { exact: true }).fill('owner@example.com');
    await page.getByLabel('密码', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    if (scenario === 'mismatch') {
      await expect(page.getByRole('alert')).toContainText('协议不匹配');
      await page.getByRole('button', { name: '检查服务端更新', exact: true }).click();
    } else {
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: '检查更新', exact: true }).click();
      const update = page.getByRole('dialog', { name: '更新', exact: true });
      await expect(update.getByRole('heading', { name: '客户端', exact: true })).toBeVisible();
      await expect(update.getByRole('heading', { name: '服务端', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('client-server-updates.png') });
      page.once('dialog', (dialog) => dialog.accept());
      await update.getByRole('button', { name: '检查服务端更新', exact: true }).click();
    }
    const server = page.getByRole('dialog', { name: '配套服务端更新' });
    await expect(server).toContainText('当前版本 0.3.7 · Build 5');
    const installing = ['success', 'lost-response', 'mismatch'].includes(scenario);
    if (installing) {
      await server.getByRole('button', { name: '确认升级到 Build 6', exact: true }).click();
      await expect(server.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
      await expect(server).toContainText('服务端升级已完成');
    } else if (scenario === 'current') {
      await expect(server).toContainText('无需升级');
    }
    const calls = await page.evaluate(() => window.updateFixture.calls);
    expect(calls).toContain('check:{"nodeId":"fixture"}');
    expect(calls.filter((call) => call.startsWith('install:'))).toEqual(
      installing
        ? [
            'install:' +
              JSON.stringify({
                nodeId: 'fixture',
                confirmed: true,
                build: 6,
                sha256: 'b'.repeat(64),
              }),
          ]
        : [],
    );
    expect(calls.some((call) => call.startsWith('logout'))).toBe(false);
    await server.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(page.getByRole('button', { name: '设置与账号', exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => window.updateFixture.calls.filter((call) => call.startsWith('ticket:')).length,
      ),
    ).toBe(2);
  });
}
