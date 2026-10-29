import React from 'react';
import { createRoot } from 'react-dom/client';
import TerminalWindow from '../src/TerminalWindow.tsx';
import TitleBar from '../src/TitleBar.tsx';
import '../src/style.css';
const requests: object[] = [];
const controls: object[] = [];
const listeners = new Set<(message: any) => void>();
const subscribers = new Set<() => void>();
let closeMode: 'normal' | 'pending' | 'fail' = 'normal';
let createMode: 'normal' | 'lostResponse' | 'pending' = 'normal';
let finishCreate = () => {};
let failSession: string | null = null;
let openMode: 'normal' | 'lostOpened' | 'lostResponse' = 'normal';
let finishClose: (ok: boolean) => void = () => {};
const running = new Map<string, string>();
const created = new Map<string, string>();
const session = {
  id: 'fixture',
  title: 'fixture',
  projectPath: 'D:\\fixture',
  device: { id: 'device', name: 'fixture-node', platform: 'win32' },
  permissionMode: 'default',
  model: null,
  effort: null,
  activeRun: null,
};
let state: any = {
  sessions: [session],
  status: 'connected',
  connectionId: 'fixture-connection',
  terminalWorkspace: { version: 1 },
  browser: null,
};
function update(values: object) {
  state = { ...state, ...values };
  subscribers.forEach((fn) => fn());
}
function emit(message: any) {
  if (message.type === 'terminal.closed') running.delete(message.sessionId);
  listeners.forEach((fn) => fn(message));
}
const client = {
  get state() {
    return state;
  },
  getSnapshot: () => state,
  subscribe(fn: () => void) {
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  },
  onTerminal(fn: (message: any) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  async fetch(command: { type: string; sessionId: string }) {
    if (command.type === 'terminal.history.list') {
      requests.push(command);
      return { items: state.historyItems ?? [] };
    }
    if (command.type === 'terminal.file.read') {
      requests.push(command);
      return { mime: 'text/plain', encoding: 'utf8', data: '<script>unsafe()</script>预览内容' };
    }
    return {
      state: running.has(command.sessionId) ? 'running' : 'absent',
      terminalId: running.get(command.sessionId),
    };
  },
  async request(command: any, requestId = crypto.randomUUID()) {
    requests.push(command);
    if (command.type === 'terminal.session.create' || command.type === 'terminal.history.continue') {
      let id = created.get(requestId);
      if (!id) {
        id = `fixture-${created.size + 1}`;
        created.set(requestId, id);
        update({
          sessions: [
            ...state.sessions,
            { ...session, id, projectPath: command.projectPath || session.projectPath },
          ],
        });
      }
      if (createMode === 'lostResponse') throw new Error('fixture: create response lost');
      if (createMode === 'pending')
        await new Promise<void>((resolve) => {
          finishCreate = resolve;
        });
      return { sessionId: id, ok: true, requestId };
    }
    if (command.type === 'terminal.open') {
      const terminalId = command.sessionId === 'fixture' ? 'pty' : `pty-${command.sessionId}`;
      running.set(command.sessionId, terminalId);
      if (openMode !== 'lostOpened')
        emit({ type: 'terminal.opened', sessionId: command.sessionId, terminalId });
      if (openMode === 'lostResponse') throw new Error('fixture: lost response');
    }
    if (command.type === 'terminal.close') {
      if (closeMode === 'fail' || command.sessionId === failSession)
        throw new Error('测试：关闭失败');
      if (closeMode === 'pending')
        await new Promise<void>((resolve, reject) => {
          finishClose = (ok) => (ok ? resolve() : reject(new Error('测试：关闭时终端已结束')));
        });
      running.delete(command.sessionId);
      emit({
        type: 'terminal.closed',
        sessionId: command.sessionId,
        terminalId: command.terminalId,
        exitCode: 0,
        reason: 'user_close',
      });
    }
    return { ok: true, requestId };
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
        register: (handle: any) => {
          if (handle)
            (window as any).terminalTest.closeAll = () => {
              void handle.closeAll();
            };
        },
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
    emit: (message: object) => emit({ sessionId: 'fixture', terminalId: 'pty', ...message }),
    update,
    setCreateMode: (mode: typeof createMode) => {
      createMode = mode;
    },
    finishCreate: () => finishCreate(),
    createdCount: () => created.size,
    failCloseSession: (id: string | null) => {
      failSession = id;
    },
    setOpenMode: (mode: typeof openMode) => {
      openMode = mode;
    },
  },
});
