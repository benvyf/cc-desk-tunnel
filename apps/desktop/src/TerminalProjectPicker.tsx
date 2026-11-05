import { useRef, useState } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { SshTarget } from './desktop.d.ts';
import { projectIdentity, projectPreferenceKey, terminalProjects } from './developmentProjects.ts';
import { folderName } from './paths.ts';
import { Button, Modal } from './ui.tsx';
import { usePrefs } from './prefs.ts';
import { effortNames } from './modelDefaults.ts';

const permissionNames = {
  auto: '自动审批',
  default: '手动审批',
  acceptEdits: '接受编辑',
  plan: '计划模式',
  bypassPermissions: '绕过权限',
};

export default function TerminalProjectPicker({
  sessions,
  targets,
  localPaths,
  localDeviceId = '',
  scope,
  active,
  onSelect,
  onOpen,
  onClose,
}: {
  sessions: Session[];
  targets: SshTarget[];
  localPaths: string[];
  localDeviceId?: string;
  scope: string;
  active?: Session;
  onSelect: (source: Session) => void;
  onOpen: (initial?: { deviceId?: string; path?: string }) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const prefs = usePrefs();
  const name = (deviceId: string, path: string) =>
    prefs.projectNames[
      projectPreferenceKey(
        scope,
        deviceId && deviceId !== localDeviceId ? deviceId : undefined,
        path,
      )
    ] || folderName(path);
  const projects = terminalProjects(sessions, scope, active).map((project) => ({
    ...project,
    name: name(project.deviceId, project.path),
  }));
  const saved = targets
    .filter((target) => target.available)
    .flatMap((target) =>
      target.projects.map((path) => ({
        key: projectIdentity(scope, target.id, path),
        path,
        name: name(target.id, path),
        deviceId: target.id,
        deviceName: target.name,
        source: undefined as Session | undefined,
      })),
    );
  const local = localPaths.map((path) => ({
    key: projectIdentity(scope, localDeviceId, path),
    path,
    name: name('', path),
    deviceId: '',
    deviceName: '本机',
    source: undefined as Session | undefined,
  }));
  const known = new Set(projects.map((project) => project.key));
  const extras = [...saved, ...local].filter((project) => !known.has(project.key));
  const term = query.trim().toLocaleLowerCase();
  const matches = (project: { name: string; deviceName: string; path: string }) =>
    `${project.name} ${project.deviceName} ${project.path}`.toLocaleLowerCase().includes(term);
  const recent = projects.slice(0, 5).filter(matches);
  const remaining = [...projects.slice(5), ...extras].filter(matches);
  const groups = new Map<string, typeof remaining>();
  for (const project of remaining) {
    const members = groups.get(project.deviceId) ?? [];
    members.push(project);
    groups.set(project.deviceId, members);
  }
  const row = (project: (typeof projects)[number] | (typeof extras)[number]) => (
    <button
      type="button"
      className="terminal-project-choice"
      key={project.key}
      aria-label={`${project.name} · ${project.deviceName}`}
      title={`${project.deviceName} · ${project.path}`}
      onClick={() => {
        if (project.source) onSelect(project.source);
        else onOpen({ deviceId: project.deviceId || undefined, path: project.path });
      }}
    >
      <span>
        {project.name}
        <small>{project.deviceName}</small>
      </span>
      <span className="terminal-project-meta">{project.path}</span>
      {project.source && (
        <small className="terminal-project-meta">
          {project.source.model ?? '默认模型'} · {permissionNames[project.source.permissionMode]}
          {project.source.effort ? ` · ${effortNames[project.source.effort]}` : ''}
        </small>
      )}
    </button>
  );
  return (
    <Modal title="新建终端" onClose={onClose} initialFocus="[data-project-search]">
      <div
        className="terminal-project-picker"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || composing.current) {
            if (event.key === 'Escape' || event.key === 'Enter') event.preventDefault();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const rows = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '.terminal-project-choice',
              ),
            ];
            const current = rows.indexOf(event.target as HTMLButtonElement);
            const next =
              current < 0
                ? event.key === 'ArrowDown'
                  ? 0
                  : rows.length - 1
                : Math.max(
                    0,
                    Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)),
                  );
            if (rows[next]) {
              event.preventDefault();
              rows[next].focus();
              rows[next].scrollIntoView({ block: 'nearest' });
            }
          }
          if (
            event.key === 'Enter' &&
            event.target === input.current &&
            !event.nativeEvent.isComposing &&
            !composing.current
          ) {
            event.preventDefault();
            const first = [...recent, ...remaining][0];
            if (first) {
              if (first.source) onSelect(first.source);
              else onOpen({ deviceId: first.deviceId || undefined, path: first.path });
            }
          }
        }}
      >
        <label className="terminal-project-search">
          设备或项目
          <input
            ref={input}
            data-project-search
            aria-label="搜索设备或项目"
            value={query}
            placeholder="搜索项目、设备或目录"
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {recent.length > 0 && (
          <section className="terminal-project-group" aria-label="最近项目">
            <h3>当前与最近项目</h3>
            {recent.map(row)}
          </section>
        )}
        {[...groups].map(([id, members]) => (
          <section
            key={id}
            className="terminal-project-group"
            aria-label={`${members[0].deviceName} 的项目`}
          >
            <h3>{members[0].deviceName}</h3>
            {members.map(row)}
          </section>
        ))}
        {!recent.length && !remaining.length && <p role="status">没有匹配的项目</p>}
        <p className="muted">同目录并行修改可能冲突；需要隔离时选择已有 worktree。</p>
        <div className="dialog-actions">
          <Button onClick={onClose}>取消</Button>
          <Button onClick={() => onOpen()}>打开其他项目…</Button>
        </div>
      </div>
    </Modal>
  );
}
