import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
      recoverUpgradeCheck?: () => void;
      finishUpgradeOpen?: () => void;
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

for (const scenario of [
  'available',
  'unpublished',
  'automatic',
  'multiple',
  'check-retry',
  'opening',
] as const) {
  test(`client upgrade notice at sign-in: ${scenario}`, async ({ page }, testInfo) => {
    await page.addInitScript(
      ({ scenario, protocol }) => {
        window.desktop!.dev = false;
        let checkOnline = scenario !== 'check-retry';
        window.updateFixture.recoverUpgradeCheck = () => {
          checkOnline = true;
        };
        window.desktop!.access = {
          load: async () =>
            scenario === 'automatic'
              ? { email: 'owner@example.com', remember: true, autoLogin: true }
              : null,
          login: async ({ email }) => ({
            email,
            workspaces:
              scenario === 'multiple'
                ? [
                    { id: 'compatible', name: '原工作空间' },
                    { id: 'upgraded', name: '升级后的工作空间' },
                  ]
                : [{ id: 'upgraded', name: '我的 Ubuntu' }],
          }),
          ticket: async (nodeId) => {
            window.updateFixture.calls.push('ticket:' + nodeId);
            return {
              error: '需要升级客户端。',
              retryable: false,
              clientUpgrade: { requiredProtocol: protocol + 1 },
            };
          },
          upgradeInfo: async (required) => {
            window.updateFixture.calls.push('upgrade-info:' + required);
            if (!checkOnline) throw new Error('检查连接中断，请重试。');
            return scenario === 'unpublished' ? null : { build: 26, appVersion: '0.3.7' };
          },
          openUpgrade: async (required) => {
            window.updateFixture.calls.push('open-upgrade:' + required);
            if (scenario === 'opening')
              await new Promise<void>((resolve) => {
                window.updateFixture.finishUpgradeOpen = resolve;
              });
          },
          logout: async () => {
            window.updateFixture.calls.push('logout');
          },
          onExpired: () => () => {},
        };
      },
      { scenario, protocol: PROTOCOL_VERSION },
    );
    await page.reload();
    if (scenario !== 'automatic') {
      await page.getByLabel('邮箱', { exact: true }).fill('owner@example.com');
      await page.getByLabel('密码', { exact: true }).fill('fixture-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    if (scenario === 'multiple')
      await page.getByRole('button', { name: '升级后的工作空间', exact: true }).click();
    const notice = page.getByRole('dialog', { name: '需要升级客户端', exact: true });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('账号和聊天记录会保留');
    await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
    if (scenario === 'check-retry') {
      await expect(notice.getByRole('alert')).toContainText('检查连接中断');
      await notice.evaluate(async (element) => {
        await Promise.allSettled(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
      });
      await page.screenshot({ path: testInfo.outputPath('check-failed.png') });
      await page.evaluate(() => window.updateFixture.recoverUpgradeCheck?.());
      await notice.getByRole('button', { name: '重新检查', exact: true }).click();
    }
    if (scenario === 'unpublished') {
      await expect(notice).toContainText('配套客户端尚未发布');
      await expect(notice.getByRole('button', { name: '下载新版客户端', exact: true })).toHaveCount(
        0,
      );
    } else {
      await expect(notice).toContainText('Build 26');
      await notice.getByRole('button', { name: '下载新版客户端', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () => window.updateFixture.calls.filter((x) => x.startsWith('open-upgrade:')).length,
          ),
        )
        .toBe(1);
    }
    if (scenario === 'opening') {
      await expect(
        notice.getByRole('button', { name: '正在打开下载…', exact: true }),
      ).toBeDisabled();
      await notice.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(notice).toHaveCount(0);
      await page.evaluate(() => window.updateFixture.finishUpgradeOpen?.());
    }
    if (scenario === 'available')
      await page.screenshot({ path: testInfo.outputPath('client-upgrade-required.png') });
    if (scenario !== 'opening')
      await notice.getByRole('button', { name: '稍后升级', exact: true }).click();
    await expect(notice).toHaveCount(0);
    const calls = await page.evaluate(() => window.updateFixture.calls);
    expect(calls.filter((x) => x.startsWith('ticket:'))).toHaveLength(1);
    expect(calls).not.toContain('logout');
    expect(calls).not.toContain('install');
    if (scenario !== 'multiple')
      await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue('owner@example.com');
  });
}

test('retained terminal output cannot hide a client upgrade notice after refused reconnect', async ({
  page,
}) => {
  const session = {
    id: randomUUID(),
    title: '保留的终端',
    projectPath: 'D:\\fixture',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRun: null,
  };
  let closeConnection = async () => {};
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    closeConnection = () => route.close({ code: 1012, reason: 'service updated' });
    const send = (message: object) => route.send(JSON.stringify(message));
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          terminalWorkspace: { version: 1, resumable: true },
          sessions: [session],
        });
      if (command.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session,
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      if (command.type === 'terminal.open') {
        const terminalId = randomUUID();
        send({ type: 'terminal.opened', sessionId: session.id, terminalId });
        send({
          type: 'terminal.data',
          sessionId: session.id,
          terminalId,
          data: 'retained terminal output\r\n',
          bytes: 26,
        });
      }
      if (command.requestId) send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.addInitScript((protocol) => {
    window.desktop!.dev = false;
    window.desktop!.terminalWindow = { focus: async () => false, onClosed: () => () => {} };
    window.desktop!.foldersExist = async (paths) => paths.map(() => true);
    let tickets = 0;
    window.desktop!.access = {
      load: async () => null,
      login: async ({ email }) => ({ email, workspaces: [{ id: 'fixture', name: '工作空间' }] }),
      ticket: async () =>
        ++tickets === 1
          ? { url: 'wss://fixture.example/ws', fingerprint: '', token: 'ccs_' + 'x'.repeat(43) }
          : {
              error: '需要升级客户端。',
              retryable: false,
              clientUpgrade: { requiredProtocol: protocol + 1 },
            },
      upgradeInfo: async () => null,
      openUpgrade: async () => {},
      logout: async () => {},
      onExpired: () => () => {},
    };
  }, PROTOCOL_VERSION);
  await page.reload();
  await page.getByLabel('邮箱', { exact: true }).fill('owner@example.com');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.session-row').filter({ hasText: '保留的终端' }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: '终端', exact: true }).click();
  const terminalPage = await popup;
  await expect(terminalPage.locator('.native-terminal')).toBeVisible();
  await expect(terminalPage.locator('.xterm-rows')).toContainText('retained terminal output');
  await closeConnection();
  const notice = page.getByRole('dialog', { name: '需要升级客户端', exact: true });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: '稍后升级', exact: true }).click();
  await expect(terminalPage.locator('.native-terminal')).toBeVisible();
  await expect(terminalPage.locator('.xterm-rows')).toContainText('retained terminal output');
});

test('upgrade notice shares CC Space modal tokens in light dark and narrow layouts', async ({
  page,
}, testInfo) => {
  await page.addInitScript((protocol) => {
    window.desktop!.dev = false;
    window.desktop!.access = {
      load: async () => null,
      login: async ({ email }) => ({ email, workspaces: [{ id: 'fixture', name: '工作空间' }] }),
      ticket: async () => ({
        error: '需要升级客户端。',
        retryable: false,
        clientUpgrade: { requiredProtocol: protocol + 1 },
      }),
      upgradeInfo: async () => ({ build: 26, appVersion: '0.3.7' }),
      openUpgrade: async () => {},
      logout: async () => {},
      onExpired: () => () => {},
    };
  }, PROTOCOL_VERSION);
  await page.reload();
  await page.getByLabel('邮箱', { exact: true }).fill('owner@example.com');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const notice = page.getByRole('dialog', { name: '需要升级客户端', exact: true });
  await expect(notice).toContainText('Build 26');
  const measurements = [];
  for (const [theme, width] of [
    ['light', 1280],
    ['dark', 1280],
    ['dark', 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.mouse.move(0, 0);
    await notice.evaluate(async (element) => {
      getComputedStyle(element).color;
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    await expect(
      notice.getByRole('button', { name: '下载新版客户端', exact: true }),
    ).toBeInViewport();
    const box = (await notice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    measurements.push(
      await notice.evaluate((element) => {
        const s = getComputedStyle(element),
          title = getComputedStyle(element.querySelector('h2')!),
          button = getComputedStyle(element.querySelector('.button.primary')!);
        return {
          background: s.backgroundColor,
          color: s.color,
          font: s.fontFamily,
          size: s.fontSize,
          radius: s.borderRadius,
          padding: s.padding,
          titleSize: title.fontSize,
          titleWeight: title.fontWeight,
          buttonBackground: button.backgroundColor,
          buttonRadius: button.borderRadius,
          buttonHeight: button.minHeight,
        };
      }),
    );
    await page.screenshot({ path: testInfo.outputPath(`upgrade-notice-${theme}-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await notice.getByRole('button', { name: '稍后升级', exact: true }).click();
  await page.evaluate(() => window.updateFixture.offer());
  await page.getByRole('button', { name: '更新', exact: true }).click();
  const reference = page.getByRole('dialog', { name: '更新', exact: true });
  await expect(reference).toBeVisible();
  await page.mouse.move(0, 0);
  await reference.evaluate(async (element) => {
    getComputedStyle(element).color;
    await Promise.allSettled(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  const known = await reference.evaluate((element) => {
    const s = getComputedStyle(element),
      title = getComputedStyle(element.querySelector('h2')!),
      button = getComputedStyle(element.querySelector('.button.primary')!);
    return {
      background: s.backgroundColor,
      color: s.color,
      font: s.fontFamily,
      size: s.fontSize,
      radius: s.borderRadius,
      padding: s.padding,
      titleSize: title.fontSize,
      titleWeight: title.fontWeight,
      buttonBackground: button.backgroundColor,
      buttonRadius: button.borderRadius,
      buttonHeight: button.minHeight,
    };
  });
  expect(measurements[1]).toEqual(known);
  expect(measurements[2]).toEqual(known);
  await page.screenshot({ path: testInfo.outputPath('existing-update-dialog-dark.png') });
  await reference
    .locator('.managed-update-buttons')
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(reference).toHaveCount(0);
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(notice.locator('..')).toHaveAttribute('data-kind', 'dialog');
  await page.keyboard.press('Escape');
  await expect(notice).toHaveCount(0);
});

test('manual handshake fallback prompts client upgrade without a server-update action', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.desktop!.loadLogin = async () => ({
      url: 'wss://fixture.example/ws',
      fingerprint: '',
      token: 'fixture-token-at-least-24-characters',
      mode: 'remote',
      remember: true,
      autoLogin: false,
      authMethod: 'manual',
    });
    window.desktop!.access = {
      load: async () => null,
      login: async () => ({ email: '', workspaces: [] }),
      ticket: async () => {
        throw Error('manual must not request ticket');
      },
      upgradeInfo: async () => null,
      openUpgrade: async () => {},
      logout: async () => {},
      onExpired: () => () => {},
    };
    window.desktop!.managedServer = {
      check: async () => {
        throw Error('wrong action');
      },
      install: async () => {
        throw Error('wrong action');
      },
      status: async () => {
        throw Error('wrong action');
      },
      cancel: async () => {},
    };
  });
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    route.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'auth')
        route.send(
          JSON.stringify({
            type: 'connection.error',
            code: 'version_mismatch',
            message: '需要升级客户端。',
            requiredProtocol: PROTOCOL_VERSION + 1,
          }),
        );
    });
  });
  await page.reload();
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const notice = page.getByRole('dialog', { name: '需要升级客户端', exact: true });
  await expect(notice).toBeVisible();
  await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
  await notice.getByRole('button', { name: '稍后升级', exact: true }).click();
  await expect(page.getByRole('button', { name: '检查服务端更新', exact: true })).toHaveCount(0);
});

test('a newer Build exposes the update action, downloads, then installs after disconnect', async ({
  page,
}, testInfo) => {
  const update = page.getByRole('button', { name: '更新', exact: true });
  await expect(update).toHaveCount(0);
  await page.evaluate(() => window.updateFixture.offer(undefined, 18));
  await expect(update).toHaveCount(0);
  await page.evaluate(() => window.updateFixture.offer());
  await expect(update).toHaveAttribute('aria-haspopup', 'dialog');
  // Open, the column puts the update beside the account at its foot; folded, the rail puts it above.
  const account = page.getByRole('button', { name: '设置与账号', exact: true });
  const updateBox = (await update.boundingBox())!;
  const accountBox = (await account.boundingBox())!;
  expect(updateBox.x).toBeGreaterThanOrEqual(accountBox.x + accountBox.width);
  expect(updateBox.y).toBeGreaterThanOrEqual(accountBox.y);
  expect(updateBox.y + updateBox.height).toBeLessThanOrEqual(accountBox.y + accountBox.height);
  await expect(update).toHaveCSS('background-color', 'rgb(198, 97, 63)');
  // Under the pointer the clay deepens, in either place.
  await update.hover();
  await expect(update).toHaveCSS('background-color', 'rgb(180, 85, 47)');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  const railUpdate = (await update.boundingBox())!;
  expect(railUpdate.y + railUpdate.height).toBeLessThanOrEqual((await account.boundingBox())!.y);
  await expect(update).toHaveCSS('background-color', 'rgb(198, 97, 63)');
  await update.hover();
  await expect(update).toHaveCSS('background-color', 'rgb(180, 85, 47)');
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await update.click();
  const dialog = page.getByRole('dialog', { name: '更新', exact: true });
  await expect(dialog).toContainText('目标版本：0.3.7 · Build 19');
  await expect(dialog).toContainText('修复连接问题，保留定制功能。');
  // An available update is a clay circle, the brand's call to act.
  await expect(update).toHaveCSS('background-color', 'rgb(198, 97, 63)');
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
    await dialog.evaluate(async (element) => {
      await Promise.allSettled(
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    await expect(install).toBeDisabled();
    await expect(close).toBeInViewport();
    const a = (await install.boundingBox())!;
    const b = (await close.boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    // The main action last, at the right (spec §5.5): 关闭 then 安装并重启.
    expect(a.x - b.x - b.width).toBeCloseTo(8, 0);
    expect(a.x + a.width).toBeLessThanOrEqual(width);
  }
  await dialog.getByRole('button', { name: '断开当前连接' }).click();
  await expect(install).toBeEnabled();
  await page.setViewportSize({ width: 734, height: 600 });
  await dialog.screenshot({ path: testInfo.outputPath('update-ready-footer.png') });
  await close.click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.updateFixture.calls.includes('install'))).toBe(false);
});

test('incompatible releases offer a verified full package without automatic installation', async ({
  page,
}) => {
  await page.evaluate((protocol) => {
    Object.assign(window.desktop!, {
      access: {
        openUpgrade: async (required: number) => {
          window.updateFixture.calls.push(`open-package:${required}`);
        },
      },
    });
    window.updateFixture.offer(protocol + 1);
  }, PROTOCOL_VERSION);
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('安排客户端与服务端配套升级');
  await expect(page.getByRole('dialog')).toContainText('联系管理员');
  await expect(page.getByRole('dialog')).not.toContainText('CC 管理中心');
  await expect(page.getByRole('button', { name: /下载更新|安装并重启/ })).toHaveCount(0);
  await page.getByRole('button', { name: '获取完整安装包' }).click();
  expect(await page.evaluate(() => window.updateFixture.calls)).toContain(
    `open-package:${PROTOCOL_VERSION + 1}`,
  );
  expect(await page.evaluate(() => window.updateFixture.calls.includes('download'))).toBe(false);
  expect(await page.evaluate(() => window.updateFixture.calls.includes('install'))).toBe(false);
});

test('full package lookup shows its latest error and can be retried after an earlier update failure', async ({
  page,
}) => {
  await page.evaluate((protocol) => {
    let attempts = 0;
    Object.assign(window.desktop!, {
      access: {
        openUpgrade: async () => {
          window.updateFixture.calls.push('open-package');
          if (++attempts === 1) throw new Error('测试：完整包地址暂不可用');
        },
      },
    });
    window.updateFixture.offer(protocol + 1);
    window.updateFixture.publish({ phase: 'error', message: '测试：上一次检查失败' });
  }, PROTOCOL_VERSION);
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('button', { name: '获取完整安装包' }).click();
  await expect(page.getByRole('alert')).toHaveText('测试：完整包地址暂不可用');
  await page.getByRole('button', { name: '获取完整安装包' }).click();
  await expect(page.getByRole('button', { name: '获取完整安装包' })).toBeEnabled();
  expect(
    await page.evaluate(
      () => window.updateFixture.calls.filter((c) => c === 'open-package').length,
    ),
  ).toBe(2);
  expect(await page.evaluate(() => window.updateFixture.calls.includes('install'))).toBe(false);
});

test('public signed controller state exposes the full package in the update dialog', async ({
  page,
}, testInfo) => {
  const file = process.env.CC_LIVE_UPDATE_STATE;
  test.skip(!file, 'provide a state generated by the controller from the verified public index');
  const state: ManagedUpdateState = JSON.parse(readFileSync(file!, 'utf8'));
  expect(state.release!.build).toBeGreaterThan(state.identity!.build);
  expect(state.release!.protocol).toBeGreaterThan(state.identity!.protocol);
  await page.evaluate((actual) => {
    Object.assign(window.desktop!, {
      access: {
        openUpgrade: async (required: number) => {
          window.updateFixture.calls.push(`open-package:${required}`);
        },
      },
    });
    window.updateFixture.publish(actual);
  }, state);
  await page.getByRole('button', { name: '更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新', exact: true });
  await expect(dialog).toContainText(`Build ${state.release!.build}`);
  await dialog.getByRole('button', { name: '获取完整安装包' }).click();
  expect(await page.evaluate(() => window.updateFixture.calls)).toContain(
    `open-package:${state.release!.protocol}`,
  );
  await expect(dialog.getByRole('button', { name: '安装并重启' })).toHaveCount(0);
  await dialog.screenshot({ path: testInfo.outputPath('live-signed-full-package.png') });
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
      upgradeInfo: async () => null,
      openUpgrade: async () => {},
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
  await expect(page.getByRole('heading', { name: '登录 CC Space' })).toBeVisible();
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
          upgradeInfo: async () => null,
          openUpgrade: async () => {},
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
