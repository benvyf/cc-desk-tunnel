import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('real Electron popup owns project dialogs and opens another project without restarting original terminal', async () => {
  test.setTimeout(60000);
  const directory = mkdtempSync(join(tmpdir(), 'cc-multi-device-electron-'));
  const preload = join(directory, 'preload.cjs');
  const main = join(directory, 'main.cjs');
  writeFileSync(
    preload,
    `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('desktop',{boot:{shared:{}},onSharedChanged:()=>()=>{},saveShared:async()=>{},ssh:{list:async()=>[{id:'51',name:'51',projects:['/work/remote-app'],available:true,status:'connected',host:'fixture.invalid',port:22,username:'dev',auth:'key',error:''}],onChanged:()=>()=>{}},terminalWindow:{appearance:async()=>({nativeControls:false}),focus:()=>{},setActive:()=>{},control:()=>{},finishClose:()=>{},onRequestClose:()=>()=>{},onClosed:()=>()=>{}}});`,
  );
  writeFileSync(
    main,
    `const {app,BrowserWindow,Menu}=require('electron');const {installTerminalWindow,isTerminalWindow}=require(${JSON.stringify(resolve('apps/desktop/electron/terminal-window.cjs'))});app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,backgroundThrottling:false}});installTerminalWindow(win,Menu);win.loadURL(${JSON.stringify((test.info().project.use.baseURL ?? 'http://127.0.0.1:15173') + '/test/terminal-window.fixture.html')});});app.on('before-quit',()=>{for(const win of BrowserWindow.getAllWindows())if(isTerminalWindow(win))win.destroy();});`,
  );
  const application = await electron.launch({
    executablePath:
      process.env.CC_TEST_ELECTRON || resolve('node_modules/electron/dist/electron.exe'),
    args: [main],
  });
  try {
    const owner = await application.firstWindow();
    await owner.waitForFunction(() => !!(window as any).terminalTest);
    await expect.poll(() => application.windows().length).toBe(2);
    const child = application.windows().find((page) => page !== owner)!;
    await expect(child.getByRole('tab')).toHaveCount(1);
    await child.getByRole('button', { name: '切换或新建终端', exact: true }).click();
    await expect(child.locator('.terminal-list')).toBeVisible();
    await expect(owner.getByRole('dialog')).toHaveCount(0);
    await child
      .getByRole('textbox', { name: '搜索项目、设备或已打开的终端', exact: true })
      .fill('fixture');
    await child.keyboard.press('Escape');
    await expect(child.getByRole('button', { name: '切换或新建终端', exact: true })).toBeFocused();
    await child.getByRole('button', { name: '切换或新建终端', exact: true }).click();
    await child.getByRole('button', { name: '打开其他目录…', exact: true }).click();
    await expect(child.getByRole('dialog', { name: '打开项目', exact: true })).toBeVisible();
    await child
      .getByRole('textbox', { name: '本机项目目录', exact: true })
      .fill('D:\\electron-project');
    await child.getByRole('button', { name: '打开项目', exact: true }).click();
    await expect(child.getByRole('tab')).toHaveCount(2);
    expect(
      await owner.evaluate(
        () =>
          (window as any).terminalTest.requests.filter(
            (request: any) => request.type === 'terminal.open' && request.sessionId === 'fixture',
          ).length,
      ),
    ).toBe(1);
    expect(
      await owner.evaluate(
        () =>
          (window as any).terminalTest.requests.filter(
            (request: any) => request.type === 'terminal.session.create',
          ).length,
      ),
    ).toBe(1);
    await owner.evaluate(() => {
      const f = (window as any).terminalTest;
      const base = f.snapshot().sessions[0];
      f.update({
        terminalHistory: { version: 1 },
        sessions: [
          ...f.snapshot().sessions,
          {
            ...base,
            id: 'remote-51',
            projectPath: '/work/remote-app',
            device: { id: '51', name: '51', viaSsh: true },
          },
        ],
      });
      f.showSession('remote-51');
    });
    await expect(child.getByRole('tab')).toHaveCount(3);
    mkdirSync('.local/screenshots/multi-device-electron', { recursive: true });
    for (const theme of ['light', 'dark']) {
      await owner.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(child.locator('html')).toHaveAttribute('data-theme', theme);
      await child.screenshot({
        path: resolve(`.local/screenshots/multi-device-electron/popup-${theme}.png`),
        animations: 'disabled',
      });
      const toggle = child.getByRole('button', { name: '切换或新建终端', exact: true });
      await toggle.click();
      const menu = child.locator('.terminal-list');
      await expect(menu.getByRole('group', { name: '已打开', exact: true })).toBeVisible();
      await expect(menu.getByRole('group', { name: '新建终端', exact: true })).toBeVisible();
      await child.screenshot({
        path: resolve(`.local/screenshots/multi-device-electron/menu-${theme}.png`),
        animations: 'disabled',
      });
      await child.keyboard.press('Escape');
    }
    await child.getByRole('tab').last().focus();
    await child.keyboard.press('Control+Shift+T');
    await expect(child.getByRole('tab')).toHaveCount(4);
    await child.keyboard.press('Control+Tab');
    await expect(child.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await child.keyboard.press('Control+Shift+Tab');
    await expect(child.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
    await child.locator('.terminal-panel:not([hidden]) .xterm-helper-textarea').focus();
    await child.keyboard.press('Control+Shift+Space');
    await expect(child.locator('.terminal-list input')).toBeFocused();
    await expect(owner.locator('.terminal-list')).toHaveCount(0);
    await application.evaluate(({ BrowserWindow }) => {
      const terminal = BrowserWindow.getAllWindows().find(
        (win) => win.webContents.getURL() === 'about:blank',
      );
      terminal?.setBounds({ width: 520, height: 680 });
    });
    await expect.poll(() => child.evaluate(() => innerWidth)).toBeLessThan(800);
    await expect
      .poll(() =>
        child
          .locator('.terminal-list')
          .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
      )
      .toBe(true);
    await expect(child.locator('.terminal-list input')).toBeFocused();
    await child.keyboard.press('Escape');
  } finally {
    await application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
