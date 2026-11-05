import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SshTarget } from '../../src/desktop.d.ts';
import '../../src/style.css';
const target: SshTarget = {
  id: 'target-01',
  name: '01',
  host: 'localhost',
  port: 22,
  username: 'dev',
  auth: 'password',
  projects: [],
  available: true,
  status: 'disconnected',
  error: '',
};
let entries = [target];
const listeners = new Set<(entries: SshTarget[]) => void>();
const calls: unknown[] = [];
const serviceListeners = new Set<() => void>();
const client = {
  state: { connectionId: 'fixture' },
  subscribe: (listener: () => void) => {
    serviceListeners.add(listener);
    return () => serviceListeners.delete(listener);
  },
};
let callbackFails = new URLSearchParams(location.search).has('callback-fails');
const pending: (() => void)[] = [];
const notify = () => listeners.forEach((listener) => listener([...entries]));
Object.assign(window, {
  projectDialogFixture: {
    calls,
    changeService() {
      client.state.connectionId = 'different';
      serviceListeners.forEach((listener) => listener());
    },
    release() {
      pending.splice(0).forEach((fn) => fn());
    },
    setConnected() {
      target.status = 'connected';
      notify();
    },
  },
  desktop: {
    platform: 'win32',
    boot: {},
    onSharedChanged: () => () => {},
    saveShared: async () => {},
    chooseProject: async () => 'D:\\work\\local',
    ssh: {
      list: async () => {
        const snapshot = entries.map((entry) => ({ ...entry }));
        if (new URLSearchParams(location.search).has('stale-list'))
          await new Promise<void>((resolve) => pending.push(resolve));
        return snapshot;
      },
      onChanged: (listener: (entries: SshTarget[]) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      connect: async (id: string, secret: string) => {
        calls.push(['connect', id, secret]);
        if (secret === 'wait') await new Promise<void>((resolve) => pending.push(resolve));
        entries.find((entry) => entry.id === id)!.status = 'connected';
        notify();
      },
      disconnect: async (id: string) => {
        calls.push(['disconnect', id]);
        target.status = 'disconnected';
        notify();
      },
      save: async (input: object) => {
        calls.push(['save', input]);
        entries.push({ ...target, ...input, id: 'target-02', name: '02', status: 'disconnected' });
        notify();
        return 'target-02';
      },
      chooseIdentity: async () => 'C:\\Users\\dev\\.ssh\\id_ed25519',
      directories: async (id: string, path = '/home/dev') => {
        calls.push(['directories', id, path]);
        if (path === '/slow') await new Promise<void>((resolve) => pending.push(resolve));
        if (path === '/denied') throw new Error('Permission denied');
        return {
          path,
          parent: '/',
          directories: path === '/home/dev' ? [{ name: 'app', path: '/home/dev/app' }] : [],
        };
      },
      openProject: async (id: string, path: string, forceNew: boolean, creationId: string) => {
        calls.push(['open', id, path, forceNew]);
        calls.push(['creation', creationId]);
        if (
          path === '/retry' &&
          calls.filter((row) => Array.isArray(row) && row[0] === 'open' && row[2] === '/retry')
            .length === 1
        )
          throw new Error('response lost');
        if (path === '/fail') throw new Error('打开失败');
        return { sessionId: 'new-session', created: true };
      },
    },
  },
});
const { default: OpenProjectDialog } = await import('../../src/OpenProjectDialog.tsx');
function Fixture() {
  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<{ deviceId?: string; path?: string }>();
  return (
    <>
      <button
        onClick={() => {
          setInitial(undefined);
          setOpen(true);
        }}
      >
        打开
      </button>
      <button
        onClick={() => {
          setInitial({ deviceId: 'target-01' });
          setOpen(true);
        }}
      >
        打开01
      </button>
      {open && (
        <OpenProjectDialog
          client={client as never}
          initial={initial}
          forceNew
          onLocal={async (path) => {
            calls.push(['local', path]);
          }}
          onRemote={async (id, created) => {
            calls.push(['remote', id, created]);
            if (callbackFails) {
              callbackFails = false;
              throw new Error('initialization failed');
            }
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
