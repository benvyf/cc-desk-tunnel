import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/test/terminal-window.fixture.html');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
});

test('official history is negotiated, explicitly confirmed and continued in a new tab with stable retry identity', async ({ page }) => {
  await page.getByRole('button', { name: '全部终端', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续官方历史', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).terminalTest.update({ terminalHistory: { version: 1 }, historyItems: [
      { sessionId: 'history-cc', nativeId: '54c6cbb2-4ea7-4c98-9a57-1df184c459f1', title: '历史中文任务', updatedAt: '2026-10-29', available: true },
      { sessionId: 'empty', nativeId: '71ece7b5-b52d-43b2-9cbf-3f574a4f1767', title: '空会话', updatedAt: '2026-10-29', available: false, reason: '尚无有效历史' },
    ] });
    (window as any).terminalTest.setCreateMode('lostResponse');
    (window as any).terminalTest.emit({ type: 'terminal.closed', exitCode: 0 });
  });
  await page.getByRole('button', { name: '继续官方历史', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('历史中文任务')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '新开终端继续' }).first()).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(dialog.getByRole('button', { name: '新开终端继续' }).nth(1)).toBeDisabled();
  await dialog.getByRole('button', { name: '新开终端继续' }).first().click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByText('创建结果尚未确认', { exact: true }).last()).toBeVisible();
  await page.evaluate(() => (window as any).terminalTest.setCreateMode('normal'));
  await page.getByRole('button', { name: '确认创建结果', exact: true }).click();
  await expect(page.getByRole('tab').nth(1)).toContainText('Linux · Claude Code');
  expect(await page.evaluate(() => (window as any).terminalTest.createdCount())).toBe(1);
  const requests = await page.evaluate(() => (window as any).terminalTest.requests.filter((r: any) => r.type === 'terminal.history.continue'));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0].historySessionId).toBe('history-cc');
  expect(requests[0].confirmed).toBe(true);
  await page.getByRole('tab').first().click();
  await expect(page.getByRole('button', { name: '新开同项目终端' })).toBeVisible();
});

test('attachment preparation stays with its original tab and errors block paste', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).desktop = {
      terminalWindow: { focus() {}, setActive() {} },
      chooseFiles: () => new Promise((resolve) => { (window as any).finishFiles = resolve; }),
      attachmentPreview: async () => null,
      pathForFile: () => '',
      saveImage: async () => { throw new Error('模拟图片保存失败'); },
    };
    (window as any).terminalTest.update({ device: { id: 'device' } });
  });
  await page.getByRole('button', { name: '编辑输入', exact: true }).click();
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await page.getByRole('button', { name: '编辑输入', exact: true }).click();
  await page.evaluate(() => (window as any).finishFiles(['D:\\fixture\\first.png', 'D:\\fixture\\first.png']));
  await expect(page.locator('.terminal-panel:visible .attachment-tile')).toHaveCount(0);
  await page.getByRole('tab').first().click();
  await expect(page.locator('.terminal-panel:visible .attachment-tile')).toHaveCount(1);
  const draft = page.getByRole('textbox', { name: '多行终端草稿' });
  await draft.evaluate((input) => {
    const data = new DataTransfer(); data.items.add(new File(['broken'], 'bad.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
  });
  await expect(page.getByText('添加失败，请重新添加')).toBeVisible();
  await expect(page.getByRole('button', { name: '粘贴到终端', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '移除 bad.png', exact: true }).click();
  await expect(page.getByRole('button', { name: '粘贴到终端', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).terminalTest.emit({ type: 'terminal.data', data: '\x1b[?2004h', bytes: 8 }));
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.controls.some((c: any) => c.type === 'terminal.ack'))).toBe(true);
  await page.getByRole('button', { name: '粘贴到终端', exact: true }).click();
  const frames = await page.evaluate(() => (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'));
  expect(frames.every((c: any) => c.sessionId === 'fixture')).toBe(true);
  expect(frames.map((c: any) => c.data).join('')).toContain('Read 后删除临时副本');
  expect(frames.map((c: any) => c.data).join('').endsWith('\x1b[201~')).toBe(true);
  await expect(page.locator('.terminal-panel:visible .attachment-tile')).toHaveCount(1);
});

test('per-tab drafts keep Chinese input, refuse unsafe multiline and paste bracketed chunks without Enter', async ({ page }) => {
  await page.getByRole('button', { name: '编辑输入', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '多行终端草稿' });
  await draft.fill('第一份草稿');
  await draft.dispatchEvent('compositionstart');
  await draft.press('Enter');
  await draft.dispatchEvent('compositionend');
  await draft.fill('第一份草稿\n第二行');
  await page.getByRole('button', { name: '粘贴到终端', exact: true }).click();
  await expect(page.getByText('终端未启用多行粘贴模式，请复制后手动粘贴并检查。')).toBeVisible();
  expect(await page.evaluate(() => (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input').length)).toBe(0);
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await page.getByRole('button', { name: '编辑输入', exact: true }).click();
  await expect(draft).toHaveValue('');
  await draft.fill('另一个中文草稿');
  await page.getByRole('tab').first().click();
  await expect(draft).toHaveValue('第一份草稿\n第二行');
  await page.evaluate(() => (window as any).terminalTest.emit({ type: 'terminal.data', data: '\x1b[?2004h', bytes: 8 }));
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.controls.some((c: any) => c.type === 'terminal.ack' && c.sessionId === 'fixture'))).toBe(true);
  const text = '中🙂文'.repeat(2500) + '\n最后一行';
  await draft.fill(text);
  await page.getByRole('button', { name: '粘贴到终端', exact: true }).click();
  await expect(page.locator('.terminal-panel:visible .xterm-helper-textarea')).toBeFocused();
  await expect(draft).toHaveValue(text);
  const frames = await page.evaluate(() => (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'));
  expect(frames.every((c: any) => c.sessionId === 'fixture' && c.terminalId === 'pty' && c.data.length <= 4096)).toBe(true);
  expect(frames.map((c: any) => c.data).join('')).toBe('\x1b[200~' + text.replaceAll('\n', '\r') + '\x1b[201~');
  await page.getByRole('button', { name: '收起编辑', exact: true }).click();
  await page.getByRole('button', { name: '编辑输入', exact: true }).click();
  await expect(draft).toHaveValue(text);
  await page.evaluate(() => (window as any).terminalTest.update({ status: 'disconnected' }));
  await expect(page.getByRole('button', { name: '粘贴到终端', exact: true })).toBeDisabled();
  await expect(draft).toHaveValue(text);
});

test('OSC file links read only on click and preview markup as text', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).terminalTest.update({ terminalFiles: { version: 1 } });
    const data = '\x1b]8;;file:///tmp/preview.html\x07查看文件\x1b]8;;\x07\r\n';
    (window as any).terminalTest.emit({ type: 'terminal.data', data, bytes: new TextEncoder().encode(data).length });
  });
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).terminalTest.controls.some((c: any) => c.type === 'terminal.ack'))).toBe(true);
  expect(await page.evaluate(() => (window as any).terminalTest.requests.filter((r: any) => r.type === 'terminal.file.read').length)).toBe(0);
  const screen = await page.locator('.xterm-screen').boundingBox();
  await page.mouse.move(screen!.x + 7, screen!.y + 7);
  await page.mouse.click(screen!.x + 7, screen!.y + 7);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.terminal-file-text')).toHaveText('<script>unsafe()</script>预览内容');
  expect(await page.locator('.terminal-file-text script').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).terminalTest.requests.filter((r: any) => r.type === 'terminal.file.read').length)).toBe(1);
  await page.getByRole('dialog').locator('.dialog-actions').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.terminal-panel:visible textarea')).toBeFocused();
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
