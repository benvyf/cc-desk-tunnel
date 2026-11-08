import { expect, test, type Page } from '@playwright/test';

const button = (page: Page) => page.getByRole('button', { name: '按新宽度重排', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: '按当前宽度重新载入' });
const requests = (page: Page) => page.evaluate(() => (window as any).terminalTest.requests);
const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `旧内容标记-${i}\r\n`).join('');

async function mount(page: Page, query = '') {
  await page.goto(`/test/terminal-window.fixture.html${query}`);
  await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'running');
  await activity(page, 'idle');
}

async function activity(page: Page, value: string | null) {
  await page.evaluate((activity) => {
    const api = (window as any).terminalTest;
    api.update({
      sessions: api.snapshot().sessions.map((session: any) => ({
        ...session,
        activeRun:
          activity === null
            ? null
            : {
                id: 'pty',
                status: 'running',
                surface: 'terminal',
                activity,
              },
      })),
    });
  }, value);
}

async function output(page: Page, data: string) {
  await page.evaluate(
    (data) =>
      new Promise<void>((resolve) => {
        const api = (window as any).terminalTest;
        const terminal = api.terminalInstances.findLast((t: any) => t.element?.isConnected);
        const listener = terminal.onWriteParsed(() => {
          listener.dispose();
          resolve();
        });
        api.emit({ type: 'terminal.data', data, bytes: new TextEncoder().encode(data).length });
      }),
    data,
  );
}

async function resize(page: Page, width: number, height = 900) {
  const before = await page.evaluate(() => (window as any).terminalTest.controls.length);
  await page.setViewportSize({ width, height });
  await expect
    .poll(() =>
      page.evaluate(
        (before) =>
          (window as any).terminalTest.controls
            .slice(before)
            .filter((c: any) => c.type === 'terminal.resize').length,
        before,
      ),
    )
    .toBeGreaterThan(0);
}

async function stale(page: Page, query = '') {
  await mount(page, query);
  await output(page, lines(200));
  await resize(page, 1500);
  await expect(button(page)).toBeVisible();
}

async function confirm(page: Page) {
  await button(page).click();
  await dialog(page).getByRole('button', { name: '重新载入', exact: true }).click();
}

test('6.1.1 history and a transmitted width change offer manual reload', async ({ page }) => {
  await stale(page);
  expect((await requests(page)).map((r: any) => r.type)).toEqual(['terminal.open']);
});

test('6.1.2 no history updates the baseline without offering reload', async ({ page }) => {
  await mount(page);
  await output(page, lines(3));
  await resize(page, 1500);
  await expect(button(page)).toHaveCount(0);
  await output(page, lines(200));
  await resize(page, 1280);
  await expect(button(page)).toBeVisible();
});

test('6.1.3 returning to the printed width hides reload', async ({ page }) => {
  await stale(page);
  await resize(page, 1280);
  await expect(button(page)).toHaveCount(0);
});

test('6.1.4 height changes alone never offer reload', async ({ page }) => {
  await mount(page);
  await output(page, lines(200));
  await resize(page, 1280, 700);
  await expect(button(page)).toHaveCount(0);
});

test('6.1.5 activity and connection gate both buttons with exact reasons', async ({ page }) => {
  await stale(page);
  for (const [value, reason] of [
    ['working', 'Claude 正在运行，结束后才能重新载入'],
    ['waiting', 'Claude 正在等待确认或回答，处理后才能重新载入'],
    [null, '正在同步 Claude 状态，稍后再试'],
  ] as const) {
    await activity(page, value);
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page)).toHaveAttribute('title', reason);
    await button(page).dispatchEvent('click');
    await expect(dialog(page)).toHaveCount(0);
  }
  await activity(page, 'idle');
  await button(page).click();
  const reload = dialog(page).getByRole('button', { name: '重新载入', exact: true });
  await activity(page, 'working');
  await expect(reload).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog(page).getByRole('status')).toHaveText('Claude 正在运行，结束后才能重新载入');
  await reload.dispatchEvent('click');
  expect(await requests(page)).toHaveLength(1);
  await activity(page, 'idle');
  await page.evaluate(() =>
    (window as any).terminalTest.update({ devices: [{ id: 'device', ready: false }] }),
  );
  await expect(reload).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog(page).getByRole('status')).toHaveText('连接恢复后才能重新载入');
  await page.evaluate(() =>
    (window as any).terminalTest.update({ devices: [{ id: 'device', ready: true }] }),
  );
  await expect(reload).not.toHaveAttribute('aria-disabled', 'true');
  await dialog(page).getByRole('button', { name: '取消', exact: true }).click();
  await button(page).click();
  await resize(page, 1280);
  await expect(dialog(page)).toHaveCount(0);
});

test('6.1.6 cancel Escape and close leave the CLI untouched', async ({ page }) => {
  await stale(page);
  const before = await requests(page);
  for (const action of ['取消', 'Escape', '关闭']) {
    await button(page).click();
    await expect(dialog(page).getByRole('button', { name: '取消', exact: true })).toBeFocused();
    if (action === 'Escape') await page.keyboard.press('Escape');
    else await dialog(page).getByRole('button', { name: action, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await requests(page)).toEqual(before);
  }
});

for (const query of [
  '?display=1',
  '?display=1&reattach=1',
  '?display=1&waitReloadReady=1',
  '?waitReloadReady=1',
  '',
]) {
  test(`6.1.7 reload requests preserve sent display and current cols ${query || 'without display'}`, async ({
    page,
  }) => {
    await stale(page, query);
    const first = (await requests(page))[0];
    if (query.includes('reattach')) {
      await page.evaluate(() => {
        const api = (window as any).terminalTest;
        api.update({ status: 'reconnecting' });
        api.update({ status: 'connected', connectionId: 'reattached' });
      });
      await expect(page.locator('.terminal-recovery-note')).toHaveText(
        '已接回原终端，未重发输入。',
      );
      expect((await requests(page)).at(-1)).not.toHaveProperty('display');
      await output(page, lines(200));
      await resize(page, 1600);
      await expect(button(page)).toBeVisible();
    }
    const before = (await requests(page)).length;
    await page.evaluate(
      (display) => (window as any).terminalTest.setDisplay(display),
      first.display === 'scroll' ? 'screen' : 'scroll',
    );
    const cols = await page.evaluate(
      () => (window as any).terminalTest.terminalInstances.at(-1).cols,
    );
    if (query.includes('waitReloadReady'))
      await page.evaluate(() => (window as any).terminalTest.setCloseMode('pending'));
    await confirm(page);
    if (query.includes('waitReloadReady')) {
      await page.evaluate(() => {
        const api = (window as any).terminalTest;
        api.update({ devices: [{ id: 'device', ready: false }] });
        api.finishClose(true);
      });
      await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'opening');
      expect((await requests(page)).slice(before).map((r: any) => r.type)).toEqual([
        'terminal.close',
      ]);
      await page.evaluate(() =>
        (window as any).terminalTest.update({ devices: [{ id: 'device', ready: true }] }),
      );
    }
    await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'running');
    const sent = (await requests(page)).slice(before);
    expect(sent.map((r: any) => r.type)).toEqual(['terminal.close', 'terminal.open']);
    expect(sent[0]).toMatchObject({ sessionId: 'fixture', terminalId: 'pty' });
    expect(sent[1]).toMatchObject({ sessionId: 'fixture', cols });
    expect(sent[1]).not.toHaveProperty('terminalId');
    if (first.display !== undefined) expect(sent[1].display).toBe(first.display);
    else {
      expect(first).not.toHaveProperty('display');
      expect(sent[1]).not.toHaveProperty('display');
    }
    expect(
      await page.evaluate(() =>
        (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
      ),
    ).toEqual([]);
  });
}

async function watchReload(page: Page) {
  await page.evaluate(() => {
    const phases: string[] = [];
    const seen = { phases, newTerminal: false, released: false };
    (window as any).reloadSeen = seen;
    const tab = document.querySelector('.terminal-tab')!;
    const observer = new MutationObserver((records) => {
      for (const record of records)
        if (record.attributeName === 'data-phase' && record.oldValue) phases.push(record.oldValue);
      phases.push(tab.getAttribute('data-phase')!);
      seen.newTerminal ||= document.body.textContent!.includes('新开同项目终端');
      seen.released ||= !(window as any).terminalTest.occupied.includes('fixture');
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
    });
  });
}

test('6.1.8 reload phases never release the occupied session', async ({ page }) => {
  await stale(page);
  await watchReload(page);
  await confirm(page);
  await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'running');
  const seen = await page.evaluate(() => (window as any).reloadSeen);
  expect(seen.phases).toContain('closing');
  expect(seen.phases).not.toContain('ended');
  expect(seen.phases).not.toContain('failed');
  expect(seen.newTerminal).toBe(false);
  expect(seen.released).toBe(false);
});

test('6.1.9 reload clears old buffer while keeping the search query', async ({ page }) => {
  await stale(page);
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await page.getByRole('textbox', { name: '终端查找文字' }).fill('旧内容标记');
  await confirm(page);
  await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'running');
  expect(
    await page.evaluate(() => {
      const buffer = (window as any).terminalTest.terminalInstances.at(-1).buffer.normal;
      return Array.from({ length: buffer.length }, (_, i) =>
        buffer.getLine(i).translateToString(),
      ).join('\n');
    }),
  ).not.toContain('旧内容标记');
  await expect(page.getByRole('textbox', { name: '终端查找文字' })).toHaveValue('旧内容标记');
});

for (const query of ['', '?failState=1']) {
  test(`6.1.10 / 16 connected close failure stays running or unknown ${query}`, async ({
    page,
  }) => {
    await stale(page, query);
    await watchReload(page);
    await page.evaluate(() => (window as any).terminalTest.setCloseMode('fail'));
    await confirm(page);
    await expect(page.locator('.terminal-tab')).toHaveAttribute(
      'data-phase',
      query ? 'unknown' : 'running',
    );
    if (!query) await expect(page.getByRole('alert')).toHaveText('未能重新载入，原终端仍在运行。');
    expect(await page.evaluate(() => (window as any).reloadSeen.phases)).not.toContain(
      'disconnected',
    );
    expect((await requests(page)).map((r: any) => r.type)).toEqual([
      'terminal.open',
      'terminal.close',
    ]);
  });
}

test('6.1.11 reopen failure offers the existing retry action', async ({ page }) => {
  await stale(page, '?failSecondOpen=1');
  await confirm(page);
  await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'failed');
  await page.getByRole('button', { name: '重试启动', exact: true }).click();
  await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'running');
});

test('6.1.12 alternate screen hides reload until normal buffer returns', async ({ page }) => {
  await stale(page);
  await output(page, '\x1b[?1049h');
  await expect(button(page)).toHaveCount(0);
  await output(page, '\x1b[?1049l');
  await expect(button(page)).toBeVisible();
});

test('6.1.13 closing a tab during reload also closes the new process', async ({ page }) => {
  await stale(page);
  await page.evaluate(() => (window as any).terminalTest.setCloseMode('pending'));
  await confirm(page);
  await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'closing');
  await page.getByRole('button', { name: '关闭fixture', exact: true }).click();
  await page.getByRole('button', { name: '结束终端', exact: true }).click();
  await page.evaluate(() => {
    const api = (window as any).terminalTest;
    api.setCloseMode('normal');
    api.finishClose(true);
  });
  await expect(page.locator('.native-terminal')).toHaveCount(0);
  expect((await requests(page)).map((r: any) => r.type)).toEqual([
    'terminal.open',
    'terminal.close',
    'terminal.open',
    'terminal.close',
  ]);
});

for (const stage of ['close', 'close-restored', 'close-auto', 'open', 'accepted'] as const) {
  const closing = stage.startsWith('close');
  test(`${closing ? 14 : 15} disconnect during ${stage} recovers the correct process`, async ({
    page,
  }) => {
    await stale(page, closing ? '' : `?disconnectSecondOpen=${stage}`);
    await watchReload(page);
    if (closing) await page.evaluate(() => (window as any).terminalTest.setCloseMode('pending'));
    await confirm(page);
    if (closing)
      await page.evaluate((stage) => {
        const api = (window as any).terminalTest;
        api.update({ status: stage === 'close-auto' ? 'reconnecting' : 'disconnected' });
        if (stage === 'close-restored')
          api.update({ status: 'connected', connectionId: 'restored' });
        api.finishClose(false);
      }, stage);
    await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'disconnected');
    expect((await requests(page)).filter((r: any) => r.type === 'terminal.open')).toHaveLength(
      closing ? 1 : 2,
    );
    await page.evaluate(() =>
      (window as any).terminalTest.update({ status: 'connected', connectionId: 'restored' }),
    );
    if (stage !== 'close-auto')
      await page.getByRole('button', { name: '重新连接终端', exact: true }).click();
    await expect(page.locator('.terminal-tab')).toHaveAttribute('data-phase', 'running');
    const last = (await requests(page)).at(-1);
    expect(await page.evaluate(() => (window as any).reloadSeen.phases)).not.toContain('ended');
    if (closing) expect(last.terminalId).toBe('pty');
    else if (stage === 'accepted') expect(last.terminalId).toBe('reopened');
    else expect(last).not.toHaveProperty('terminalId');
  });
}
