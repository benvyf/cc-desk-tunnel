import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';
const device = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '本机',
  platform: 'win32' as const,
};
const make = (title: string, path: string): Session => ({
  id: randomUUID(),
  title,
  autoTitle: false,
  projectPath: path,
  device,
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: '2026-11-05T10:00:00Z',
  updatedAt: '2026-11-05T10:00:00Z',
  activeRun: null,
});
async function setup(
  page: Page,
  longHistory = false,
  nativeRemote = false,
  provisionalDefaults = false,
) {
  const sessions = [make('项目 A 会话', 'D:\\work\\a'), make('项目 B 会话', 'D:\\work\\b')];
  if (nativeRemote)
    sessions.push({
      ...make('远程项目会话', '/work/app'),
      device: {
        id: '00000000-0000-4000-8000-000000000002',
        name: '01',
        platform: 'linux',
        viaSsh: true,
      },
    });
  const commands: any[] = [];
  let send: (v: object) => void = () => {};
  const url = 'ws://127.0.0.1:18983/ws';
  let loseRemoteResponse = false;
  let held = false;
  let releaseRemote: () => void = () => {};
  let loseLocalResponse = false;
  let failConfigure = false;
  const localResults = new Map<string, Session>();
  let holdLocal = false;
  let releaseLocal: () => void = () => {};
  const remoteResults = new Map<string, string>();
  if (nativeRemote) {
    await page.exposeFunction(
      'testRemoteProject',
      async (id: string, path: string, forceNew: boolean, creationId?: string) => {
        commands.push({ type: 'ssh.openProject', id, path, forceNew, creationId });
        if (held)
          await new Promise<void>((resolve) => {
            releaseRemote = resolve;
          });
        const key = creationId ?? randomUUID();
        let sessionId = remoteResults.get(key);
        if (!sessionId) {
          const session = {
            ...make('远程新会话', path),
            ...(provisionalDefaults
              ? { permissionMode: 'auto' as const, updatedAt: '2026-11-06T10:00:00Z' }
              : {}),
            device: { id, name: '01', platform: 'linux' as const, viaSsh: true as const },
          };
          sessions.push(session);
          sessionId = session.id;
          remoteResults.set(key, sessionId);
          send({ type: 'session.updated', session });
        }
        if (loseRemoteResponse) {
          loseRemoteResponse = false;
          throw new Error('模拟创建响应丢失');
        }
        return { sessionId, created: true };
      },
    );
    await page.addInitScript((device) => {
      const off = () => () => {};
      const changes = new Set<(entries: any[]) => void>();
      const entries = [
        {
          id: '00000000-0000-4000-8000-000000000002',
          name: '01',
          host: 'fixture.invalid',
          port: 22,
          username: 'dev',
          auth: 'key',
          projects: ['/work/app'],
          available: true,
          status: 'connected',
          error: '',
        },
      ];
      (window as any).testSetTargetStatus = (status: string) => {
        entries[0].status = status;
        changes.forEach((fn) => fn([...entries]));
      };
      window.open = () => null;
      (window as any).desktop = {
        terminalWindow: { focus: async () => true, setActive: async () => {} },
        dev: true,
        platform: 'win32',
        boot: { connection: 'fixture', shared: {} },
        onSharedChanged: off,
        saveShared: async () => {},
        version: async () => '0.3.10',
        onUpdateProgress: off,
        loadLogin: async () => null,
        saveLogin: async () => {},
        disconnectProxy: async () => {},
        onProxyClosed: off,
        device: async () => device,
        workspaceRoots: async () => ['/work', 'D:\\sessions'],
        foldersExist: async (paths: string[]) => paths.map(() => true),
        loadDrafts: async () => ({}),
        saveDrafts: async () => {},
        loadSchedules: async (text: string) => text,
        saveSchedules: async () => {},
        onSchedulesChanged: off,
        onNotifyClicked: off,
        setBusy: async () => {},
        gitBranch: async () => null,
        notify: async () => {},
        asOnDisk: async (path: string) => path,
        createWorkspace: async () => 'D:\\sessions\\2026-11-06\\123456',
        removeWorkspace: async () => {},
        ssh: {
          list: async () => entries,
          onChanged: (fn: (entries: any[]) => void) => {
            changes.add(fn);
            return () => changes.delete(fn);
          },
          connect: async () => {
            (window as any).testSetTargetStatus('connected');
          },
          openProject: (id: string, path: string, forceNew: boolean, creationId?: string) =>
            (window as any).testRemoteProject(id, path, forceNew, creationId),
          directories: async (_id: string, path: string) => ({
            path: path || '/work/app',
            parent: '/work',
            directories: [],
          }),
        },
      };
    }, device);
  }

  await page.addInitScript((device) => {
    localStorage.setItem('proxy-device', device.id);
  }, device);
  await page.routeWebSocket(url, (route) => {
    send = (v) => route.send(JSON.stringify(v));
    route.onMessage((raw) => {
      const c = JSON.parse(String(raw));
      commands.push(c);
      if (c.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.10',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          terminalWorkspace: { version: 1, minRows: 1, resumable: true },
          sessions,
        });
        send({
          type: 'devices',
          devices: [
            { ...device, ready: true },
            ...(nativeRemote
              ? [
                  {
                    id: '00000000-0000-4000-8000-000000000002',
                    name: '01',
                    platform: 'linux',
                    viaSsh: true,
                    ready: true,
                  },
                ]
              : []),
          ],
        });
        return;
      }
      if (c.type === 'device' || !c.requestId) return;
      if (c.type === 'session.configure' && failConfigure) {
        failConfigure = false;
        send({ type: 'response', requestId: c.requestId, ok: false, message: '配置暂时失败' });
        return;
      }
      if (c.type === 'session.configure' && provisionalDefaults) {
        const session = sessions.find((session) => session.id === c.sessionId);
        if (session) {
          Object.assign(session, {
            permissionMode: c.permissionMode,
            ...('model' in c ? { model: c.model } : {}),
            ...('effort' in c ? { effort: c.effort } : {}),
          });
          send({ type: 'session.updated', session });
        }
      }
      if (c.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: c.requestId,
          session: sessions.find((s) => s.id === c.sessionId),
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: longHistory
            ? Array.from({ length: 60 }, (_, index) => ({
                sessionId: c.sessionId,
                runId: sessions[0].id,
                sequence: index + 1,
                createdAt: '2026-11-05T10:00:00Z',
                payload: {
                  type: 'message.user',
                  messageId: randomUUID(),
                  text: `历史消息 ${index} ${'内容用于阅读位置测试。'.repeat(12)}`,
                  scenario: 'chat',
                },
              }))
            : [],
        });
      if (c.type === 'terminal.open') {
        const session = sessions.find((s) => s.id === c.sessionId)!;
        session.activeRun = {
          id: randomUUID(),
          status: 'running',
          surface: 'terminal',
          connectionId: randomUUID(),
        };
        send({ type: 'session.updated', session });
        send({ type: 'terminal.opened', sessionId: c.sessionId, terminalId: session.activeRun.id });
      }
      if (c.type === 'session.create' || c.type === 'terminal.session.create') {
        let session = localResults.get(c.requestId);
        if (!session) {
          const source = sessions.find((s) => s.id === c.sourceSessionId);
          session = {
            ...make('新会话', c.projectPath ?? source?.projectPath ?? ''),
            ...(provisionalDefaults && c.type === 'session.create'
              ? { permissionMode: 'auto' as const, updatedAt: '2026-11-06T10:00:00Z' }
              : {}),
            ...(source
              ? {
                  device: source.device,
                  model: source.model,
                  permissionMode: source.permissionMode,
                  effort: source.effort,
                }
              : {}),
          };
          sessions.push(session);
          localResults.set(c.requestId, session);
        }
        send({ type: 'session.updated', session });
        if (loseLocalResponse) {
          loseLocalResponse = false;
          send({
            type: 'response',
            requestId: c.requestId,
            ok: false,
            message: '模拟本机创建响应丢失',
          });
          return;
        }
        const finish = () =>
          send({ type: 'response', requestId: c.requestId, ok: true, sessionId: session.id });
        if (holdLocal) releaseLocal = finish;
        else finish();
        return;
      }
      send({ type: 'response', requestId: c.requestId, ok: true });
    });
  });
  await page.goto('/');
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill('isolated-multi-device-test-credential');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return {
    sessions,
    commands,
    send,
    failNextConfigure: () => {
      failConfigure = true;
    },
    loseNextRemoteResponse: () => {
      loseRemoteResponse = true;
    },
    holdRemote: () => {
      held = true;
    },
    releaseRemote: () => {
      held = false;
      releaseRemote();
    },
    loseNextLocalResponse: () => {
      loseLocalResponse = true;
    },
    holdLocal: () => {
      holdLocal = true;
    },
    releaseLocal: () => {
      holdLocal = false;
      releaseLocal();
    },
  };
}
const select = (page: Page, title: string) =>
  page.locator('.session-row').filter({ hasText: title }).getByRole('button').first().click();
test('terminal A stays mounted while independent chat B is navigated and draft is retained', async ({
  page,
}) => {
  const { commands } = await setup(page);
  await select(page, '项目 B 会话');
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('B 的草稿');
  await select(page, '项目 A 会话');
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await expect(page.locator('.native-terminal')).toHaveCount(1);
  await select(page, '项目 B 会话');
  await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('B 的草稿');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
  expect(commands.filter((c) => c.type === 'terminal.open')).toHaveLength(1);
  expect(
    commands.filter((c) => c.type === 'terminal.close' || c.type === 'session.move'),
  ).toHaveLength(0);
  await select(page, '项目 A 会话');
  await expect(page.getByText('正在终端里运行', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
});
test('desktop new session uses an ordinary local workspace while a different terminal runs', async ({
  page,
}) => {
  const { commands } = await setup(page, false, true);
  await select(page, '项目 A 会话');
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await select(page, '项目 B 会话');
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await expect.poll(() => commands.filter((c) => c.type === 'session.create').length).toBe(1);
  expect(commands.find((c) => c.type === 'session.create').projectPath).toBe(
    'D:\\sessions\\2026-11-06\\123456',
  );
});
test('existing terminal window cannot bypass active graphical run check', async ({ page }) => {
  const { sessions, commands, send } = await setup(page);
  await select(page, '项目 A 会话');
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await expect.poll(() => commands.filter((c) => c.type === 'terminal.open').length).toBe(1);
  sessions[1].activeRun = { id: randomUUID(), status: 'running', connectionId: randomUUID() };
  send({ type: 'session.updated', session: sessions[1] });
  await select(page, '项目 B 会话');
  await expect(page.getByRole('button', { name: '终端', exact: true })).toBeDisabled();
  expect(commands.filter((c) => c.type === 'terminal.open')).toHaveLength(1);
});

test('chat reading position survives switching to another project', async ({ page }) => {
  await setup(page, true);
  await select(page, '项目 B 会话');
  const conversation = page.locator('.conversation');
  await expect(page.locator('[data-message-id]')).toHaveCount(60);
  await conversation.evaluate((node) => node.scrollTo(0, 300));
  await expect.poll(() => conversation.evaluate((node) => node.scrollTop)).toBeGreaterThan(250);
  const before = await conversation.evaluate((node) => node.scrollTop);
  await select(page, '项目 A 会话');
  await select(page, '项目 B 会话');
  await expect
    .poll(() =>
      conversation.evaluate((node, position) => Math.abs(node.scrollTop - position), before),
    )
    .toBeLessThan(30);
});

test('desktop top new session and shortcut stay local when a remote project is selected', async ({
  page,
}) => {
  const { commands } = await setup(page, false, true);
  for (const shortcut of [false, true]) {
    await select(page, '远程项目会话');
    if (shortcut) await page.keyboard.press('Control+n');
    else await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
    await expect
      .poll(() => commands.filter((c) => c.type === 'session.create').length)
      .toBe(shortcut ? 2 : 1);
  }
  expect(commands.filter((c) => c.type === 'ssh.openProject')).toHaveLength(0);
  expect(
    commands
      .filter((c) => c.type === 'session.create')
      .every((c) => c.projectPath.startsWith('D:\\sessions')),
  ).toBe(true);
});

test('connected remote new-session retry reuses creation identity after lost response', async ({
  page,
}) => {
  const fixture = await setup(page, false, true);
  await select(page, '远程项目会话');
  fixture.loseNextRemoteResponse();
  await page
    .locator('.project-group')
    .filter({ hasText: '远程项目会话' })
    .getByRole('button', { name: /新建会话/ })
    .click();
  await expect(page.getByRole('alert').filter({ hasText: '模拟创建响应丢失' })).toBeVisible();
  await page
    .locator('.project-group')
    .filter({ hasText: '远程项目会话' })
    .getByRole('button', { name: /新建会话/ })
    .click();
  await expect(page.locator('.titlebar h1')).toHaveText('远程新会话');
  const calls = fixture.commands.filter((c) => c.type === 'ssh.openProject');
  expect(calls).toHaveLength(2);
  expect(calls[0].creationId).toBeTruthy();
  expect(calls[1].creationId).toBe(calls[0].creationId);
  expect(fixture.sessions.filter((s) => s.title === '远程新会话')).toHaveLength(1);
});

test('home draft follows explicit project choice without sending it automatically', async ({
  page,
}) => {
  const fixture = await setup(page, false, true);
  await page
    .getByRole('textbox', { name: '新会话的第一条消息', exact: true })
    .fill('这段需求要保留到远程项目');
  await page.getByRole('button', { name: '本机 · 普通会话', exact: true }).click();
  await page
    .getByRole('combobox', { name: '开发设备', exact: true })
    .selectOption('00000000-0000-4000-8000-000000000002');
  await page.getByRole('dialog').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '这段需求要保留到远程项目',
  );
  expect(fixture.commands.filter((c) => c.type === 'message.send')).toHaveLength(0);
});
test('late remote creation keeps the new session but does not steal navigation from another project', async ({
  page,
}) => {
  const fixture = await setup(page, false, true);
  await select(page, '远程项目会话');
  fixture.holdRemote();
  await page
    .locator('.project-group')
    .filter({ hasText: '远程项目会话' })
    .getByRole('button', { name: /新建会话/ })
    .click();
  await expect
    .poll(() => fixture.commands.filter((c) => c.type === 'ssh.openProject').length)
    .toBe(1);
  await select(page, '项目 B 会话');
  fixture.releaseRemote();
  await expect.poll(() => fixture.sessions.filter((s) => s.title === '远程新会话').length).toBe(1);
  await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
});
test('main project identity and sidebar remain usable across light dark and narrow windows', async ({
  page,
}) => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir('.local/screenshots/multi-device-main', { recursive: true });
  await setup(page, false, true);
  await select(page, '远程项目会话');
  for (const theme of ['light', 'dark'])
    for (const width of [1280, 1000, 800, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.locator('.session-project')).toContainText('01');
      expect(
        await page
          .locator('.session-project')
          .evaluate((node) => node.getBoundingClientRect().right <= innerWidth),
      ).toBe(true);
      const open = page.getByRole('button', { name: '展开会话列表', exact: true });
      if (await open.isVisible()) await open.click();
      await expect(page.locator('.project-device').filter({ hasText: '01' })).toBeVisible();
      await page.screenshot({
        path: `.local/screenshots/multi-device-main/main-${theme}-${width}.png`,
        animations: 'disabled',
      });
      if (width < 888) await page.keyboard.press('Escape');
    }
});

test('waiting terminal in another project raises a navigable notice without taking focus', async ({
  page,
}) => {
  const { sessions, send } = await setup(page);
  await select(page, '项目 B 会话');
  sessions[0].activeRun = {
    id: randomUUID(),
    status: 'running',
    connectionId: randomUUID(),
    surface: 'terminal',
    activity: 'working',
  };
  send({ type: 'session.updated', session: sessions[0] });
  await expect(page.locator('.session-row').filter({ hasText: '项目 A 会话' })).toContainText(
    '终端运行中',
  );
  sessions[0].activeRun.activity = 'waiting';
  send({ type: 'session.updated', session: sessions[0] });
  await expect(page.getByRole('button', { name: '通知（1 条未读）', exact: true })).toBeVisible();
  await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
  await page.getByRole('button', { name: '通知（1 条未读）', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '通知', exact: true })).toContainText(
    '终端等待确认或回答',
  );
});

test('local creation response does not steal navigation after the user selects another project', async ({
  page,
}) => {
  const fixture = await setup(page);
  await select(page, '项目 A 会话');
  fixture.holdLocal();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await expect
    .poll(() => fixture.commands.filter((c) => c.type === 'session.create').length)
    .toBe(1);
  await select(page, '项目 B 会话');
  fixture.releaseLocal();
  await expect(page.getByRole('button', { name: '新建会话', exact: true }).first()).toBeEnabled();
  await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
});
test('lost remote creation identity survives retry through the offline reconnect dialog', async ({
  page,
}) => {
  const fixture = await setup(page, false, true);
  await select(page, '远程项目会话');
  fixture.loseNextRemoteResponse();
  await page
    .locator('.project-group')
    .filter({ hasText: '远程项目会话' })
    .getByRole('button', { name: /新建会话/ })
    .click();
  await expect(page.getByRole('alert').filter({ hasText: '模拟创建响应丢失' })).toBeVisible();
  await page.evaluate(() => (window as any).testSetTargetStatus('disconnected'));
  await page
    .locator('.project-group')
    .filter({ hasText: '远程项目会话' })
    .getByRole('button', { name: /新建会话/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('远程新会话');
  const calls = fixture.commands.filter((c) => c.type === 'ssh.openProject');
  expect(calls).toHaveLength(2);
  expect(calls[1].creationId).toBe(calls[0].creationId);
  expect(fixture.sessions.filter((s) => s.title === '远程新会话')).toHaveLength(1);
});

test('terminal owned by another window has no return action', async ({ page }) => {
  const { sessions, commands, send } = await setup(page);
  sessions[0].activeRun = {
    id: randomUUID(),
    status: 'running',
    connectionId: randomUUID(),
    surface: 'terminal',
    activity: 'working',
  };
  send({ type: 'session.updated', session: sessions[0] });
  await select(page, '项目 A 会话');
  await expect(page.getByText('此会话正在另一个窗口的终端中使用', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返回终端', exact: true })).toHaveCount(0);
  expect(commands.filter((c) => c.type === 'terminal.open')).toHaveLength(0);
});

test('home local project creation retry keeps one session and its draft', async ({ page }) => {
  const fixture = await setup(page, false, true);
  fixture.loseNextLocalResponse();
  await page.getByRole('textbox', { name: '新会话的第一条消息', exact: true }).fill('本机草稿');
  await page.getByRole('button', { name: '本机 · 普通会话', exact: true }).click();
  await page.getByRole('textbox', { name: '本机项目目录', exact: true }).fill('D:\\retry-local');
  await page.getByRole('dialog').getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('模拟本机创建响应丢失');
  await page.getByRole('dialog').getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('本机草稿');
  const calls = fixture.commands.filter((c) => c.type === 'session.create');
  expect(calls).toHaveLength(2);
  expect(calls[1].requestId).toBe(calls[0].requestId);
  expect(fixture.sessions.filter((s) => s.title === '新会话')).toHaveLength(1);
});

test('late native directory validation cannot create a project on a changed service connection', async ({
  page,
}) => {
  const fixture = await setup(page, false, true);
  await page.evaluate(() => {
    (window as any).desktop.asOnDisk = () =>
      new Promise((resolve) => {
        (window as any).finishLocalValidation = resolve;
      });
  });
  await page.getByRole('button', { name: '本机 · 普通会话', exact: true }).click();
  await page
    .getByRole('textbox', { name: '本机项目目录', exact: true })
    .fill('D:\\old-service-project');
  await page.getByRole('dialog').getByRole('button', { name: '打开项目', exact: true }).click();
  await page.waitForFunction(() => typeof (window as any).finishLocalValidation === 'function');
  fixture.send({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.3.10',
    connectionId: randomUUID(),
    adapter: 'claude-code',
    terminalWorkspace: { version: 1, minRows: 1, resumable: true },
    sessions: fixture.sessions,
  });
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.evaluate(() => (window as any).finishLocalValidation('D:\\old-service-project'));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(fixture.commands.filter((c) => c.type === 'session.create')).toHaveLength(0);
});

test('any terminal prevents status reads and refresh, then the last exit reads the selected session once', async ({
  page,
}) => {
  const { commands, sessions, send } = await setup(page);
  await select(page, '项目 A 会话');
  await expect
    .poll(() => commands.filter((c) => c.type === 'session.status').length)
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await expect.poll(() => commands.filter((c) => c.type === 'terminal.open').length).toBe(1);
  await select(page, '项目 B 会话');
  const box = page.getByRole('textbox', { name: '消息', exact: true });
  await box.fill('/refresh');
  await page.getByRole('option', { name: /刷新原生状态/ }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: '终端运行时暂不读取原生状态' }),
  ).toBeVisible();
  expect(
    commands.filter((c) => c.type === 'session.status' && c.sessionId === sessions[1].id),
  ).toHaveLength(0);
  const terminalId = sessions[0].activeRun!.id;
  sessions[0].activeRun = null;
  send({ type: 'session.updated', session: sessions[0] });
  send({ type: 'terminal.closed', sessionId: sessions[0].id, terminalId, exitCode: 0 });
  await expect
    .poll(
      () =>
        commands.filter((c) => c.type === 'session.status' && c.sessionId === sessions[1].id)
          .length,
    )
    .toBe(1);
  await select(page, '项目 A 会话');
  await select(page, '项目 B 会话');
  expect(
    commands.filter((c) => c.type === 'session.status' && c.sessionId === sessions[1].id),
  ).toHaveLength(1);
});

for (const remote of [false, true])
  test(`project menu creates ${remote ? 'remote' : 'local'} terminals without changing main selection`, async ({
    page,
  }) => {
    const { commands, sessions } = await setup(page, false, true);
    await select(page, '项目 B 会话');
    const source = remote ? sessions[2] : sessions[0];
    for (let index = 0; index < 2; index++) {
      await page
        .locator('.project-group')
        .filter({ hasText: source.title })
        .getByRole('button', { name: /项目操作/ })
        .click();
      await page.getByRole('menuitem', { name: '新建终端', exact: true }).click();
      await expect(page.getByRole('tab')).toHaveCount(index + 1);
      await expect
        .poll(() => commands.filter((c) => c.type === 'terminal.open').length)
        .toBe(index + 1);
      await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
    }
    const firstId = commands.find((c) => c.type === 'terminal.open').sessionId;
    expect(
      commands.find((c) => c.type === 'session.configure' && c.sessionId === firstId)
        ?.permissionMode,
    ).toBe('default');
    await expect(page.locator('.side-terminal-note')).toHaveCount(0);
    await expect(page.locator('.project-device').filter({ hasText: '本机' })).toHaveCount(0);
  });

for (const remote of [false, true])
  test(`project terminal ${remote ? 'remote' : 'local'} configure failure keeps a dialog and retries one session`, async ({
    page,
  }) => {
    const fixture = await setup(page, false, true);
    await select(page, '项目 B 会话');
    fixture.failNextConfigure();
    const source = fixture.sessions[remote ? 2 : 0];
    await page
      .locator('.project-group')
      .filter({ hasText: source.title })
      .getByRole('button', { name: /项目操作/ })
      .click();
    await page.getByRole('menuitem', { name: '新建终端', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '打开项目', exact: true });
    await expect(dialog.getByRole('alert')).toContainText('配置暂时失败');
    expect(fixture.commands.filter((c) => c.type === 'terminal.open')).toHaveLength(0);
    await dialog
      .getByRole('button', { name: remote ? '新建会话' : '打开项目', exact: true })
      .click();
    await expect
      .poll(() => fixture.commands.filter((c) => c.type === 'terminal.open').length)
      .toBe(1);
    const configurations = fixture.commands.filter((c) => c.type === 'session.configure');
    expect(configurations).toHaveLength(2);
    expect(configurations[0].sessionId).toBe(configurations[1].sessionId);
    expect(fixture.sessions).toHaveLength(4);
    await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
  });

for (const remote of [false, true])
  for (const interruption of ['lost reply', 'cancelled configuration']) {
    test(`terminal creation retry keeps original ${remote ? 'remote' : 'local'} settings after ${interruption}`, async ({
      page,
    }) => {
      const fixture = await setup(page, false, true, true);
      await select(page, '项目 B 会话');
      const source = fixture.sessions[remote ? 2 : 0];
      Object.assign(source, { model: 'original-model', effort: 'high', permissionMode: 'default' });
      fixture.send({ type: 'session.updated', session: source });
      const open = async () => {
        await page
          .locator('.project-group')
          .filter({ hasText: source.title })
          .getByRole('button', { name: /项目操作/ })
          .click();
        await page.getByRole('menuitem', { name: '新建终端', exact: true }).click();
      };
      if (interruption === 'lost reply') {
        if (remote) fixture.loseNextRemoteResponse();
        else fixture.loseNextLocalResponse();
      } else fixture.failNextConfigure();
      await open();
      if (interruption === 'cancelled configuration') {
        const dialog = page.getByRole('dialog', { name: '打开项目', exact: true });
        await expect(dialog.getByRole('alert')).toContainText('配置暂时失败');
        // A failed in-dialog retry must also preserve the intent if the dialog is then canceled.
        fixture.failNextConfigure();
        await dialog
          .getByRole('button', { name: remote ? '新建会话' : '打开项目', exact: true })
          .click();
        await expect
          .poll(() => fixture.commands.filter((c) => c.type === 'session.configure').length)
          .toBe(2);
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      } else
        await expect(page.getByRole('alert').filter({ hasText: '创建响应丢失' })).toBeVisible();
      const pending = fixture.sessions.at(-1)!;
      expect(pending.permissionMode).toBe('auto');
      expect(fixture.commands.filter((c) => c.type === 'terminal.open')).toHaveLength(0);
      await open();
      await expect
        .poll(() => fixture.commands.filter((c) => c.type === 'terminal.open').length)
        .toBe(1);
      const configuration = fixture.commands.filter((c) => c.type === 'session.configure').at(-1);
      expect(configuration).toMatchObject({
        sessionId: pending.id,
        permissionMode: 'default',
        model: 'original-model',
        effort: 'high',
      });
      expect(fixture.sessions).toHaveLength(4);
      const creations = fixture.commands.filter(
        (c) => c.type === (remote ? 'ssh.openProject' : 'session.create'),
      );
      expect(new Set(creations.map((c) => (remote ? c.creationId : c.requestId))).size).toBe(1);
      await expect(page.locator('.titlebar h1')).toHaveText('项目 B 会话');
    });
  }

for (const remote of [false, true])
  test(`terminal creation retry keeps initial defaults for a saved ${remote ? 'remote' : 'local'} project`, async ({
    page,
  }) => {
    const fixture = await setup(page, false, true, true);
    await select(page, '项目 B 会话');
    const path = remote ? '/work/saved-project' : 'D:\\saved-project';
    if (remote)
      await page.evaluate(async (path) => {
        const targets = await (window as any).desktop.ssh.list();
        targets[0].projects.push(path);
        (window as any).testSetTargetStatus('connected');
      }, path);
    else {
      await page.getByRole('button', { name: '打开项目', exact: true }).click();
      await page.getByRole('textbox', { name: '本机项目目录', exact: true }).fill(path);
      await page.getByRole('dialog').getByRole('button', { name: '打开项目', exact: true }).click();
    }
    const defaults = async (model: string) =>
      page.evaluate(async (model) => {
        const modulePath = '/src/prefs.ts';
        const { setPrefs } = await import(modulePath);
        setPrefs((prefs: any) => ({ ...prefs, sessionDefaults: { model, effort: 'high' } }));
      }, model);
    await defaults('original-default');
    const open = async () => {
      await page
        .locator('.project-group')
        .filter({ hasText: 'saved-project' })
        .getByRole('button', { name: /项目操作/ })
        .click();
      await page.getByRole('menuitem', { name: '新建终端', exact: true }).click();
    };
    if (remote) fixture.loseNextRemoteResponse();
    else fixture.loseNextLocalResponse();
    await open();
    await expect(page.getByRole('alert').filter({ hasText: '创建响应丢失' })).toBeVisible();
    await defaults('later-default');
    await open();
    await expect
      .poll(() => fixture.commands.filter((c) => c.type === 'terminal.open').length)
      .toBe(1);
    expect(fixture.commands.filter((c) => c.type === 'session.configure').at(-1)).toMatchObject({
      permissionMode: 'default',
      model: 'original-default',
      effort: 'high',
    });
    expect(fixture.sessions).toHaveLength(4);
  });
