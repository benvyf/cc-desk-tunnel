import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

test('detached terminal has native window controls, exact input, resize, focus and cleanup', async () => {
  test.setTimeout(90000);
  const directory = mkdtempSync(join(tmpdir(), 'cc-terminal-window-'));
  const module = resolve('apps/desktop/electron/terminal-window.cjs');
  const preload = join(directory, 'preload.cjs');
  writeFileSync(
    preload,
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktop',{terminalWindow:{focus:()=>ipcRenderer.invoke('terminal-window:focus'),control:action=>ipcRenderer.invoke('terminal-window:control',action),setActive:active=>ipcRenderer.invoke('terminal-window:active',active),finishClose:allowed=>ipcRenderer.invoke('terminal-window:finish-close',allowed),onRequestClose:callback=>{const fn=()=>callback();ipcRenderer.on('terminal-window:request-close',fn);return ()=>ipcRenderer.removeListener('terminal-window:request-close',fn);},onClosed:callback=>{const fn=()=>callback();ipcRenderer.on('terminal-window:closed',fn);return ()=>ipcRenderer.removeListener('terminal-window:closed',fn);}}});`,
  );
  const main = join(directory, 'main.cjs');
  writeFileSync(
    main,
    `const {app,BrowserWindow,ipcMain,Menu}=require('electron');const {installTerminalWindow,isTerminalWindow}=require(${JSON.stringify(module)});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,backgroundThrottling:false}});const terminal=installTerminalWindow(win,Menu);ipcMain.handle('terminal-window:focus',()=>terminal.focus());ipcMain.handle('terminal-window:control',(_event,action)=>terminal.control(action));ipcMain.handle('terminal-window:active',(_event,active)=>terminal.setActive(active));ipcMain.handle('terminal-window:finish-close',(_event,allowed)=>terminal.finishClose(allowed));${process.env.CC_TERMINAL_FIXTURE_FILE ? `win.loadFile(${JSON.stringify(process.env.CC_TERMINAL_FIXTURE_FILE)})` : "win.loadURL('http://127.0.0.1:15173/test/terminal-window.fixture.html')"};});app.on('before-quit',()=>{for(const win of BrowserWindow.getAllWindows())if(isTerminalWindow(win))win.destroy();});app.on('window-all-closed',()=>app.quit());`,
  );
  const application = await electron.launch({
    executablePath:
      process.env.CC_TEST_ELECTRON || resolve('node_modules/electron/dist/electron.exe'),
    args: [main],
  });
  try {
    const owner = await application.firstWindow();
    await owner.waitForLoadState();
    const errors: string[] = [];
    owner.on('pageerror', (error) => errors.push(error.message));
    owner.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy'))
        errors.push(message.text());
    });
    await owner.waitForFunction(() => !!(window as any).terminalTest);
    await expect.poll(() => application.windows().length).toBe(2);
    const child = application.windows().find((page) => page !== owner)!;
    child.on('pageerror', (error) => errors.push(error.message));
    await expect(child.locator('.xterm-helper-textarea')).toBeFocused();
    expect(await child.evaluate(() => typeof window.desktop)).toBe('undefined');
    expect(await child.evaluate(() => window.opener === null)).toBe(true);
    await child.keyboard.press('ArrowDown');
    await child.keyboard.press('Enter');
    await child.keyboard.press('Control+c');
    await expect
      .poll(() =>
        owner.evaluate(() =>
          (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.input')
            .map((f: any) => f.data),
        ),
      )
      .toEqual(['\x1b[B', '\r', '\x03']);
    await expect
      .poll(() =>
        owner.evaluate(
          () =>
            (window as any).terminalTest.controls.filter((f: any) => f.type === 'terminal.resize')
              .length,
        ),
      )
      .toBeGreaterThan(0);
    await application.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'CC SPACE · 原生终端',
      )!;
      child.setBounds({ x: 100, y: 100, width: 480, height: 300 });
      child.webContents.setZoomFactor(1.25);
    });
    await owner.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
      document.documentElement.dataset.theme = 'light';
    });
    await expect
      .poll(() => child.evaluate(() => getComputedStyle(document.documentElement).fontSize))
      .toBe('20px');
    await expect
      .poll(() => child.evaluate(() => document.documentElement.dataset.theme))
      .toBe('light');
    await expect(child.getByRole('button', { name: '新建终端', exact: true })).toBeVisible();
    await expect(child.locator('.terminal-workspace-footer')).toBeVisible();
    expect(await child.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect.poll(() => child.evaluate(() => innerWidth)).toBe(384);
    writeFileSync(
      resolve('.local/terminal-workspace-layout.json'),
      JSON.stringify(
        await child.evaluate(() => ({
          viewport: [innerWidth, innerHeight],
          boxes: [
            ...document.querySelectorAll(
              '.terminal-window-controls button, .terminal-workspace-footer',
            ),
          ].map((el) => ({
            text: el.getAttribute('aria-label') || el.textContent,
            rect: el.getBoundingClientRect().toJSON(),
          })),
        })),
        null,
        2,
      ),
    );
    await child.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await child.screenshot({ path: resolve('.local/terminal-workspace-native-small.png') });
    for (const selector of [
      '.terminal-window-controls button:nth-child(1)',
      '.terminal-window-controls button:nth-child(2)',
      '.terminal-window-controls button:nth-child(3)',
      '.terminal-workspace-footer',
    ]) {
      expect(
        await child.locator(selector).evaluate((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.x >= 0 &&
            r.y >= 0 &&
            r.width > 0 &&
            r.height > 0 &&
            r.right <= innerWidth + 1 &&
            r.bottom <= innerHeight + 1
          );
        }),
      ).toBe(true);
    }

    await application.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'CC SPACE · 原生终端',
      )!;
      child.webContents.setZoomFactor(1);
      child.setBounds({ x: 100, y: 100, width: 1000, height: 680 });
    });
    await owner.evaluate(() => {
      document.documentElement.style.fontSize = '';
      document.documentElement.dataset.theme = 'dark';
    });
    const initialSize = await owner.evaluate(() =>
      (window as any).terminalTest.controls.filter((f: any) => f.type === 'terminal.resize').at(-1),
    );
    const bounds = await application.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(
        (w) => w.getTitle() === 'CC SPACE · 原生终端',
      )!;
      child.setBounds({ x: 120, y: 100, width: 800, height: 500 });
      return {
        resizable: child.isResizable(),
        maximizable: child.isMaximizable(),
        minimizable: child.isMinimizable(),
      };
    });
    expect(bounds).toEqual({ resizable: true, maximizable: true, minimizable: true });
    await expect
      .poll(() =>
        owner.evaluate(
          () =>
            (window as any).terminalTest.controls.filter((f: any) => f.type === 'terminal.resize')
              .length,
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        owner.evaluate(() =>
          (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.resize')
            .at(-1),
        ),
      )
      .not.toEqual(initialSize);
    const smallSize = await owner.evaluate(() =>
      (window as any).terminalTest.controls.filter((f: any) => f.type === 'terminal.resize').at(-1),
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === 'CC SPACE · 原生终端')!
        .maximize(),
    );
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === 'CC SPACE · 原生终端')!
            .isMaximized(),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        owner.evaluate((small) => {
          const size = (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.resize')
            .at(-1);
          return size.cols > small.cols || size.rows > small.rows;
        }, smallSize),
      )
      .toBe(true);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === 'CC SPACE · 原生终端')!
        .unmaximize(),
    );
    await expect
      .poll(() =>
        owner.evaluate(() =>
          (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.resize')
            .at(-1),
        ),
      )
      .toEqual(smallSize);
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === 'CC SPACE · 原生终端')!
        .minimize();
    });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() !== 'CC SPACE · 原生终端')!
        .setSize(500, 800),
    );
    await expect(owner.getByRole('button', { name: '终端', exact: true })).toBeVisible();
    await owner.getByRole('button', { name: '终端', exact: true }).click();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.getTitle() === 'CC SPACE · 原生终端')!
            .isMinimized(),
        ),
      )
      .toBe(false);
    expect(await owner.locator('.titlebar-menus button').allTextContents()).toEqual([
      '帮助',
      '终端',
    ]);
    const pasted = '中文🙂'.repeat(2400);
    await child.locator('.xterm-helper-textarea').evaluate((input, text) => {
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', text);
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: clipboard }));
    }, pasted);
    await expect
      .poll(() =>
        owner.evaluate(() =>
          (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.input')
            .slice(3)
            .map((f: any) => f.data)
            .join(''),
        ),
      )
      .toBe(pasted);
    expect(
      await owner.evaluate(() =>
        (window as any).terminalTest.controls
          .filter((f: any) => f.type === 'terminal.input')
          .every((f: any) => f.data.length <= 4096),
      ),
    ).toBe(true);
    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.getTitle() === 'CC SPACE · 原生终端') window.minimize();
        else window.hide();
      }
    });
    const output = 'background output 中文🙂\r\n'.repeat(500);
    const outputBytes = Buffer.byteLength(output) * 12;
    await owner.evaluate(
      ({ data, bytes }) => {
        for (let i = 0; i < 12; i++)
          (window as any).terminalTest.emit({ type: 'terminal.data', data, bytes });
      },
      { data: output, bytes: Buffer.byteLength(output) },
    );
    await expect
      .poll(() =>
        owner.evaluate(() =>
          (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.ack')
            .reduce((n: number, f: any) => n + f.bytes, 0),
        ),
      )
      .toBe(outputBytes);
    // The real Electron popup must keep acknowledgments moving beyond the server's 30s threshold.
    await new Promise((resolve) => setTimeout(resolve, 31000));
    await owner.evaluate(() =>
      (window as any).terminalTest.emit({
        type: 'terminal.data',
        data: 'after 30 seconds',
        bytes: 16,
      }),
    );
    await expect
      .poll(() =>
        owner.evaluate(() =>
          (window as any).terminalTest.controls
            .filter((f: any) => f.type === 'terminal.ack')
            .reduce((n: number, f: any) => n + f.bytes, 0),
        ),
      )
      .toBe(outputBytes + 16);
    await owner.evaluate(() => window.desktop!.terminalWindow.focus());
    await owner.evaluate(() =>
      (window as any).terminalTest.emit({
        type: 'terminal.data',
        data: '\x1b[1;33mCC SPACE — terminal window test\x1b[0m\r\n\r\nArrow keys, Enter, resize and window restore verified.\r\n',
        bytes: 121,
      }),
    );
    await child.screenshot({ path: resolve('.local/terminal-window.png') });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === 'CC SPACE · 原生终端')!
        .close();
    });
    await expect(child.getByRole('dialog')).toBeVisible();
    await child.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(() => application.windows().length).toBe(2);
    await child.getByRole('button', { name: '关闭全部终端', exact: true }).click();
    await child.getByRole('button', { name: '结束终端', exact: true }).click();
    await expect
      .poll(() =>
        owner.evaluate(() => (window as any).terminalTest.requests.map((f: any) => f.type)),
      )
      .toEqual(['terminal.open', 'terminal.close']);
    await expect.poll(() => application.windows().length).toBe(1);
    await owner.getByRole('button', { name: '终端', exact: true }).click();
    await expect.poll(() => application.windows().length).toBe(2);
    await expect
      .poll(() =>
        owner.evaluate(() => (window as any).terminalTest.requests.map((f: any) => f.type)),
      )
      .toEqual(['terminal.open', 'terminal.close', 'terminal.open']);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
