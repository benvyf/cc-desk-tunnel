import { test, expect } from '@playwright/test';
const fixture = '/test/terminal-window.fixture.html';
const api = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).terminalTest.requests);

test('unified terminal menu opens both groups and creates with keyboard', async ({ page }) => {
  await page.goto(fixture);
  const opener = page.getByRole('button', { name: '切换或新建终端', exact: true });
  await opener.click();
  const menu = page.locator('.terminal-list');
  await expect(menu.getByRole('group', { name: '已打开', exact: true })).toBeVisible();
  await expect(menu.getByRole('group', { name: '新建终端', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-tabs-header > button[aria-expanded]')).toHaveCount(1);
  await expect(page.locator('.terminal-new-actions')).toHaveCount(0);
  const arrow = await opener.boundingBox();
  const bounds = await menu.boundingBox();
  expect(Math.abs(arrow!.x - bounds!.x)).toBeLessThanOrEqual(8);
  await expect(menu.getByText('↵ 切换', { exact: true })).toBeVisible();
  await menu.getByRole('textbox').press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await opener.click();
  await menu.getByRole('textbox').press('ArrowDown');
  await menu.getByRole('textbox').press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await opener.click();
  await menu.getByRole('textbox').press('Escape');
  await expect(opener).toBeFocused();
});

test('Enter on the other directory action opens its dialog without executing the selected row', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const menu = page.locator('.terminal-list');
  await menu.getByRole('textbox').press('ArrowDown');
  const action = menu.getByRole('button', { name: '打开其他目录…', exact: true });
  await action.focus();
  await action.press('Enter');
  await expect(page.getByRole('dialog', { name: '打开项目', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(
    (await api(page)).filter((request: any) => request.type === 'terminal.session.create'),
  ).toHaveLength(0);
});
test('terminal menu deduplicates projects and routes the chosen device source', async ({
  page,
}) => {
  await page.goto(fixture + '?remoteProjects=1');
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
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const picker = page.locator('.terminal-list');
  await picker
    .getByRole('textbox', { name: '搜索项目、设备或已打开的终端', exact: true })
    .fill('02');
  await expect(picker.getByRole('option', { name: 'app · 02', exact: true })).toHaveCount(1);
  await picker.getByRole('option', { name: 'app · 02', exact: true }).click();
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
    '新建终端 · fixture',
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
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.getByRole('option', { name: 'first · 02', exact: true }).click();
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
  const opener = page.getByRole('button', { name: '切换或新建终端', exact: true });
  await opener.click();
  const input = page.getByRole('textbox', { name: '搜索项目、设备或已打开的终端', exact: true });
  await input.fill('fresh');
  await expect(page.getByRole('option', { name: 'fresh', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
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

test('terminal menu stays within light and dark desktop and narrow viewports', async ({ page }) => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir('.local/screenshots/multi-device-terminal', { recursive: true });
  for (const theme of ['light', 'dark'])
    for (const width of [1280, 1000, 800, 480]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(fixture + '?remoteProjects=1');
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        (window as any).terminalTest.update({ terminalHistory: { version: 1 } });
      }, theme);
      await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
      const dialog = page.locator('.terminal-list');
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({
        path: `.local/screenshots/multi-device-terminal/picker-${theme}-${width}.png`,
        animations: 'disabled',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: '切换或新建终端', exact: true })).toBeFocused();
    }
});

test('offline existing project preserves its chosen source configuration after reconnect', async ({
  page,
}) => {
  await page.goto(fixture + '?offlineRemote=1');
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.getByRole('option', { name: 'first · 02', exact: true }).click();
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

test('menu composition keys do not execute or dismiss it', async ({ page }) => {
  await page.goto(fixture);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const dialog = page.locator('.terminal-list');
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox', { name: '搜索项目、设备或已打开的终端', exact: true });
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.press('Escape');
  await expect(dialog).toBeVisible();
  expect((await api(page)).filter((r: any) => r.type === 'terminal.session.create')).toHaveLength(
    0,
  );
  await input.dispatchEvent('compositionend');
  await input.press('ArrowDown');
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
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.getByRole('option', { name: 'first · 02', exact: true }).click();
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByLabel('项目绝对路径', { exact: true }).fill('/work/different');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(
    (await api(page)).filter((request: any) => request.type === 'session.configure'),
  ).toHaveLength(1);
});

test('long device and project names stay readable within the narrow menu', async ({ page }) => {
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
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const dialog = page.locator('.terminal-list');
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(dialog.locator('.terminal-project-choice')).toHaveCount(1);
});

for (const focus of ['tab', 'xterm']) {
  test(`workspace shortcuts from ${focus} preserve Claude keys and composing input`, async ({
    page,
  }) => {
    await page.goto(fixture);
    await expect(page.getByRole('tab')).toHaveCount(1);
    const target =
      focus === 'tab'
        ? page.getByRole('tab').first()
        : page.locator('.xterm-helper-textarea').first();
    await target.focus();
    await target.dispatchEvent('keydown', {
      key: 'T',
      ctrlKey: true,
      shiftKey: true,
      isComposing: true,
      bubbles: true,
    });
    await target.press('Control+t');
    await expect(page.getByRole('tab')).toHaveCount(1);
    await target.press('Control+Shift+T');
    await expect(page.getByRole('tab')).toHaveCount(2);
    const nextTarget =
      focus === 'tab'
        ? page.getByRole('tab').last()
        : page.locator('.terminal-panel:not([hidden]) .xterm-helper-textarea');
    await nextTarget.focus();
    await nextTarget.press('Control+Tab');
    await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+Tab');
    await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+Space');
    await expect(page.locator('.terminal-list input')).toBeFocused();
    await page.locator('.terminal-list input').dispatchEvent('compositionstart');
    await page.keyboard.press('Control+Shift+T');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.locator('.terminal-list input').dispatchEvent('compositionend');
    await page.keyboard.press('Control+Shift+Space');
    await expect(page.locator('.terminal-list')).toHaveCount(0);
  });
}

test('double-click and context-click rename tabs without maximizing the window', async ({
  page,
}) => {
  await page.goto(fixture);
  for (const action of ['double', 'context']) {
    if (action === 'double') await page.getByRole('tab').first().dblclick();
    else await page.getByRole('tab').first().click({ button: 'right' });
    const dialog = page.getByRole('dialog', { name: '标签别名', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill(`${action}-alias`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('tab')).toContainText(`${action}-alias`);
  }
});

test('remote creation configures default permission before opening and retries failures in place', async ({
  page,
}) => {
  await page.goto(fixture + '?remoteProjects=1');
  await page.evaluate(() =>
    (window as any).terminalTest.update({ configureError: '配置失败测试' }),
  );
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.getByRole('option', { name: 'first · 02', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '打开项目', exact: true });
  await dialog.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('配置失败测试');
  await expect(page.getByRole('tab')).toHaveCount(1);
  const failed = await api(page);
  expect(failed.find((request: any) => request.type === 'session.configure')).toMatchObject({
    permissionMode: 'default',
  });
  expect(failed.filter((request: any) => request.type === 'terminal.open')).toHaveLength(1);
  await page.evaluate(() => (window as any).terminalTest.update({ configureError: null }));
  await dialog.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  const requests = await api(page);
  expect(requests.filter((request: any) => request.type === 'ssh.openProject')).toHaveLength(1);
  expect(
    requests.findLastIndex((request: any) => request.type === 'session.configure'),
  ).toBeLessThan(
    requests.findIndex(
      (request: any) => request.type === 'terminal.open' && request.sessionId === 'first-remote',
    ),
  );
});

test('opened terminal search uses project display names and shows waiting activity', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    f.setProjectName('搜索别名');
    f.update({
      sessions: f.snapshot().sessions.map((session: any) => ({
        ...session,
        activeRun: { id: 'run', surface: 'terminal', activity: 'waiting' },
      })),
    });
  });
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toHaveAttribute(
    'title',
    '新建终端 · 搜索别名',
  );
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.locator('.terminal-list input').fill('搜索别名');
  await expect(
    page.getByRole('group', { name: '已打开', exact: true }).getByRole('option'),
  ).toHaveCount(1);
  await expect(page.getByRole('group', { name: '已打开', exact: true })).toContainText(
    '终端等你确认',
  );
});

for (const unavailable of ['capability', 'connection']) {
  test(`keyboard cannot create saved projects without ${unavailable}`, async ({ page }) => {
    await page.goto(fixture + '?remoteProjects=1');
    await page.evaluate((reason) => {
      (window as any).terminalTest.update(
        reason === 'capability' ? { terminalWorkspace: undefined } : { status: 'disconnected' },
      );
    }, unavailable);
    await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
    const input = page.locator('.terminal-list input');
    await input.fill('first');
    await input.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(1);
    expect(
      (await api(page)).filter((request: any) =>
        ['ssh.openProject', 'terminal.session.create'].includes(request.type),
      ),
    ).toHaveLength(0);
  });
}

test('Tab focus selects the intended new-project menu row before Enter', async ({ page }) => {
  await page.goto('/test/terminal-window.fixture.html');
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const search = page.locator('.terminal-list input');
  await expect(search).toBeFocused();
  await search.press('Tab');
  await page.keyboard.press('Tab');
  const project = page
    .getByRole('group', { name: '新建终端', exact: true })
    .getByRole('option')
    .first();
  await expect(project).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(2);
});
test('narrow local terminal footer preserves its path without a device label', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/test/terminal-window.fixture.html');
  const footer = page.locator('.terminal-workspace-footer');
  await expect(footer.locator('span')).toHaveCount(1);
  await expect(footer.locator('span').first()).toBeVisible();
  await expect(footer).toContainText('D:\\fixture');
});
test('narrow remote terminal footer keeps the device short name visible', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/test/terminal-window.fixture.html?remoteProjects=1');
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.getByRole('option', { name: 'first · 02', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  const footer = page.locator('.terminal-workspace-footer');
  await expect(footer.locator('span').last()).toHaveText('02');
  await expect(footer.locator('span').last()).toBeVisible();
});
test('project search matches the local device name while its label stays hidden', async ({
  page,
}) => {
  await page.goto('/test/terminal-window.fixture.html');
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.locator('.terminal-list input').fill('fixture-node');
  const rows = page.getByRole('group', { name: '新建终端', exact: true }).getByRole('option');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).not.toContainText('fixture-node');
});

test('project menu active descendant uses a valid ID for directories with spaces', async ({
  page,
}) => {
  await page.goto('/test/terminal-window.fixture.html');
  await page.evaluate(() => {
    const f = (window as any).terminalTest;
    f.update({
      sessions: f
        .snapshot()
        .sessions.map((session: any) => ({ ...session, projectPath: 'D:\\work\\with spaces' })),
    });
  });
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  const search = page.locator('.terminal-list input');
  await search.fill('with spaces');
  await search.press('ArrowDown');
  const active = await search.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  expect(active).not.toMatch(/\s/);
  expect(
    await search.evaluate((input) =>
      input.ownerDocument
        .getElementById(input.getAttribute('aria-activedescendant')!)
        ?.getAttribute('role'),
    ),
  ).toBe('option');
  await search.press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(2);
});
test('an open terminal menu stays anchored and within a resized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/test/terminal-window.fixture.html');
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: '切换或新建终端', exact: true }).click();
  await page.setViewportSize({ width: 480, height: 800 });
  const menu = page.locator('.terminal-list');
  await expect
    .poll(async () => {
      const r = await menu.boundingBox();
      return r!.x + r!.width;
    })
    .toBeLessThanOrEqual(480);
  await expect(menu).toBeVisible();
  await expect(page.locator('.terminal-list input')).toBeFocused();
});
