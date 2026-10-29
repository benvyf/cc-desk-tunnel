import { expect, test, type Page } from '@playwright/test';

type TerminalFixture = {
  controls: { type: string; data?: string; bytes?: number }[];
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
  await expect(page.getByText('已结束 · 0')).toBeVisible();
  await page.getByRole('button', { name: '关闭原生终端', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.terminalFixture.closed)).toBe(1);
  expect(
    await page.evaluate(() => window.terminalFixture.requests.map((request) => request.type)),
  ).toEqual(['terminal.open']);
});
