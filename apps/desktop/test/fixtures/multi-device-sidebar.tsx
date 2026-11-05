import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { SshTarget } from '../../src/desktop.d.ts';
import Sidebar from '../../src/Sidebar.tsx';
import { setPrefs } from '../../src/prefs.ts';
import '../../src/style.css';
const make = (id: string, title: string, deviceId: string): Session => ({
  id,
  title,
  autoTitle: false,
  projectPath: '/work/app',
  device: {
    id: deviceId,
    name: deviceId,
    ...(deviceId !== 'local' ? { viaSsh: true as const } : {}),
  },
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: '2026-11-05T10:00:00Z',
  updatedAt: '2026-11-05T10:00:00Z',
  activeRun:
    id === 'wait'
      ? {
          id: 'run',
          surface: 'terminal',
          status: 'running',
          activity: 'waiting',
          connectionId: 'c',
        }
      : null,
});
const local = make('local-session', '开发任务', 'local');
const targets = ['01', '02', '03'].map((id) => ({
  id,
  name: id,
  host: 'fixture.invalid',
  port: 22,
  username: 'dev',
  auth: 'key',
  available: true,
  projects: ['/work/app'],
  status: id === '03' ? 'disconnected' : 'connected',
  error: '',
})) as SshTarget[];
const elsewhere = [
  make('wait', '确认部署', '01'),
  make('other', '数据统计', '02'),
  make('old', '其他电脑历史', 'unknown'),
];
const calls: unknown[] = [];
Object.assign(window, { sidebarFixture: { calls, setPrefs }, desktop: undefined });
function Fixture() {
  const [selected, setSelected] = useState('local-session');
  const [entries, setEntries] = useState(targets);
  (window as any).sidebarFixture.setTargets = setEntries;
  return (
    <div className="shell" style={{ gridTemplateColumns: '288px 1fr' }}>
      <Sidebar
        sideOpen
        sessions={[local]}
        elsewhere={elsewhere}
        devices={entries
          .filter((t) => t.status === 'connected')
          .map((t) => ({ id: t.id, name: t.name, platform: 'linux', ready: true }))}
        projects={['/work/app']}
        workspaceRoots={[]}
        selectedId={selected}
        connected
        busy={false}
        refreshing={false}
        sshTargets={entries}
        projectScope="test-service"
        notifications={
          { notices: [], unread: 0, failed: new Set(), markRead() {}, clear() {} } as any
        }
        select={(id) => {
          calls.push(['select', id]);
          setSelected(id);
        }}
        newSession={() => calls.push(['new'])}
        addProject={() => calls.push(['open'])}
        createInProject={(path) => calls.push(['local-create', path])}
        sessionMenu={() => {}}
        projectMenu={() => {}}
        createRemoteProject={(id, path) => calls.push(['remote-create', id, path])}
        remoteProjectMenu={() => {}}
        footer={<span>连接正常</span>}
      />
      <main className="workspace">
        <h1>当前会话：{selected}</h1>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
