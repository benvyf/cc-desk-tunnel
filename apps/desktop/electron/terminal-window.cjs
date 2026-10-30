const { installEditMenu } = require('./edit-menu.cjs');
const path = require('node:path');
const windows = new WeakSet();
function isTerminalWindow(window) {
  return windows.has(window);
}
function installTerminalWindow(owner, Menu) {
  const nativeControls = process.platform === 'win32';
  let terminal;
  let active = false;
  let approved = false;
  let finishClose;
  const focus = () => {
    if (!terminal || terminal.isDestroyed()) return false;
    if (terminal.isMinimized()) terminal.restore();
    terminal.show();
    terminal.focus();
    return true;
  };
  owner.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url !== 'about:blank' || frameName !== 'cc-native-terminal') return { action: 'deny' };
    if (focus()) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1000,
        height: 680,
        minWidth: 480,
        minHeight: 300,
        title: 'CC SPACE · 原生终端',
        backgroundColor: '#0b0b0a',
        autoHideMenuBar: true,
        frame: nativeControls,
        ...(nativeControls
          ? {
              titleBarStyle: 'hidden',
              titleBarOverlay: {
                color: '#1a1a19',
                symbolColor: '#dedcd6',
                height: 36,
              },
            }
          : {}),
        resizable: true,
        minimizable: true,
        maximizable: true,
        fullscreenable: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
          // Never inherit the primary window's privileged desktop bridge.
          preload: path.join(__dirname, 'terminal-preload.cjs'),
        },
      },
    };
  });
  owner.webContents.on('did-create-window', (child, details) => {
    if (details.frameName !== 'cc-native-terminal') return;
    terminal = child;
    approved = false;
    windows.add(child);
    if (Menu) installEditMenu(child, Menu);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    const state = () => {
      if (!owner.webContents.isDestroyed())
        owner.webContents.send('terminal-window:state', { maximized: child.isMaximized() });
    };
    child.on('maximize', state);
    child.on('unmaximize', state);
    child.on('close', (event) => {
      if (approved || !active) return;
      event.preventDefault();
      if (!owner.webContents.isDestroyed()) owner.webContents.send('terminal-window:request-close');
    });
    child.on('closed', () => {
      if (terminal !== child) return;
      terminal = undefined;
      finishClose?.(true);
      finishClose = undefined;
      if (!owner.webContents.isDestroyed()) owner.webContents.send('terminal-window:closed');
    });
  });
  owner.on('closed', () => {
    if (terminal && !terminal.isDestroyed()) terminal.destroy();
  });
  return {
    window: () => terminal,
    focus,
    appearance(theme) {
      if (
        !terminal ||
        terminal.isDestroyed() ||
        !nativeControls ||
        !['light', 'dark'].includes(theme)
      )
        return { nativeControls: false };
      terminal.setTitleBarOverlay(
        theme === 'light'
          ? { color: '#ffffff', symbolColor: '#20201e', height: 36 }
          : { color: '#1a1a19', symbolColor: '#dedcd6', height: 36 },
      );
      return { nativeControls: true };
    },
    setActive(value) {
      active = value === true;
    },
    requestClose() {
      if (!active || !terminal || terminal.isDestroyed()) return Promise.resolve(true);
      focus();
      owner.webContents.send('terminal-window:request-close');
      return new Promise((resolve) => {
        finishClose = resolve;
      });
    },
    finishClose(allowed) {
      finishClose?.(allowed === true);
      finishClose = undefined;
    },
    control(action) {
      if (!terminal || terminal.isDestroyed()) return false;
      if (action === 'minimize') terminal.minimize();
      else if (action === 'maximize') {
        if (terminal.isMaximized()) terminal.unmaximize();
        else terminal.maximize();
      } else if (action === 'destroy') {
        approved = true;
        terminal.destroy();
      } else return false;
      return true;
    },
  };
}
module.exports = { installTerminalWindow, isTerminalWindow };
