import React from 'react';
import { createRoot } from 'react-dom/client';
import TerminalWindow from '../src/TerminalWindow.tsx';
import TitleBar from '../src/TitleBar.tsx';
import '../src/style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { PredictiveEchoAddon } from 'xterm-zerolag-input';
import { setPrefs } from '../src/prefs.ts';
import { saveShared } from '../src/shared.ts';
import { RequestFailedError } from '../src/client.ts';
import { pathKey } from '../src/paths.ts';
let holdRenderCallbacks = false;
const renderCallbacks: (() => void)[] = [];
const writeTerminal = Terminal.prototype.write;
Terminal.prototype.write = function (data, callback) {
  return writeTerminal.call(
    this,
    data,
    holdRenderCallbacks && callback ? () => renderCallbacks.push(callback) : callback,
  );
};
const terminalInstances: Terminal[] = [];
let predictiveRows = 35;
if (new URLSearchParams(location.search).get('predictive') === '1') {
  // Match the recorded Linux PTY grid independently of the test browser's font metrics.
  FitAddon.prototype.proposeDimensions = () => ({ cols: 100, rows: predictiveRows });
}
const openTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (parent) {
  terminalInstances.push(this);
  return openTerminal.call(this, parent);
};
const requests: object[] = [];
const controls: object[] = [];
const listeners = new Set<(message: any) => void>();
const subscribers = new Set<() => void>();
let closeMode: 'normal' | 'pending' | 'fail' = 'normal';
let createMode: 'normal' | 'lostResponse' | 'pending' = 'normal';
let finishCreate = () => {};
let failSession: string | null = null;
let openMode: 'normal' | 'lostOpened' | 'lostResponse' | 'expired' = 'normal';
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
  updatedAt: '2026-11-05T00:00:00Z',
};
let state: any = {
  device: session.device,
  sessions: [session],
  status: 'connected',
  connectionId: 'fixture-connection',
  terminalWorkspace: { version: 1, minRows: 1, resumable: true },
  browser: null,
  ...(new URLSearchParams(location.search).has('waitExecution') && {
    devices: [{ ...session.device, ready: false }],
  }),
  ...(new URLSearchParams(location.search).has('waitConnection') && {
    status: 'connecting',
    connectionId: null,
  }),
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
      if (state.historyError) throw new Error('模拟历史读取失败');
      return { items: state.historyItems ?? [] };
    }
    if (command.type === 'terminal.file.read') {
      requests.push(command);
      if (state.fileResult) return await state.fileResult;
      return { mime: 'text/plain', encoding: 'utf8', data: '<script>unsafe()</script>预览内容' };
    }
    return {
      state: running.has(command.sessionId) ? 'running' : 'absent',
      terminalId: running.get(command.sessionId),
    };
  },
  async request(command: any, requestId = crypto.randomUUID()) {
    requests.push(command);
    if (command.type === 'session.configure' && state.configureError)
      throw new Error(state.configureError);
    if (
      command.type === 'terminal.session.create' ||
      command.type === 'terminal.history.continue'
    ) {
      let id = created.get(requestId);
      if (!id) {
        id = `fixture-${created.size + 1}`;
        created.set(requestId, id);
        update({
          sessions: [
            ...state.sessions,
            {
              ...(state.sessions.find((source: any) => source.id === command.sourceSessionId) ??
                session),
              id,
              projectPath:
                command.projectPath ||
                state.sessions.find((source: any) => source.id === command.sourceSessionId)
                  ?.projectPath ||
                session.projectPath,
            },
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
      if (openMode === 'expired' && command.terminalId)
        throw new RequestFailedError('原终端已结束，未新建进程。', 'terminal_inactive');
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
        onSessions: (ids: string[]) => {
          (window as any).terminalTest.occupied = ids;
        },
        register: (handle: any) => {
          if (handle) {
            (window as any).terminalTest.showSession = (id: string) => handle.show(id);
            (window as any).terminalTest.createProject = (project: any) => handle.create(project);
            (window as any).terminalTest.closeAll = () => {
              void handle.closeAll();
            };
          }
        },
      }),
  );
}
root.render(React.createElement(React.StrictMode, null, React.createElement(Fixture)));
Object.assign(window, {
  terminalTest: {
    setProjectName: (name: string) =>
      setPrefs((prefs) => ({
        ...prefs,
        projectNames: { ...prefs.projectNames, [pathKey(session.projectPath)]: name },
      })),
    setLocalProjects: (paths: string[]) => {
      saveShared('projects', paths);
      update({});
    },
    setDefaults: (defaults: any) => setPrefs((prefs) => ({ ...prefs, sessionDefaults: defaults })),
    installTargets: (entries: any[]) => {
      window.open = () => null;
      const targetListeners = new Set<(entries: any[]) => void>();
      (window as any).desktop = {
        ...(window as any).desktop,
        terminalWindow: { focus() {}, setActive() {} },
        onSharedChanged: () => () => {},
        saveShared: async () => {},
        ssh: {
          list: async () => entries,
          onChanged: (listener: (entries: any[]) => void) => {
            targetListeners.add(listener);
            return () => targetListeners.delete(listener);
          },
          connect: async (id: string) => {
            entries.find((target) => target.id === id).status = 'connected';
            targetListeners.forEach((listener) => listener([...entries]));
          },
          disconnect: async () => {},
          directories: async (_id: string, path = '/home/dev') => ({
            path,
            parent: '/',
            directories: [],
          }),
          openProject: async (id: string, path: string, forceNew: boolean) => {
            requests.push({ type: 'ssh.openProject', id, path, forceNew });
            const selected = {
              ...session,
              id: 'first-remote',
              projectPath: path,
              device: {
                id,
                name: entries.find((target) => target.id === id).name,
                platform: 'linux',
                viaSsh: true,
              },
            };
            update({ sessions: [...state.sessions, selected] });
            return { sessionId: selected.id, created: true };
          },
        },
      };
      update({});
    },
    terminalInstances,
    setPredictionRows: (rows: number) => {
      predictiveRows = rows;
      terminalInstances.at(-1)?.resize(100, rows);
    },
    setPrediction: (value: boolean) =>
      setPrefs((prefs) => ({ ...prefs, terminalPredictiveEcho: value })),
    failPrediction: () => {
      PredictiveEchoAddon.prototype.predictChar = () => {
        throw new Error('fixture prediction failure');
      };
    },
    requests,
    controls,
    setCloseMode: (mode: typeof closeMode) => {
      closeMode = mode;
    },
    finishClose: (ok: boolean) => finishClose(ok),
    emit: (message: object) => emit({ sessionId: 'fixture', terminalId: 'pty', ...message }),
    update,
    snapshot: () => state,
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
    holdRenderCallbacks: (value: boolean) => {
      holdRenderCallbacks = value;
    },
    pendingRenderCallbacks: () => renderCallbacks.length,
    flushRenderCallbacks: () => {
      holdRenderCallbacks = false;
      renderCallbacks.splice(0).forEach((callback) => callback());
    },
  },
});
if (
  new URLSearchParams(location.search).has('remoteProjects') ||
  new URLSearchParams(location.search).has('offlineRemote')
) {
  (window as any).terminalTest.installTargets([
    {
      id: '02',
      name: '02',
      projects: ['/work/first'],
      status: new URLSearchParams(location.search).has('offlineRemote')
        ? 'disconnected'
        : 'connected',
      available: true,
      auth: 'password',
      host: 'localhost',
      username: 'dev',
      port: 22,
      error: '',
    },
  ]);
  if (new URLSearchParams(location.search).has('offlineRemote'))
    update({
      sessions: [
        ...state.sessions,
        {
          ...session,
          id: 'offline-source',
          projectPath: '/work/first',
          model: 'preserved-model',
          permissionMode: 'acceptEdits',
          effort: 'high',
          device: { id: '02', name: '02', viaSsh: true },
        },
      ],
    });
}
