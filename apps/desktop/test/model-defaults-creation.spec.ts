import { expect, test, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const saved = { sessionDefaults: { model: 'opus', effort: 'max' } };

async function service(page: Page, browser: boolean, fail = false) {
  const commands: Record<string, unknown>[] = [];
  const sessions: Session[] = [];
  const serverDeviceId = randomUUID();
  let finish: (() => void) | undefined;
  const accept = (socket: {
    send: (value: string) => void;
    onMessage: (handler: (raw: string | Buffer) => void) => void;
  }) => {
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      const response = (sessionId?: string) =>
        send({ type: 'response', requestId: command.requestId, ok: true, sessionId });
      if (command.type === 'device') return;
      if (command.type === 'auth' || command.type === 'web.auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.6',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
          ...(browser
            ? { browser: { sessionId: randomUUID(), serverDeviceId, selfSigned: false } }
            : {}),
        });
        if (browser)
          send({
            type: 'devices',
            devices: [{ id: serverDeviceId, name: '服务端', platform: 'linux', ready: true }],
          });
        return;
      }
      if (command.type === 'server.session.create' || command.type === 'session.create') {
        const now = new Date().toISOString();
        const session: Session = {
          id: randomUUID(),
          title: '新会话',
          autoTitle: false,
          projectPath: command.projectPath ?? '/work/defaults',
          permissionMode: 'auto',
          model: null,
          effort: null,
          createdAt: now,
          updatedAt: now,
          activeRun: null,
          ...(browser ? { device: { id: serverDeviceId, name: '服务端', platform: 'linux' } } : {}),
        };
        sessions.push(session);
        send({ type: 'session.updated', session });
        response(session.id);
        return;
      }
      if (command.type === 'session.configure') {
        finish = () => {
          if (fail)
            send({
              type: 'response',
              requestId: command.requestId,
              ok: false,
              message: '测试配置失败',
            });
          else {
            const session = sessions.find((item) => item.id === command.sessionId)!;
            Object.assign(session, { model: command.model, effort: command.effort });
            send({ type: 'session.updated', session });
            response(session.id);
          }
        };
        return;
      }
      if (command.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: command.requestId,
          session: sessions.find((item) => item.id === command.sessionId),
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      if (command.requestId) response(command.sessionId);
    });
  };
  let server: WebSocketServer | undefined;
  let url = '';
  if (browser) await page.routeWebSocket('**/defaults-host/api/ws', accept);
  else {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    url = `ws://127.0.0.1:${address.port}/ws`;
    server.on('connection', (socket) =>
      accept({
        send: (value) => socket.send(value),
        onMessage: (handler) => socket.on('message', (value) => handler(String(value))),
      }),
    );
  }
  return {
    commands,
    sessions,
    url,
    release: () => finish!(),
    close: async () => {
      if (!server) return;
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    },
  };
}

test('browser ordinary sessions apply saved defaults before allowing input and preserve the created permission mode', async ({
  page,
}) => {
  await page.addInitScript(
    (prefs) => localStorage.setItem('proxy-prefs', JSON.stringify(prefs)),
    saved,
  );
  await page.route('**/defaults-host/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/defaults-host/'.length);
    if (path.startsWith('api/'))
      return route.fulfill({
        json: { authenticated: true, totpEnabled: false, selfSigned: false },
      });
    return route.fulfill({ path: resolve('apps/desktop/dist', path || 'index.html') });
  });
  const fixture = await service(page, true);
  await page.goto('/defaults-host/');
  await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect
    .poll(() => fixture.commands.filter((row) => row.type === 'session.configure').length)
    .toBe(1);
  expect(fixture.commands.find((row) => row.type === 'session.configure')).toMatchObject({
    model: 'opus',
    effort: 'max',
    permissionMode: 'auto',
    sessionId: fixture.sessions[0].id,
  });
  expect(fixture.commands.some((row) => row.type === 'session.create')).toBe(false);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);
  fixture.release();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  expect(fixture.sessions[0]).toMatchObject({
    model: 'opus',
    effort: 'max',
    permissionMode: 'auto',
  });
});

test('Electron: an ordinary session keeps its workspace when applying defaults fails', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  test.slow();
  const profile = mkdtempSync(resolve('.local/defaults-profile-'));
  mkdirSync(resolve(profile, 'shared'));
  writeFileSync(resolve(profile, 'shared/prefs.json'), JSON.stringify(saved));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
    ),
  ) as Record<string, string>;
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env,
  });
  let fixture: Awaited<ReturnType<typeof service>> | undefined;
  try {
    const page = await application.firstWindow();
    const directory = profile;
    await application.evaluate(({ ipcMain }, directory) => {
      (globalThis as any).defaultWorkspaceCalls = [];
      ipcMain.removeHandler('workspace:create');
      ipcMain.removeHandler('workspace:remove');
      ipcMain.handle('workspace:create', () => {
        (globalThis as any).defaultWorkspaceCalls.push('create');
        return directory;
      });
      ipcMain.handle('workspace:remove', () => {
        (globalThis as any).defaultWorkspaceCalls.push('remove');
      });
    }, directory);
    fixture = await service(page, false, true);
    const current = fixture;
    await test.step('connect the Electron renderer', async () => {
      await page.getByRole('button', { name: '本地模拟', exact: true }).click();
      await page.getByLabel('服务地址', { exact: true }).fill(current.url);
      await page.getByLabel('服务凭据', { exact: true }).fill('test-only-default-model-token-long');
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('已连接');
    });
    await test.step('create the ordinary workspace session', async () => {
      await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click();
      await expect
        .poll(() => current.commands.filter((row) => row.type === 'session.configure').length)
        .toBe(1);
    });
    expect(fixture.commands.find((row) => row.type === 'session.create')).toMatchObject({
      projectPath: directory,
    });
    expect(fixture.commands.find((row) => row.type === 'session.configure')).toMatchObject({
      model: 'opus',
      effort: 'max',
      permissionMode: 'auto',
    });
    fixture.release();
    await expect(page.getByRole('alert')).toContainText(
      '新会话已创建，但默认模型与推理强度未能应用',
    );
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
    expect(await application.evaluate(() => (globalThis as any).defaultWorkspaceCalls)).toEqual([
      'create',
    ]);
    expect(fixture.sessions).toHaveLength(1);
  } finally {
    await application.close();
    await fixture?.close();
  }
});
