import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/terminal-window.fixture.html');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
});

test('terminal filter searches device and aliases without restarting sessions and restores focus', async ({ page }) => {
  for (let i = 0; i < 11; i++) {
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(i + 2);
  }
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  const filter = page.getByRole('textbox', { name: '筛选终端' });
  await expect(filter).toBeFocused();
  await filter.fill('FIXTURE-NODE');
  await expect(page.getByRole('option')).toHaveCount(12);
  await filter.press('ArrowDown');
  await filter.press('Enter');
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.terminal-panel:visible textarea')).toBeFocused();
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  await page.getByRole('button', { name: '标签别名', exact: true }).click();
  await page.getByRole('dialog').locator('input').fill('中文调查任务长标题');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  await filter.fill('调查');
  await expect(page.getByRole('option')).toHaveCount(1);
  await filter.fill('nothing-matches');
  await expect(page.getByText('没有匹配的终端')).toBeVisible();
  await filter.press('Escape');
  await expect(page.locator('.terminal-panel:visible textarea')).toBeFocused();
  expect(await page.evaluate(() => (window as any).terminalTest.requests.filter((r: any) => r.type === 'terminal.open').length)).toBe(12);
});

test('tabs keep stable processes, route input and acknowledge hidden output', async ({ page }) => {
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab').nth(1)).toContainText('Linux · Claude Code');
  await page.locator('.terminal-panel:visible textarea').press('Enter');
  await page.getByRole('tab').nth(0).click();
  await page.locator('.terminal-panel:visible textarea').press('Control+c');
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  await page.getByRole('button', { name: '标签别名', exact: true }).click();
  await page.getByRole('dialog').locator('input').fill('调查问题');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('tab').nth(0)).toContainText('调查问题');
  await page.evaluate(() => {
    const data = 'background 中文🙂'.repeat(16000);
    (window as any).terminalTest.emit({
      type: 'terminal.data',
      sessionId: 'fixture-1',
      terminalId: 'pty-fixture-1',
      data,
      bytes: new TextEncoder().encode(data).length,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).terminalTest.controls
          .filter((c: any) => c.type === 'terminal.ack' && c.sessionId === 'fixture-1')
          .reduce((sum: number, c: any) => sum + c.bytes, 0),
      ),
    )
    .toBeGreaterThan(128 * 1024);
  const controls = await page.evaluate(() =>
    (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
  );
  expect(controls.map((c: any) => [c.sessionId, c.data])).toEqual([
    ['fixture-1', '\r'],
    ['fixture', '\x03'],
  ]);
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(2);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.requests.some((c: any) => c.type === 'terminal.close'),
    ),
  ).toBe(false);
  await page.setViewportSize({ width: 480, height: 300 });
  await expect(page.getByRole('button', { name: '新建终端', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/terminal-workspace-small.png' });
});

test('closing a tab confirms once and leaves the other process running', async ({ page }) => {
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page
    .locator('.terminal-tab')
    .nth(1)
    .getByRole('button', { name: '关闭fixture', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page
    .locator('.terminal-tab')
    .nth(1)
    .getByRole('button', { name: '关闭fixture', exact: true })
    .click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.requests
        .filter((c: any) => c.type === 'terminal.close')
        .map((c: any) => c.sessionId),
    ),
  ).toEqual(['fixture-1']);
});

test('batch close retains only failed tabs and reports the failure', async ({ page }) => {
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.evaluate(() => (window as any).terminalTest.failCloseSession('fixture-1'));
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  // Inline fallback has no native close button; close both tabs through their shared controller.
  await page.evaluate(() => (window as any).terminalTest.closeAll());
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.terminal-workspace > [role=alert]')).toContainText('未关闭');
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
});

test('missing opened frame or response recovers identity without starting a second process', async ({
  page,
}) => {
  for (const mode of ['lostOpened', 'lostResponse']) {
    await page.evaluate((mode) => (window as any).terminalTest.setOpenMode(mode), mode);
    await page.getByRole('button', { name: '新建终端', exact: true }).click();
    await expect(page.getByRole('tab').last()).toContainText('Linux · Claude Code');
  }
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(3);
});

test('disconnect retains output and old services offer only one terminal', async ({ page }) => {
  await page.evaluate(() => (window as any).terminalTest.update({ terminalWorkspace: undefined }));
  await expect(page.getByRole('button', { name: '服务端升级后可使用多终端' })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).terminalTest.emit({
      type: 'terminal.data',
      data: 'retained output',
      bytes: 15,
    });
    (window as any).terminalTest.update({ status: 'reconnecting' });
  });
  await expect(page.getByRole('tab')).toContainText('连接中断');
  await expect(page.locator('.native-terminal')).toHaveCount(1);
  await page.evaluate(() =>
    (window as any).terminalTest.update({ status: 'connected', connectionId: 'new-owner' }),
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('lost creation response reuses the durable request and closing during creation cleans only its tab', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).terminalTest.setCreateMode('lostResponse'));
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认创建结果', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).terminalTest.setCreateMode('normal'));
  await page.getByRole('button', { name: '确认创建结果', exact: true }).click();
  await expect(page.getByRole('tab').nth(1)).toContainText('Linux · Claude Code');
  expect(await page.evaluate(() => (window as any).terminalTest.createdCount())).toBe(1);
  await page.evaluate(() => (window as any).terminalTest.setCreateMode('pending'));
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page
    .locator('.terminal-tab')
    .nth(2)
    .getByRole('button', { name: '关闭fixture', exact: true })
    .click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await page.evaluate(() => (window as any).terminalTest.finishCreate());
  await expect(page.getByRole('tab')).toHaveCount(2);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.requests
        .filter((c: any) => c.type === 'terminal.close')
        .every((c: any) => c.sessionId === 'fixture-2'),
    ),
  ).toBe(true);
});

test('a selected local project and subsequent plus use the returned project identity', async ({
  page,
}) => {
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  await page.getByRole('button', { name: '选项目新建', exact: true }).click();
  await page.getByLabel('或使用本机项目目录', { exact: true }).fill('D:\\different-project');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await expect(page.getByRole('tab').nth(1)).toContainText('Linux · Claude Code');
  await expect(page.locator('.terminal-workspace-footer')).toContainText('D:\\different-project');
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests
          .filter((c: any) => c.type === 'terminal.session.create')
          .at(-1).sourceSessionId,
    ),
  ).toBe('fixture-1');
});
