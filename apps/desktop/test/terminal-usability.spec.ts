import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function mount(page: Page, query = '') {
  await page.goto(`/test/terminal-window.fixture.html${query}`);
  await expect(page.getByRole('tab')).toHaveCount(1);
  if (!query.includes('waitExecution') && !query.includes('waitConnection'))
    await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
}

async function output(page: Page, data: string, sessionId = 'fixture', terminalId = 'pty') {
  await page.evaluate(
    ({ data, sessionId, terminalId }) =>
      new Promise<void>((resolve) => {
        const api = (window as any).terminalTest;
        const terminal = api.terminalInstances.findLast(
          (instance: any) => instance.element?.isConnected,
        );
        const listener = terminal.onWriteParsed(() => {
          listener.dispose();
          resolve();
        });
        api.emit({
          type: 'terminal.data',
          sessionId,
          terminalId,
          data,
          bytes: new TextEncoder().encode(data).length,
        });
      }),
    { data, sessionId, terminalId },
  );
}

const selection = (page: Page, index = 0) =>
  page.evaluate(
    (index) =>
      (window as any).terminalTest.terminalInstances
        .filter((terminal: any) => terminal.element?.isConnected)
        [index].getSelection(),
    index,
  );

test('connection readiness and authoritative Claude activity are displayed independently', async ({
  page,
}) => {
  await mount(page);
  const status = page.locator('.terminal-runtime-status');
  await expect(status).toContainText('服务端已连接');
  await expect(status).toContainText('Claude 状态待同步');
  for (const [activity, text] of [
    ['working', 'Claude 正在运行'],
    ['waiting', 'Claude 等待确认或回答'],
    ['idle', 'Claude 等待输入'],
  ]) {
    await page.evaluate((activity) => {
      const api = (window as any).terminalTest;
      api.update({
        sessions: api.snapshot().sessions.map((session: any) => ({
          ...session,
          activeRun: { id: 'pty', status: 'running', surface: 'terminal', activity },
        })),
      });
    }, activity);
    await expect(status).toContainText(text);
  }
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('initial launch waits for the execution channel without polling or starting a CLI early', async ({
  page,
}) => {
  await mount(page, '?waitExecution=1');
  await expect(page.locator('.terminal-runtime-status')).toContainText('等待执行通道就绪');
  expect(await page.evaluate(() => (window as any).terminalTest.requests)).toEqual([]);
  await page.evaluate(() => {
    const api = (window as any).terminalTest;
    api.update({ devices: [{ ...api.snapshot().sessions[0].device, ready: true }] });
  });
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('initial service connection adopts its new identity before opening a terminal', async ({
  page,
}) => {
  await mount(page, '?waitConnection=1');
  await expect(page.locator('.terminal-runtime-status')).toContainText('正在连接服务端');
  expect(await page.evaluate(() => (window as any).terminalTest.requests)).toEqual([]);
  await page.evaluate(() =>
    (window as any).terminalTest.update({ status: 'connected', connectionId: 'first-ready' }),
  );
  await expect(page.getByRole('tab')).toContainText('Linux · Claude Code');
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('reconnection clearly resumes the original process and never replays input', async ({
  page,
}) => {
  await mount(page);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('abc');
  const before = await page.evaluate(() =>
    (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
  );
  await page.evaluate(() => (window as any).terminalTest.update({ status: 'reconnecting' }));
  await expect(page.locator('.terminal-runtime-status')).toContainText('正在重连服务端');
  await page.evaluate(() =>
    (window as any).terminalTest.update({ status: 'connected', connectionId: 'restored' }),
  );
  await expect(page.locator('.terminal-recovery-note')).toHaveText('已接回原终端，未重发输入。');
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').at(-1)
          .terminalId,
    ),
  ).toBe('pty');
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
    ),
  ).toEqual(before);
});

test('an expired original process is explicit and never silently replaced', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const api = (window as any).terminalTest;
    api.setOpenMode('expired');
    api.update({ status: 'reconnecting' });
    api.update({ status: 'connected', connectionId: 'after-expiry' });
  });
  await expect(page.locator('.terminal-runtime-status')).toContainText('原终端已结束');
  await expect(page.locator('.terminal-recovery-note')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.requests.filter(
        (c: any) => c.type === 'terminal.session.create',
      ),
    ),
  ).toEqual([]);
});

test('local search finds ANSI, soft-wrapped Chinese and literal text even after a terminal ends', async ({
  page,
}) => {
  await mount(page);
  const cols = await page.evaluate(
    () =>
      (window as any).terminalTest.terminalInstances.filter(
        (terminal: any) => terminal.element?.isConnected,
      )[0].cols,
  );
  await output(
    page,
    `\x1b[31malpha\x1b[0m 中文目标\r\n${'x'.repeat(cols - 2)}中文跨行目标\r\nregex a.*b\r\n`,
  );
  await page.evaluate(() =>
    (window as any).terminalTest.emit({ type: 'terminal.closed', exitCode: 0 }),
  );
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  const input = page.getByRole('textbox', { name: '终端查找文字' });
  for (const [query, expected] of [
    ['ALPHA', 'alpha'],
    ['中文跨行目标', '中文跨行目标'],
    ['a.*b', 'a.*b'],
  ]) {
    await input.fill(query);
    await expect.poll(() => selection(page)).toBe(expected);
  }
  await input.fill('不存在的内容');
  await expect(page.getByRole('search')).toContainText('未找到');
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.requests.filter((c: any) => c.type !== 'terminal.open'),
    ),
  ).toEqual([]);
});

test('search navigates both directions and keeps keyboard focus through resizing', async ({
  page,
}, testInfo) => {
  await mount(page);
  await output(page, 'hit one\r\nmiddle\r\nhit two\r\nspare\r\nhit three\r\n');
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  const input = page.getByRole('textbox', { name: '终端查找文字' });
  await input.fill('hit');
  await page.locator('.xterm-helper-textarea').focus();
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await expect(input).toBeFocused();
  const position = () =>
    page.evaluate(
      () =>
        (window as any).terminalTest.terminalInstances
          .filter((terminal: any) => terminal.element?.isConnected)[0]
          .getSelectionPosition().start.y,
    );
  const first = await position();
  await input.press('Enter');
  await expect.poll(position).toBeGreaterThan(first);
  await page.getByRole('button', { name: '上一个', exact: true }).press('Enter');
  await expect.poll(position).toBe(first);
  await page.getByRole('button', { name: '下一个', exact: true }).press('Enter');
  await expect.poll(position).toBeGreaterThan(first);
  await input.press('Shift+Enter');
  await expect.poll(position).toBe(first);
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 650 });
    await expect(input).toBeFocused();
    const box = await page.getByRole('search').boundingBox();
    const host = await page.locator('.terminal-host').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(host!.y);
  }
  await page
    .locator('.terminal-workspace')
    .screenshot({ path: testInfo.outputPath('search-narrow.png') });
  await page.getByRole('button', { name: '关闭终端查找', exact: true }).press('Enter');
  await expect(page.getByRole('search')).toHaveCount(0);
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await input.press('Escape');
  await expect(page.getByRole('search')).toHaveCount(0);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
    ),
  ).toEqual([]);
  await page.keyboard.press('z');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).terminalTest.controls
          .filter((c: any) => c.type === 'terminal.input')
          .map((c: any) => c.data),
      ),
    )
    .toEqual(['z']);
});

test('search terms stay with their own terminal tab without opening more processes', async ({
  page,
}) => {
  await mount(page);
  await output(page, 'alpha first\r\n');
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await page.getByRole('textbox', { name: '终端查找文字' }).fill('alpha');
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('search')).toHaveCount(0);
  await output(page, 'beta second\r\n', 'fixture-1', 'pty-fixture-1');
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await page.getByRole('textbox', { name: '终端查找文字' }).fill('beta');
  await expect.poll(() => selection(page, 1)).toBe('beta');
  await page.getByRole('tab').first().click();
  await expect(page.getByRole('textbox', { name: '终端查找文字' })).toHaveValue('alpha');
  await expect.poll(() => selection(page)).toBe('alpha');
  expect(
    await page.evaluate(
      () =>
        (window as any).terminalTest.requests.filter((c: any) => c.type === 'terminal.open').length,
    ),
  ).toBe(2);
});

test('search composition and a delayed paste never become terminal input', async ({ page }) => {
  await mount(page);
  await output(page, '中文查找\r\n');
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          (window as any).finishTerminalPaste = resolve;
        }),
    }),
  );
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+V');
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  const input = page.getByRole('textbox', { name: '终端查找文字' });
  await page.evaluate(() => (window as any).finishTerminalPaste('must-not-be-sent'));
  await input.dispatchEvent('compositionstart');
  await input.fill('中文');
  await input.press('Escape');
  await expect(input).toBeVisible();
  await input.dispatchEvent('compositionend', { data: '中文' });
  await expect.poll(() => selection(page)).toBe('中文');
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
    ),
  ).toEqual([]);
});

test('new output preserves the reading position and offers an explicit return to the bottom', async ({
  page,
}) => {
  await mount(page);
  await output(page, Array.from({ length: 300 }, (_, i) => `line-${i}\r\n`).join(''));
  const viewport = () =>
    page.evaluate(() => {
      const terminal = (window as any).terminalTest.terminalInstances.findLast(
        (t: any) => t.element?.isConnected,
      );
      const buffer = terminal.buffer.active;
      return {
        row: buffer.viewportY,
        first: buffer.getLine(buffer.viewportY).translateToString(true),
        atBottom: buffer.viewportY === buffer.baseY,
      };
    });
  await page.evaluate(() =>
    (window as any).terminalTest.terminalInstances
      .findLast((t: any) => t.element?.isConnected)
      .scrollToLine(100),
  );
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
  const before = await viewport();
  await output(page, 'new-tail-one\r\nnew-tail-two\r\n');
  expect(await viewport()).toMatchObject({ row: before.row, first: before.first, atBottom: false });
  await page.getByRole('button', { name: '有新输出 · 回到底部', exact: true }).click();
  await expect.poll(async () => (await viewport()).atBottom).toBe(true);
  await expect(page.getByRole('button', { name: /回到底部/ })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.controls.filter((c: any) => c.type === 'terminal.input'),
    ),
  ).toEqual([]);
});

test('a background tab retains its reading position and unread output when shown again', async ({
  page,
}) => {
  await mount(page);
  await output(page, Array.from({ length: 250 }, (_, i) => `saved-${i}\r\n`).join(''));
  await page.evaluate(() =>
    (window as any).terminalTest.terminalInstances
      .findLast((t: any) => t.element?.isConnected)
      .scrollToLine(80),
  );
  await page.getByRole('button', { name: '新建终端', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.evaluate(() =>
    (window as any).terminalTest.emit({
      type: 'terminal.data',
      data: 'background-output\r\n',
      bytes: 19,
    }),
  );
  await page.getByRole('tab').first().click();
  await expect(
    page.getByRole('button', { name: '有新输出 · 回到底部', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const terminal = (window as any).terminalTest.terminalInstances.filter(
          (t: any) => t.element?.isConnected,
        )[0];
        return terminal.buffer.active
          .getLine(terminal.buffer.active.viewportY)
          .translateToString(true);
      }),
    )
    .toBe('saved-80');
});

test('search works while prediction toggles without taking ownership of proposed APIs', async ({
  page,
}) => {
  await mount(page);
  await output(page, 'search target\r\n');
  const proposed = () =>
    page.evaluate(
      () =>
        (window as any).terminalTest.terminalInstances.findLast((t: any) => t.element?.isConnected)
          .options.allowProposedApi,
    );
  await page.evaluate(() => (window as any).terminalTest.setPrediction(false));
  await expect.poll(proposed).toBe(false);
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  const input = page.getByRole('textbox', { name: '终端查找文字' });
  await input.fill('target');
  await expect.poll(() => selection(page)).toBe('target');
  await expect.poll(proposed).toBe(false);
  await page.evaluate(() => (window as any).terminalTest.setPrediction(true));
  await expect.poll(proposed).toBe(true);
  await page.evaluate(() => (window as any).terminalTest.setPrediction(false));
  await expect.poll(proposed).toBe(false);
  await input.fill('TARGET');
  await expect.poll(() => selection(page)).toBe('target');
});

test('final output is marked unread even when the exit notification precedes its render callback', async ({
  page,
}) => {
  await mount(page);
  await output(page, Array.from({ length: 250 }, (_, i) => `tail-${i}\r\n`).join(''));
  await page.evaluate(() =>
    (window as any).terminalTest.terminalInstances
      .findLast((t: any) => t.element?.isConnected)
      .scrollToLine(80),
  );
  await expect(page.getByRole('button', { name: '回到底部', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const api = (window as any).terminalTest;
    const data = 'FINAL-TAIL\r\n';
    api.emit({ type: 'terminal.data', data, bytes: data.length });
    api.emit({ type: 'terminal.closed', exitCode: 0 });
  });
  await expect(
    page.getByRole('button', { name: '有新输出 · 回到底部', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.terminal-runtime-status')).toContainText('已结束 · 退出码 0');
});

test('closing a search during composition does not leave the next search locked', async ({
  page,
}) => {
  await mount(page);
  await output(page, '中文 target\r\n');
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  const input = page.getByRole('textbox', { name: '终端查找文字' });
  await input.dispatchEvent('compositionstart');
  await input.fill('中文');
  await page.getByRole('button', { name: '关闭终端查找', exact: true }).click();
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await input.fill('target');
  await expect.poll(() => selection(page)).toBe('target');
});

test('recorded Claude alternate-screen output is searchable without pretending it has scrollback', async ({
  page,
}) => {
  await mount(page, '?predictive=1');
  const events = JSON.parse(
    readFileSync(new URL('./fixtures/terminal-echo/linux295.json', import.meta.url), 'utf8'),
  ).events;
  const index = events.findIndex(
    (event: any) => event.kind === 'input' && event.label === 'ascii-a',
  );
  const prefix = events
    .slice(0, index)
    .filter((event: any) => event.kind === 'output')
    .map((event: any) => event.data)
    .join('');
  await output(page, prefix);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).terminalTest.terminalInstances.findLast(
            (t: any) => t.element?.isConnected,
          ).buffer.active.type,
      ),
    )
    .toBe('alternate');
  await page.getByRole('button', { name: '查找终端输出', exact: true }).click();
  await page.getByRole('textbox', { name: '终端查找文字' }).fill('Claude Code');
  await expect.poll(() => selection(page)).toBe('Claude Code');
  await expect(page.getByRole('button', { name: /回到底部/ })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      (window as any).terminalTest.requests.filter((c: any) => c.type !== 'terminal.open'),
    ),
  ).toEqual([]);
});
