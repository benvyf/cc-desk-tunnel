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

test('the canvas and its ANSI colours come from the terminal tokens of the stylesheet', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    window.terminalFixture.receive({
      type: 'terminal.data',
      data: '\x1b[31mred\x1b[0m \x1b[92mgreen\x1b[0m plain\r\n',
      bytes: 32,
    }),
  );
  await expect(page.locator('.xterm-rows')).toContainText('plain');
  const token = (name: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, name);
  const colour = (text: string) =>
    page
      .locator('.xterm-rows span')
      .filter({ hasText: new RegExp(`^${text}$`) })
      .evaluate((node) => getComputedStyle(node).color);
  // xterm paints its theme on the scrolling area; the viewport behind the inset takes the same token, and the
  // terminal's own edge shows that colour rather than xterm.css's black.
  const background = await token('--terminal-bg');
  expect(
    await page
      .locator('.xterm-scrollable-element')
      .evaluate((node: HTMLElement) => node.style.backgroundColor),
  ).toBe(background);
  expect(
    await page
      .locator('.xterm-viewport')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe(background);
  const edge = await page.evaluate(() => {
    const box = document.querySelector('.terminal-host .xterm')!.getBoundingClientRect();
    return getComputedStyle(document.elementFromPoint(box.left + 30, box.bottom - 2)!)
      .backgroundColor;
  });
  expect(edge).toBe(background);
  expect(await page.locator('.xterm-rows').evaluate((node) => getComputedStyle(node).color)).toBe(
    await token('--terminal-fg'),
  );
  expect(await colour('red')).toBe(await token('--terminal-red'));
  expect(await colour('green')).toBe(await token('--terminal-bright-green'));
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

test('fullscreen hover and wheel reports are coalesced per frame without reordering keys', async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  // Claude Code's fullscreen renderer: any-motion tracking with SGR encoding.
  await page.evaluate(() => {
    const data = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
    window.terminalFixture.receive({ type: 'terminal.data', data, bytes: data.length });
  });
  const box = (await page.locator('.xterm-screen').boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.evaluate(() => (window.terminalFixture.controls.length = 0));
  // About 60 cells crossed inside one or two frames.
  await page.evaluate(
    ({ x, y, width }) => {
      const screen = document.querySelector('.xterm-screen')!;
      for (let i = 0; i < 60; i++)
        screen.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: x + 5 + (i * (width - 10)) / 60,
            clientY: y + 5,
          }),
        );
    },
    { x: box.x, y: box.y, width: box.width },
  );
  await page.keyboard.type('a');
  await page.waitForTimeout(100);
  const inputs = await page.evaluate(() =>
    window.terminalFixture.controls.filter((r) => r.type === 'terminal.input').map((r) => r.data!),
  );
  expect(inputs.length).toBeLessThanOrEqual(4);
  expect(inputs.at(-1)).toBe('a');
  const reports = inputs.join('').match(/\x1b\[<35;(\d+);\d+M/g) ?? [];
  expect(reports.length).toBeGreaterThan(0);
  expect(reports.length).toBeLessThanOrEqual(3);
  // The position the pointer last reached before the key is the one sent.
  const lastCol = Number(reports.at(-1)!.split(';')[1]);
  expect(lastCol).toBeGreaterThan(50);

  await page.evaluate(() => (window.terminalFixture.controls.length = 0));
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 100);
  await page.waitForTimeout(100);
  const wheel = await page.evaluate(() =>
    window.terminalFixture.controls
      .filter((r) => r.type === 'terminal.input')
      .map((r) => r.data!)
      .join(''),
  );
  // Every wheel tick still reaches the program; none is merged away.
  expect((wheel.match(/\x1b\[<65;\d+;\d+M/g) ?? []).length).toBeGreaterThanOrEqual(8);
});

test('refit makes the remote program lay out again at the same size', async ({ page }) => {
  await mount(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').length,
      ),
    )
    .toBeGreaterThan(0);
  const size = await page.evaluate(
    () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').at(-1)!,
  );
  await page.evaluate(() => (window.terminalFixture.controls.length = 0));
  await page.getByRole('button', { name: '重新适配窗口' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.terminalFixture.controls
          .filter((r) => r.type === 'terminal.resize')
          .map((r) => `${r.cols}:${r.rows}`),
      ),
    )
    .toEqual([`${size.cols! - 1}:${size.rows}`, `${size.cols}:${size.rows}`]);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
});

test('a window that reports no size while maximizing is measured once it has one', async ({
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
  const before = await page.evaluate(
    () => window.terminalFixture.controls.filter((r) => r.type === 'terminal.resize').at(-1)!.cols!,
  );
  await page.evaluate(async () => {
    const terminal = document.querySelector<HTMLElement>('.native-terminal')!;
    const host = terminal.querySelector<HTMLElement>('.xterm')!.parentElement!;
    // The host collapses for a few frames, then the final, wider size arrives without the
    // element observer seeing another change on the terminal itself.
    host.style.display = 'none';
    window.dispatchEvent(new Event('resize'));
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    terminal.style.width = '1800px';
    host.style.display = '';
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
});
