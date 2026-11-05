import { test, expect } from '@playwright/test';
const fixture = '/test/terminal-window.fixture.html';
const api = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).terminalTest.requests);
test('new terminal picker deduplicates projects and routes the chosen device source', async ({
  page,
}) => {
  await page.goto(fixture);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    const base = f.snapshot().sessions[0];
    f.update({
      sessions: [
        base,
        {
          ...base,
          id: 'remote-old',
          projectPath: '/work/app',
          updatedAt: '2026-11-04',
          device: { id: '02', name: '02', viaSsh: true },
          model: 'old',
        },
        {
          ...base,
          id: 'remote-new',
          projectPath: '/work/app',
          updatedAt: '2026-11-05',
          device: { id: '02', name: '02', viaSsh: true },
          model: 'latest',
        },
      ],
    });
  });
  await page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '新建终端', exact: true });
  await picker.getByRole('textbox', { name: '搜索设备或项目', exact: true }).fill('02');
  await expect(picker.getByRole('button', { name: 'app · 02', exact: true })).toHaveCount(1);
  await picker.getByRole('button', { name: 'app · 02', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await api(page)).find((r: any) => r.type === 'terminal.session.create')).toMatchObject({
    sourceSessionId: 'remote-new',
    model: 'latest',
  });
  await expect(page.getByRole('tab').last().locator('.terminal-tab-device')).toHaveText('02');
});
test('workspace refuses a busy chat session and keeps disconnected session ownership', async ({
  page,
}) => {
  await page.goto(fixture);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTest.occupied))
    .toEqual(['fixture']);
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    const base = f.snapshot().sessions[0];
    f.update({
      sessions: [
        base,
        {
          ...base,
          id: 'chat-busy',
          activeRun: { id: 'chat-run', surface: 'chat', status: 'running' },
        },
      ],
    });
    f.showSession('chat-busy');
  });
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect((await api(page)).filter((r: any) => r.type === 'terminal.open')).toHaveLength(1);
  await page.evaluate(() => (window as any).terminalTest.emit({ type: 'terminal.detached' }));
  await expect
    .poll(() => page.evaluate(() => (window as any).terminalTest.occupied))
    .toEqual(['fixture']);
});
test('same-project plus reads latest session configuration and keeps one-click creation', async ({
  page,
}) => {
  await page.goto(fixture);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    f.update({
      sessions: f.snapshot().sessions.map((s: any) => ({ ...s, model: 'updated', effort: 'high' })),
    });
  });
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toHaveAttribute(
    'title',
    '在 fixture-node · fixture 中新建终端',
  );
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await api(page)).find((r: any) => r.type === 'terminal.session.create')).toMatchObject({
    model: 'updated',
    effort: 'high',
  });
});

test('a saved remote project without a source creates one session and opens its terminal', async ({
  page,
}) => {
  await page.goto(fixture + '?remoteProjects=1');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }).click();
  await page.getByRole('button', { name: 'first · 02', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/work/first');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await api(page)).filter((r: any) => r.type === 'ssh.openProject')).toEqual([
    { type: 'ssh.openProject', id: '02', path: '/work/first', forceNew: true },
  ]);
  expect((await api(page)).filter((r: any) => r.type === 'terminal.session.create')).toHaveLength(
    0,
  );
});

test('a new local path uses defaults in one terminal creation and keyboard selects projects', async ({
  page,
}) => {
  await page.goto(fixture);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    f.setDefaults({ model: 'default-model', effort: 'high' });
    f.setLocalProjects(['D:\\fresh']);
  });
  const opener = page.getByRole('button', { name: '选择设备或项目新建终端', exact: true });
  await opener.click();
  const input = page.getByRole('textbox', { name: '搜索设备或项目', exact: true });
  await input.fill('fresh');
  await input.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'fresh · 本机', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('本机项目目录', { exact: true })).toHaveValue('D:\\fresh');
  await page.getByRole('button', { name: '打开项目', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await api(page)).filter((r: any) => r.type === 'terminal.session.create')).toHaveLength(
    1,
  );
  expect((await api(page)).find((r: any) => r.type === 'terminal.session.create')).toMatchObject({
    projectPath: 'D:\\fresh',
    model: 'default-model',
    effort: 'high',
    permissionMode: 'default',
  });
});

test('project picker stays within light and dark desktop and narrow viewports', async ({
  page,
}) => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir('.local/screenshots/multi-device-terminal', { recursive: true });
  for (const theme of ['light', 'dark'])
    for (const width of [1280, 1000, 800, 480]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(fixture + '?remoteProjects=1');
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '新建终端', exact: true });
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({
        path: `.local/screenshots/multi-device-terminal/picker-${theme}-${width}.png`,
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }),
      ).toBeFocused();
    }
});

test('offline existing project preserves its chosen source configuration after reconnect', async ({
  page,
}) => {
  await page.goto(fixture + '?offlineRemote=1');
  await page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }).click();
  await page.getByRole('button', { name: 'first · 02', exact: true }).click();
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByLabel('项目绝对路径', { exact: true })).toHaveValue('/work/first');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(
    (await api(page)).find((request: any) => request.type === 'session.configure'),
  ).toMatchObject({
    sessionId: 'first-remote',
    permissionMode: 'acceptEdits',
    model: 'preserved-model',
    effort: 'high',
  });
  expect(
    (await api(page)).filter((request: any) => request.type === 'terminal.session.create'),
  ).toHaveLength(0);
});

test('the legacy entry uses the same picker and composition keys do not execute or dismiss it', async ({
  page,
}) => {
  await page.goto(fixture);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  await page.getByRole('button', { name: '选项目新建', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建终端', exact: true });
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox', { name: '搜索设备或项目', exact: true });
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.press('Escape');
  await expect(dialog).toBeVisible();
  expect((await api(page)).filter((r: any) => r.type === 'terminal.session.create')).toHaveLength(
    0,
  );
  await input.dispatchEvent('compositionend');
  await input.press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(2);
});

test('same-project plus reconnects an offline SSH source before creating any tab', async ({
  page,
}) => {
  await page.goto(fixture + '?offlineRemote=1');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.evaluate(() => (window as any).terminalTest.showSession('offline-source'));
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '打开项目', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect((await api(page)).filter((r: any) => r.type === 'terminal.session.create')).toHaveLength(
    0,
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
});

test('changing away from an offline source project uses the new target defaults', async ({
  page,
}) => {
  await page.goto(fixture + '?offlineRemote=1');
  await page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }).click();
  await page.getByRole('button', { name: 'first · 02', exact: true }).click();
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByLabel('项目绝对路径', { exact: true }).fill('/work/different');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(
    (await api(page)).filter((request: any) => request.type === 'session.configure'),
  ).toHaveLength(0);
});

test('long device and project names stay readable within the narrow picker', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto(fixture);
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    const base = f.snapshot().sessions[0];
    f.update({
      sessions: [
        {
          ...base,
          projectPath: '/work/' + 'long-project-name-'.repeat(8),
          device: { ...base.device, name: '实验室远程开发服务器'.repeat(8) },
        },
      ],
    });
  });
  await page.getByRole('button', { name: '选择设备或项目新建终端', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建终端', exact: true });
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(dialog.locator('.terminal-project-choice')).toHaveCount(1);
});
