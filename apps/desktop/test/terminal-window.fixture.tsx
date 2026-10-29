import React from 'react';
import { createRoot } from 'react-dom/client';
import TerminalWindow from '../src/TerminalWindow.tsx';
import TitleBar from '../src/TitleBar.tsx';
import '../src/style.css';
const requests: object[] = [];
const controls: object[] = [];
let listener = (message: unknown) => {};
let closeMode: 'normal' | 'pending' | 'fail' = 'normal';
let finishClose: (ok: boolean) => void = () => {};
const client = {
  onTerminal(fn: typeof listener) {
    listener = fn;
    return () => {
      if (listener === fn) listener = () => {};
    };
  },
  async request(command: { type: string }) {
    requests.push(command);
    if (command.type === 'terminal.open')
      listener({ type: 'terminal.opened', sessionId: 'fixture', terminalId: 'pty' });
    if (command.type === 'terminal.close') {
      if (closeMode === 'fail') throw new Error('测试：关闭失败');
      if (closeMode === 'pending')
        await new Promise<void>((resolve, reject) => {
          finishClose = (ok) => (ok ? resolve() : reject(new Error('测试：关闭时终端已结束')));
        });
    }
  },
  terminalControl(command: object) {
    controls.push(command);
  },
};
const host = document.createElement('div');
document.body.replaceChildren(host);
const root = createRoot(host);
function Fixture() {
  const [open, setOpen] = React.useState(true);
  const close = React.useCallback(() => setOpen(false), []);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(TitleBar, {
      title: '测试',
      sideOpen: true,
      toggleSide() {},
      menus: [{ label: '帮助', items: [] }],
      openMenu() {},
      connected: true,
      adapterName: 'fixture',
      terminalAvailable: true,
      terminalOpen: open,
      openTerminal() {
        if (open) void window.desktop!.terminalWindow.focus();
        else setOpen(true);
      },
    }),
    open &&
      React.createElement(TerminalWindow, {
        client: client as any,
        sessionId: 'fixture',
        onClose: close,
      }),
  );
}
root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture)));
Object.assign(window, {
  terminalTest: {
    requests,
    controls,
    setCloseMode: (mode: typeof closeMode) => {
      closeMode = mode;
    },
    finishClose: (ok: boolean) => finishClose(ok),
    emit: (message: object) => listener({ sessionId: 'fixture', terminalId: 'pty', ...message }),
  },
});
