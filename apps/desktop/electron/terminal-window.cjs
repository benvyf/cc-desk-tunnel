const { installEditMenu } = require('./edit-menu.cjs');
const path = require('node:path');
const windows = new WeakSet();
function isTerminalWindow(window) {
  return windows.has(window);
}
function installTerminalWindow(owner, Menu) {
  let terminal;
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
        frame: true,
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
    windows.add(child);
    if (Menu) installEditMenu(child, Menu);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    child.on('closed', () => {
      if (terminal !== child) return;
      terminal = undefined;
      if (!owner.webContents.isDestroyed()) owner.webContents.send('terminal-window:closed');
    });
  });
  owner.on('closed', () => {
    if (terminal && !terminal.isDestroyed()) terminal.destroy();
  });
  return { focus };
}
module.exports = { installTerminalWindow, isTerminalWindow };
