import { expect, test, type Page } from '@playwright/test';

type TerminalFixture = {
  controls: { type: string; data?: string; bytes?: number; cols?: number; rows?: number }[];
  requests: { type: string }[];
  receive: (message: object) => void;
  finishOpen: () => void;
  unmount: () => void;
  closed: number;
};
declare global {
  interface Window {
    terminalFixture: TerminalFixture;
  }
}
async function mount(page: Page, delayed = false) {
  await page.goto('/');
  await page.evaluate(async (delayed) => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const terminalPath = '/src/NativeTerminal.tsx';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { default: Terminal } = await import(terminalPath);
    let listener: (message: object) => void = () => {};
    let release = () => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const fixture: TerminalFixture = {
      controls: [],
      requests: [],
      closed: 0,
      receive: (message) => listener({ sessionId: 'fixture', terminalId: 'terminal', ...message }),
      finishOpen() {
        fixture.receive({ type: 'terminal.opened' });
        release();
      },
      unmount: () => root.unmount(),
    };
    window.terminalFixture = fixture;
    const client = {
      onTerminal(callback: typeof listener) {
        listener = callback;
        return () => {
          listener = () => {};
        };
      },
      async request(command: { type: string }) {
        fixture.requests.push(command);
        if (command.type === 'terminal.open') {
          if (!delayed) fixture.finishOpen();
          await opened;
        }
      },
      terminalControl(command: TerminalFixture['controls'][number]) {
        fixture.controls.push(command);
      },
    };
    root.render(
      React.createElement(Terminal, {
        client,
        sessionId: 'fixture',
        onClose() {
          fixture.closed++;
        },
      }),
    );
  }, delayed);
  await expect.poll(() => page.evaluate(() => window.terminalFixture.requests.length)).toBe(1);
}

test('resizing and changing code font preserves the process and editor focus', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'draft-focus';
    document.body.append(input);
    input.focus();
  });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(async () => {
    const path = '/src/prefs.ts';
    const { setPrefs } = await import(path);
    setPrefs((prefs: any) => ({ ...prefs, fontSizes: { ...prefs.fontSizes, code: 24 } }));
  });
  await expect(page.locator('#draft-focus')).toBeFocused();
  await expect
    .poll(() => page.locator('.xterm-rows').evaluate((el) => getComputedStyle(el).fontSize))
    .toBe('24px');
  expect(
    await page.evaluate(
      () => window.terminalFixture.requests.filter((r) => r.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('a temporarily unavailable character measurement does not leave the terminal at its old size', async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').length,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
  const before = await page.evaluate(
    () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').at(-1)!.cols!,
  );
  await page.evaluate(async () => {
    const path = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@xterm_addon-fit.js'))!.name;
    const { FitAddon } = await import(path);
    const original = FitAddon.prototype.proposeDimensions;
    FitAddon.prototype.proposeDimensions = function () {
      FitAddon.prototype.proposeDimensions = original;
      return undefined;
    };
    // A single layout change: no second user resize to rescue the missed fit.
    document.querySelector<HTMLElement>('.native-terminal')!.style.width = '1800px';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').at(-1)
            ?.cols ?? 0,
      ),
    )
    .toBeGreaterThan(before);
  const remoteRows = await page.evaluate(
    () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').at(-1)!.rows,
  );
  await expect(page.locator('.xterm-rows > div')).toHaveCount(remoteRows!);
  expect(
    await page.evaluate(
      () => window.terminalFixture.requests.filter((r) => r.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('local and remote grids stay equal at size limits and after restoring the layout', async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').length,
      ),
    )
    .toBeGreaterThan(0);
  const cell = await page.evaluate(() => {
    const size = window.terminalFixture.controls
      .filter((r) => r.type === 'terminal.resize')
      .at(-1)!;
    const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
    return { width: screen.width / size.cols!, height: screen.height / size.rows! };
  });
  for (const layout of [
    { width: 6000, height: 4000, cols: 400, rows: 160 },
    { width: 100, height: 80, cols: 20, rows: 5 },
    { width: 1000, height: 600 },
  ]) {
    await page.evaluate(async ({ width, height }) => {
      const terminal = document.querySelector<HTMLElement>('.native-terminal')!;
      terminal.style.display = 'none';
      await new Promise(requestAnimationFrame);
      Object.assign(terminal.style, {
        display: 'flex',
        width: `${width}px`,
        height: `${height}px`,
        minHeight: '0',
      });
    }, layout);
    await expect
      .poll(() =>
        page.evaluate(
          ({ cell, layout }) => {
            const remote = window.terminalFixture.controls
              .filter((r) => r.type === 'terminal.resize')
              .at(-1)!;
            const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
            const localCols = Math.round(screen.width / cell.width);
            const localRows = Math.round(screen.height / cell.height);
            return {
              cols: remote.cols,
              rows: remote.rows,
              synchronized: localCols === remote.cols && localRows === remote.rows,
              fits:
                layout.cols !== undefined ||
                (screen.width < layout.width && screen.height < layout.height),
            };
          },
          { cell, layout },
        ),
      )
      .toMatchObject({
        synchronized: true,
        fits: true,
        ...(layout.cols !== undefined ? { cols: layout.cols, rows: layout.rows } : {}),
      });
  }
});

test('font boundaries preserve the reading position in terminal scrollback', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const data = Array.from(
      { length: 300 },
      (_, i) => `line-${String(i).padStart(3, '0')}\r\n`,
    ).join('');
    window.terminalFixture.receive({ type: 'terminal.data', data, bytes: data.length });
  });
  const first = page.locator('.xterm-rows > div').first();
  await expect(page.locator('.xterm-rows')).toContainText('line-299');
  const tail = await first.textContent();
  await page.locator('.xterm-screen').hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(() => first.textContent()).not.toBe(tail);
  const reading = await first.textContent();
  for (const code of [24, 10, 13]) {
    await page.evaluate(async (code) => {
      const path = '/src/prefs.ts';
      const { setPrefs } = await import(path);
      setPrefs((prefs: any) => ({ ...prefs, fontSizes: { ...prefs.fontSizes, code } }));
    }, code);
    await expect
      .poll(() => page.locator('.xterm-rows').evaluate((el) => getComputedStyle(el).fontSize))
      .toBe(`${code}px`);
    await expect(first).toHaveText(reading!);
  }
  expect(
    await page.evaluate(
      () => window.terminalFixture.requests.filter((r) => r.type === 'terminal.open').length,
    ),
  ).toBe(1);
});

test('clipboard paste uses bracketed paste without submitting a command', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mount(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.evaluate(() => {
    window.terminalFixture.receive({ type: 'terminal.data', data: '\x1b[?2004h', bytes: 8 });
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.terminalFixture.controls.some((r) => r.type === 'terminal.ack')),
    )
    .toBe(true);
  await page.evaluate(() => navigator.clipboard.writeText('第一行\nsecond line'));
  await page.keyboard.press('Control+Shift+V');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.terminalFixture.controls
          .filter((r) => r.type === 'terminal.input')
          .map((r) => r.data)
          .join(''),
      ),
    )
    .toBe('\x1b[200~第一行\rsecond line\x1b[201~');
});

test('delayed clipboard paste does not reach the terminal after its draft gains focus', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: () =>
        new Promise((resolve) => {
          (window as any).finishPaste = resolve;
        }),
    });
  });
  await page.keyboard.press('Control+v');
  await page.waitForFunction(() => !!(window as any).finishPaste);
  await page.evaluate(() => {
    const draft = document.createElement('textarea');
    draft.className = 'terminal-draft';
    document.body.append(draft);
    draft.focus();
    (window as any).finishPaste('stale paste');
  });
  await expect(page.locator('textarea.terminal-draft')).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.terminalFixture.controls.filter((c) => c.type === 'terminal.input'),
    ),
  ).toEqual([]);
});

test('Ctrl+C copies a terminal selection and interrupts only without a selection', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mount(page);
  await page.evaluate(() =>
    window.terminalFixture.receive({ type: 'terminal.data', data: 'copy-sample', bytes: 11 }),
  );
  await expect(page.locator('.xterm-rows')).toContainText('copy-sample');
  const box = await page.locator('.xterm-screen').boundingBox();
  const width = await page.locator('.xterm-rows').evaluate((el) => {
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = getComputedStyle(el).font;
    return context.measureText('W').width;
  });
  await page.mouse.move(box!.x + 1, box!.y + 7);
  await page.mouse.down();
  await page.mouse.move(box!.x + width * 11, box!.y + 7, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('copy-sample');
  expect(
    await page.evaluate(() =>
      window.terminalFixture.controls.filter((r) => r.type === 'terminal.input'),
    ),
  ).toEqual([]);
  await page.keyboard.press('Control+c');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.terminalFixture.controls
          .filter((r) => r.type === 'terminal.input')
          .map((r) => r.data),
      ),
    )
    .toEqual(['\x03']);
});

test('native terminal focuses keyboard input and acknowledges rendered output', async ({
  page,
}) => {
  await mount(page);
  const input = page.locator('.xterm-helper-textarea');
  await expect(input).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.terminalFixture.controls
          .filter((frame) => frame.type === 'terminal.input')
          .map((frame) => frame.data),
      ),
    )
    .toEqual(['\x1b[B', '\r', '\x03']);
  await page.evaluate(() =>
    window.terminalFixture.receive({ type: 'terminal.data', data: '中文🙂\r\n', bytes: 12 }),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.terminalFixture.controls
          .filter((frame) => frame.type === 'terminal.ack')
          .reduce((sum, frame) => sum + frame.bytes!, 0),
      ),
    )
    .toBe(12);
  await page.getByRole('button', { name: '关闭原生终端', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.terminalFixture.closed)).toBe(1);
});

test('native terminal closes a process whose open reply arrives after unmount', async ({
  page,
}) => {
  await mount(page, true);
  await page.evaluate(() => window.terminalFixture.unmount());
  await page.evaluate(() => window.terminalFixture.finishOpen());
  await expect
    .poll(() => page.evaluate(() => window.terminalFixture.requests.map((request) => request.type)))
    .toEqual(['terminal.open', 'terminal.close']);
});

test('native terminal can be dismissed after the remote process exits', async ({ page }) => {
  await mount(page);
  await page.evaluate(() =>
    window.terminalFixture.receive({ type: 'terminal.closed', exitCode: 0 }),
  );
  await expect(page.getByText('已结束 · 退出码 0')).toBeVisible();
  await page.getByRole('button', { name: '关闭原生终端', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.terminalFixture.closed)).toBe(1);
  expect(
    await page.evaluate(() => window.terminalFixture.requests.map((request) => request.type)),
  ).toEqual(['terminal.open']);
});
