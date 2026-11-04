import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { SshTarget } from '../../src/desktop.d.ts';
import '../../src/style.css';

let entries: SshTarget[] = [];
const listeners = new Set<(entries: SshTarget[]) => void>();
const notify = () => listeners.forEach((listener) => listener([...entries]));
const calls: string[] = [];
const sessions = new Map<string, string>();
const waitingDirectories: (() => void)[] = [];
Object.assign(window, {
  sshFixture: {
    calls,
    releaseDirectories() {
      waitingDirectories.splice(0).forEach((resolve) => resolve());
    },
    setEntries(value: SshTarget[]) {
      entries = value;
      notify();
    },
  },
  desktop: {
    platform: 'win32',
    boot: {},
    onSharedChanged: () => () => {},
    saveShared: async () => {},
    ssh: {
      list: async () => entries,
      onChanged: (listener: (value: SshTarget[]) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      chooseIdentity: async () => 'C:\\Users\\dev\\.ssh\\id_ed25519',
      save: async (input: SshTarget) => {
        if (input.id)
          entries = entries.map((entry) =>
            entry.id === input.id ? { ...entry, name: input.name } : entry,
          );
        else
          entries.push({
            ...input,
            id: crypto.randomUUID(),
            port: Number(input.port),
            available: true,
            status: 'disconnected',
            projects: [],
            error: '',
          });
        notify();
        return entries.at(-1)!.id;
      },
      connect: async (id: string) => {
        const entry = entries.find((entry) => entry.id === id)!;
        entry.status = 'connected';
        notify();
        calls.push('connect');
      },
      disconnect: async (id: string) => {
        entries.find((entry) => entry.id === id)!.status = 'disconnected';
        notify();
      },
      remove: async (id: string) => {
        entries = entries.filter((entry) => entry.id !== id);
        notify();
      },
      openProject: async (id: string, path: string, forceNew = false) => {
        if (!path.startsWith('/')) throw new Error('请输入 Linux 项目的绝对路径。');
        calls.push(path);
        const key = `${id}:${path}`;
        const created = forceNew || !sessions.has(key);
        if (created) sessions.set(key, crypto.randomUUID());
        const entry = entries.find((entry) => entry.id === id)!;
        entry.projects = [path, ...entry.projects.filter((value) => value !== path)];
        notify();
        calls.push(created ? 'created' : 'resumed');
        return { sessionId: sessions.get(key)!, created };
      },
      directories: async (_id: string, path = '/home/dev') => {
        calls.push(`browse:${path}`);
        if (path === '/slow')
          await new Promise<void>((resolve) => waitingDirectories.push(resolve));
        if (path === '/denied') throw new Error('Permission denied');
        return {
          path,
          parent: path.slice(0, path.lastIndexOf('/')) || '/',
          directories: path === '/home/dev' ? [{ name: 'project', path: '/home/dev/project' }] : [],
        };
      },
    },
  },
});
// Imports after the desktop facade, as with Electron's preload before the page.
const { default: SettingsPage } = await import('../../src/SettingsPage.tsx');
const { ProxyClient } = await import('../../src/client.ts');
const client = new ProxyClient();
function Fixture() {
  const [section, setSection] =
    useState<import('../../src/SettingsPage.tsx').Section>('connections');
  const [narrow, setNarrow] = useState(innerWidth < 900);
  useEffect(() => {
    const resize = () => setNarrow(innerWidth < 900);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return (
    <div
      className={`shell ${narrow ? 'side-closed' : ''}`}
      style={{ '--sidebar-width': '260px' } as React.CSSProperties}
    >
      <header className="titlebar">CC SPACE</header>
      <div className="rail" />
      <SettingsPage
        client={client}
        native
        sideOpen={!narrow}
        section={section}
        go={setSection}
        account={null}
        form={{
          mode: 'remote',
          url: '',
          token: '',
          fingerprint: '',
          remember: false,
          autoLogin: false,
        }}
        changeForm={() => {}}
        workspaceRoot=""
        chooseWorkspace={() => {}}
        version="test"
        service="test"
        openSshSession={async (_id, created) => {
          calls.push(created ? 'open-new-session' : 'open-existing-session');
        }}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
