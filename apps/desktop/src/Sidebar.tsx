import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Brand from './Brand.tsx';
import SidebarShell, { SearchField } from './SidebarShell.tsx';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Pin,
  Plus,
  Search,
  SquarePen,
} from './icons.tsx';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice } from './client.ts';
import NoticeBell from './NoticeBell.tsx';
import type { Notifications } from './notifications.ts';
import { ago, folderName, isInside, pathKey } from './paths.ts';
import { setPrefs, toggled, usePrefs } from './prefs.ts';
import { useConnectionName } from './shared.ts';
import { IconButton } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';
import Presence from './Presence.tsx';
import { terminalState } from './RunStatus.tsx';
import type { SshTarget } from './desktop.d.ts';
import { projectPreferenceKey } from './developmentProjects.ts';

// What a session is doing, as its row names it in `data-state`: the stylesheet colours the dot and the word by it.
type RowState = 'running' | 'approval' | 'question' | 'background' | 'terminal' | 'failed';
const stateLabels: Record<RowState, string> = {
  running: '运行中',
  approval: '等待审批',
  question: '等待回答',
  background: '后台任务',
  terminal: '原生终端',
  failed: '失败',
};
// A folded list shows the one state that most needs the user.
const stateRank: Record<RowState, number> = {
  failed: 3,
  approval: 2,
  question: 2,
  running: 1,
  background: 0,
  terminal: 0,
};
function rowState(session: Session, failed: ReadonlySet<string>): RowState | undefined {
  const run = session.activeRun;
  if (!run) return failed.has(session.id) ? 'failed' : undefined;
  if (run.surface === 'terminal') return run.activity === 'waiting' ? 'approval' : 'terminal';
  if (run.waiting === 'background') return 'background';
  if (run.status !== 'awaiting_approval') return 'running';
  return run.waiting === 'question' ? 'question' : 'approval';
}
// A run that is alive breathes; one that waits for the user, or has failed, rests.
const breathes = (state: RowState) =>
  state === 'running' || state === 'background' || state === 'terminal';
function activity(session: Session, state: RowState | undefined) {
  if (session.activeRun?.surface === 'terminal') return terminalState(session.activeRun.activity);
  return state ? stateLabels[state] : ago(Date.parse(session.updatedAt));
}

// A list of sessions shows its latest few until it is listed in full.
const PAGE = 5;
// The card with a row's whole title waits this long under the pointer, and shows only for a cut-off title.
const CARD_DELAY = 700;
// The keyboard's way to a row's menu, as Windows has it: Shift+F10 or the menu key.
const asksForMenu = (event: KeyboardEvent) =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
const below = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  return { x: box.left + 8, y: box.bottom + 2 };
};
// The rows ↑ and ↓ move between in the list: sessions, folding rows and "show all".
const listRows = '.session-select, .project-toggle, .project-more';

// Another computer's sessions: by project folder, and those without a project.
type Elsewhere = {
  name: string;
  // Connected, and its commands reach it: its sessions can be worked on from here.
  online: boolean;
  projects: Map<string, { path: string; sessions: Session[] }>;
  plain: Session[];
};

export default function Sidebar({
  sideOpen = true,
  localProjects = true,
  sessions,
  elsewhere,
  devices,
  selectedId,
  projects,
  workspaceRoots,
  connected,
  busy,
  refreshing,
  notifications,
  select,
  newSession,
  addProject,
  createInProject,
  sessionMenu,
  projectMenu,
  schedules = false,
  openSchedules,
  searchHint,
  searchAsked = false,
  searchDone,
  footer,
  sshTargets = [],
  projectScope = '',
  createRemoteProject,
  remoteProjectMenu,
}: {
  sideOpen?: boolean;
  localProjects?: boolean;
  sessions: Session[];
  // Sessions on the user's other computers: listed apart, by computer and under it by project folder, and not
  // part of any project here.
  elsewhere: Session[];
  devices: ConnectedDevice[];
  selectedId: string | undefined;
  projects: string[];
  // Sessions whose directory lies under one of these belong to no project and are listed on their own.
  workspaceRoots: string[];
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  notifications: Notifications;
  select: (sessionId: string) => void;
  newSession: () => void;
  addProject: () => void;
  createInProject: (path: string) => void;
  sessionMenu: (session: Session, position: MenuPosition) => void;
  projectMenu: (path: string, position: MenuPosition) => void;
  // The page of scheduled tasks, reached from a row under "new session" where there is one.
  schedules?: boolean;
  openSchedules?: () => void;
  // The search's keyboard shortcut, shown on the row while it is under the pointer.
  searchHint?: string;
  // Asked from elsewhere (the shortcut, the folded column) to open the search; told back once it is open.
  searchAsked?: boolean;
  searchDone?: () => void;
  footer?: ReactNode;
  sshTargets?: SshTarget[];
  projectScope?: string;
  createRemoteProject?: (deviceId: string, path: string) => void;
  remoteProjectMenu?: (deviceId: string, path: string, position: MenuPosition) => void;
}) {
  const prefs = usePrefs();
  const connectionName = useConnectionName();

  const { failed } = notifications;
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  // The search row turns into the field in place, so nothing below it moves; putting it away clears it.
  const closeSearch = () => {
    setSearching(false);
    setSearch('');
  };
  useEffect(() => {
    if (!searchAsked) return;
    setSearching(true);
    searchDone?.();
    // The column may be sliding in only now, and is not focusable until it shows: focus a frame later. While it
    // comes in (its columns glide, App.tsx) a restyle can still drop the focus to the page; take it back then, for
    // the length of the slide, unless the reader has put it somewhere else.
    // (No cleanup: searchDone above changes searchAsked at once, and that must not cancel these frames.)
    let frames = 0;
    let focused = false;
    let acted = false;
    const act = () => {
      acted = true;
    };
    const stop = () => {
      window.removeEventListener('keydown', act, true);
      window.removeEventListener('pointerdown', act, true);
    };
    window.addEventListener('keydown', act, true);
    window.addEventListener('pointerdown', act, true);
    const hold = () => {
      if (acted) return stop();
      const box = searchBox.current;
      // Concurrent rendering can mount the field after the first animation frame.
      if (box?.isConnected && (!focused || document.activeElement === document.body)) {
        box.focus();
        if (document.activeElement === box) {
          if (!focused) box.select();
          focused = true;
        }
      }
      if (++frames < 24) requestAnimationFrame(hold);
      else stop();
    };
    requestAnimationFrame(() => requestAnimationFrame(hold));
  }, [searchAsked, searchDone]);
  // The lists listed in full rather than their latest few, for this window only.
  const [listed, setListed] = useState<string[]>([]);
  const remoteOrder = useRef(new Map<string, number>());
  const { pinned, plain, groups } = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    const plain: Session[] = [];
    const pinned: Session[] = [];
    const term = search.trim().toLowerCase();
    for (const path of projects) grouped.set(pathKey(path), []);
    for (const session of sessions) {
      const loose = isInside(session.projectPath, workspaceRoots);
      const text = `${session.title} 本机 ${session.device?.name ?? ''} ${loose ? '' : session.projectPath} ${prefs.projectNames[pathKey(session.projectPath)] ?? ''}`;
      if (!text.toLowerCase().includes(term)) continue;
      if (prefs.pinnedSessions.includes(session.id)) {
        pinned.push(session);
        if (loose) continue;
      } else if (loose) {
        plain.push(session);
        continue;
      }
      const key = pathKey(session.projectPath);
      const members = grouped.get(key) ?? [];
      if (!prefs.pinnedSessions.includes(session.id)) members.push(session);
      grouped.set(key, members);
    }
    const remoteGroups = sshTargets
      .filter((target) => target.available)
      .flatMap((target) => {
        const paths = [...target.projects];
        const members = elsewhere.filter((session) => session.device?.id === target.id);
        for (const session of members)
          if (!paths.some((path) => pathKey(path) === pathKey(session.projectPath)))
            paths.push(session.projectPath);
        return paths
          .map((path) => {
            const key = projectPreferenceKey(projectScope, target.id, path);
            const matching = members.filter(
              (session) => pathKey(session.projectPath) === pathKey(path),
            );
            for (const session of matching)
              if (
                prefs.pinnedSessions.includes(session.id) &&
                `${session.title} ${target.name} ${path} ${prefs.projectNames[key] ?? ''}`
                  .toLowerCase()
                  .includes(term)
              )
                pinned.push(session);
            return {
              key,
              path,
              deviceId: target.id,
              deviceName: target.name,
              online: devices.some((device) => device.id === target.id && device.ready),
              sessions: matching.filter(
                (session) =>
                  !prefs.pinnedSessions.includes(session.id) &&
                  `${session.title} ${target.name} ${path} ${prefs.projectNames[key] ?? ''}`
                    .toLowerCase()
                    .includes(term),
              ),
            };
          })
          .filter(
            (group) =>
              group.sessions.length ||
              !term ||
              `${target.name} ${group.path} ${prefs.projectNames[group.key] ?? ''}`
                .toLowerCase()
                .includes(term),
          );
      });
    for (const group of remoteGroups)
      if (!remoteOrder.current.has(group.key))
        remoteOrder.current.set(group.key, remoteOrder.current.size);
    remoteGroups.sort((a, b) => remoteOrder.current.get(a.key)! - remoteOrder.current.get(b.key)!);
    const first = (key: string) => (prefs.pinnedProjects.includes(key) ? 0 : 1);
    return {
      pinned,
      plain,
      groups: [...grouped.entries()]
        .map(([key, members]) => ({
          key,
          path:
            projects.find((path) => pathKey(path) === key) ??
            sessions.find((session) => pathKey(session.projectPath) === key)!.projectPath,
          sessions: members,
          deviceId: undefined as string | undefined,
          deviceName: '',
          online: connected,
        }))
        .filter(
          (group) =>
            group.sessions.length ||
            !term ||
            `${group.path} ${prefs.projectNames[group.key] ?? ''} 本机`
              .toLowerCase()
              .includes(term),
        )
        .concat(remoteGroups)
        // Array.sort is stable: pinned projects come first, the rest keep their order.
        .sort((a, b) => first(a.key) - first(b.key)),
    };
  }, [
    sessions,
    elsewhere,
    devices,
    sshTargets,
    projectScope,
    connected,
    search,
    projects,
    workspaceRoots,
    prefs.pinnedSessions,
    prefs.pinnedProjects,
    prefs.projectNames,
  ]);

  const others = useMemo(() => {
    const term = search.trim().toLowerCase();
    const groups = new Map<string, Elsewhere>();
    for (const session of elsewhere) {
      if (sshTargets.some((target) => target.available && target.id === session.device?.id))
        continue;
      if (
        !`${session.title} ${session.projectPath} ${session.device?.name ?? ''}`
          .toLowerCase()
          .includes(term)
      )
        continue;
      // A session from before computers were told apart, whose folder is not on this one.
      const device = session.device ?? { id: '', name: '未知设备' };
      const entry: Elsewhere = groups.get(device.id) ?? {
        name: device.name,
        online: devices.some((item) => item.id === device.id && item.ready),
        projects: new Map(),
        plain: [],
      };
      groups.set(device.id, entry);
      // The server currently creates only sessions without a project; its workspace paths are internal.
      // Which folders hold another computer's sessions without a project is not known here; the ones this
      // program makes are told by their shape, a day and under it a time.
      if (
        devices.some((item) => item.id === device.id && item.server) ||
        /[\\/]\d{4}-\d{2}-\d{2}[\\/]\d{6}(-\d+)?[\\/]?$/.test(session.projectPath)
      ) {
        entry.plain.push(session);
        continue;
      }
      const key = pathKey(session.projectPath);
      const project = entry.projects.get(key) ?? { path: session.projectPath, sessions: [] };
      project.sessions.push(session);
      entry.projects.set(key, project);
    }
    return [...groups.entries()];
  }, [elsewhere, devices, search, sshTargets]);
  const othersCount = others.reduce(
    (count, [, device]) =>
      count +
      device.plain.length +
      [...device.projects.values()].reduce((sum, project) => sum + project.sessions.length, 0),
    0,
  );
  // A search shows what it found, folded or not.
  const othersOpen = prefs.elsewhereOpen || !!search.trim();

  // A card beside the row tells what the short line cannot: the whole title, the project and the time. It waits
  // a moment and shows only when the title is cut off.
  const [card, setCard] = useState<{ session: Session; top: number; left: number } | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aside = useRef<HTMLElement>(null);
  const leave = () => {
    clearTimeout(hover.current);
    setCard(null);
  };
  useEffect(() => leave, []);

  // What a folded list most needs the user for: the state of the one session that ranks highest.
  const topState = (members: Session[]) =>
    members
      .map((session) => rowState(session, failed))
      .reduce<RowState | undefined>(
        (top, next) => (next && (!top || stateRank[next] > stateRank[top]) ? next : top),
        undefined,
      );
  // A project's row: the folder, which turns into the folding arrow under the pointer, and its name. Folded, it
  // tells how many sessions the project holds and whether one of them needs the user.
  function foldToggle({
    open,
    label,
    name,
    members,
    toggle,
    onKeyDown,
  }: {
    open: boolean;
    label: string;
    name: string;
    members: Session[];
    toggle: () => void;
    onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  }) {
    const state = open ? undefined : topState(members);
    return (
      <button
        type="button"
        className="project-toggle"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}`}
        data-state={state}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span className="fold-icon" aria-hidden="true">
          {open ? <FolderOpen className="fold-folder" /> : <Folder className="fold-folder" />}
          {open ? <ChevronDown className="fold-caret" /> : <ChevronRight className="fold-caret" />}
        </span>
        <span>{name}</span>
        {state && <i className={`running-dot${breathes(state) ? ' breathing' : ''}`} />}
        {!open && members.length > 0 && <small>{members.length}</small>}
      </button>
    );
  }
  // A heading that folds its group (the other computers, and each of them): the words, and the folding arrow
  // beside them under the pointer, like Claude's. Folded, it carries the same count and dot as a project.
  function foldHeading({
    open,
    label,
    name,
    members,
    toggle,
  }: {
    open: boolean;
    label: string;
    name: string;
    members: Session[];
    toggle: () => void;
  }) {
    const state = open ? undefined : topState(members);
    return (
      <button
        type="button"
        className="project-toggle heading-toggle"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}`}
        data-state={state}
        onClick={toggle}
      >
        <span>{name}</span>
        {open ? <ChevronDown className="fold-caret" /> : <ChevronRight className="fold-caret" />}
        {state && <i className={`running-dot${breathes(state) ? ' breathing' : ''}`} />}
        {!open && members.length > 0 && <small>{members.length}</small>}
      </button>
    );
  }
  const foldElsewhere = (key: string) => () =>
    setPrefs((value) => ({ ...value, collapsedElsewhere: toggled(value.collapsedElsewhere, key) }));

  // A list shows its latest few sessions, and also the open one and those at work or failed wherever they are,
  // until it is listed in full. A search lists all it found. `loose` lists stand at the column's edge rather
  // than under a project, and their "show all" lines up with them.
  function renderSessions(key: string, members: Session[], loose = false) {
    const kept = members.filter(
      (session, index) =>
        index < PAGE || session.id === selectedId || session.activeRun || failed.has(session.id),
    );
    if (search.trim() || kept.length === members.length) return members.map(renderSession);
    const full = listed.includes(key);
    return (
      <>
        {(full ? members : kept).map(renderSession)}
        <button
          type="button"
          className={`project-more${loose ? ' loose' : ''}`}
          aria-expanded={full}
          onClick={() => setListed((value) => toggled(value, key))}
        >
          {full ? '收起' : `显示全部 (${members.length})`}
        </button>
      </>
    );
  }

  function renderSession(session: Session) {
    const state = rowState(session, failed);
    return (
      <div
        className={`session-row ${selectedId === session.id ? 'selected' : ''}`}
        data-state={state}
        key={session.id}
        onContextMenu={(event) => {
          event.preventDefault();
          leave();
          sessionMenu(session, { x: event.clientX, y: event.clientY });
        }}
        onMouseEnter={(event) => {
          const row = event.currentTarget;
          clearTimeout(hover.current);
          hover.current = setTimeout(() => {
            const title = row.querySelector('strong');
            if (!title || title.scrollWidth <= title.clientWidth) return;
            setCard({
              session,
              top: row.getBoundingClientRect().top,
              left: aside.current!.getBoundingClientRect().right + 8,
            });
          }, CARD_DELAY);
        }}
        onMouseLeave={leave}
      >
        <button
          type="button"
          className="session-select"
          onClick={() => select(session.id)}
          onKeyDown={(event) => {
            if (!asksForMenu(event)) return;
            event.preventDefault();
            leave();
            sessionMenu(session, below(event.currentTarget));
          }}
        >
          <strong>{session.title}</strong>
          {state && <span className={`running-dot${breathes(state) ? ' breathing' : ''}`} />}
          <small>{activity(session, state)}</small>
        </button>
        <IconButton
          title="会话操作"
          className="row-action session-more"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            leave();
            sessionMenu(session, { x: box.left, y: box.bottom + 4 });
          }}
        >
          <Ellipsis />
        </IconButton>
      </div>
    );
  }
  // ↑ and ↓ move between the list's rows, Home and End to its ends; Enter opens one, as any button.
  const moveInList = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.matches(listRows)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(listRows)];
    const at = rows.indexOf(target);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    rows[next]?.focus();
    rows[next]?.scrollIntoView({ block: 'nearest' });
  };
  return (
    <SidebarShell
      open={sideOpen}
      asideRef={aside}
      header={
        <>
          <Brand connectionName={connectionName} />
          <NoticeBell notifications={notifications} open={select} />
        </>
      }
      footer={footer}
    >
      <button
        type="button"
        className="side-action new-session"
        disabled={!connected || busy || refreshing}
        title="新建会话"
        onClick={newSession}
      >
        <SquarePen />
        新建会话
      </button>
      <div className="side-nav">
        {searching ? (
          <SearchField
            label="搜索会话"
            inputRef={searchBox}
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
            onBlur={() => {
              if (!search) closeSearch();
            }}
            placeholder="搜索设备、项目或会话"
            close={closeSearch}
          />
        ) : (
          <button type="button" className="side-action nav-row" onClick={() => setSearching(true)}>
            <Search />
            <span>搜索</span>
            {searchHint && <kbd aria-hidden="true">{searchHint}</kbd>}
          </button>
        )}
        {schedules && (
          <button type="button" className="side-action nav-row" onClick={openSchedules}>
            <CalendarClock />
            <span>定时任务</span>
          </button>
        )}
      </div>
      <nav className="session-list" aria-label="会话列表" onKeyDown={moveInList}>
        {pinned.length > 0 && <div className="list-heading">置顶</div>}
        {pinned.map(renderSession)}
        {localProjects && (
          <div className="list-heading">
            项目
            <IconButton title="打开项目" disabled={!connected || busy} onClick={addProject}>
              <Plus />
            </IconButton>
          </div>
        )}
        {groups.map(({ key, path, sessions: members, deviceId, deviceName, online }) => {
          // A search shows what it found, folded or not.
          const legacyKey = deviceId ? `${deviceId}\n${pathKey(path)}` : '';
          const collapsed =
            !search.trim() &&
            (prefs.collapsedProjects.includes(key) ||
              (!!deviceId &&
                (prefs.collapsedElsewhere.includes(legacyKey) ||
                  prefs.collapsedElsewhere.includes(deviceId))));
          const name = prefs.projectNames[key] || folderName(path);
          const location = deviceId ? `${deviceName} · ${path}` : path;
          const openMenu = (position: MenuPosition) =>
            deviceId ? remoteProjectMenu?.(deviceId, path, position) : projectMenu(path, position);
          return (
            <section className="project-group" key={key}>
              <h2
                title={location}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu({ x: event.clientX, y: event.clientY });
                }}
              >
                {foldToggle({
                  open: !collapsed,
                  label: `项目 · ${name}${deviceName ? ` · ${deviceName}` : ''}`,
                  name,
                  members,
                  toggle: () =>
                    setPrefs((value) => {
                      const folded = new Set(value.collapsedProjects);
                      if (deviceId && value.collapsedElsewhere.includes(deviceId))
                        for (const group of groups)
                          if (group.deviceId === deviceId) folded.add(group.key);
                      if (collapsed) folded.delete(key);
                      else folded.add(key);
                      return {
                        ...value,
                        collapsedProjects: [...folded],
                        collapsedElsewhere: deviceId
                          ? value.collapsedElsewhere.filter(
                              (item) => item !== legacyKey && item !== deviceId,
                            )
                          : value.collapsedElsewhere,
                      };
                    }),
                  onKeyDown: (event) => {
                    if (!asksForMenu(event)) return;
                    event.preventDefault();
                    openMenu(below(event.currentTarget));
                  },
                })}
                {deviceName && (
                  <small
                    className="project-device"
                    title={`${deviceName}${online ? '' : ' · 离线'}`}
                  >
                    {deviceName}
                    {!online && ' · 离线'}
                  </small>
                )}
                {prefs.pinnedProjects.includes(key) && <Pin className="pin-mark" />}
                <IconButton
                  title={`项目操作 · ${location}`}
                  className="row-action"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    openMenu({ x: box.left, y: box.bottom + 4 });
                  }}
                >
                  <Ellipsis />
                </IconButton>
                <IconButton
                  title={`新建会话 · ${location}`}
                  className="row-action"
                  disabled={!connected || busy || refreshing}
                  onClick={() =>
                    deviceId ? createRemoteProject?.(deviceId, path) : createInProject(path)
                  }
                >
                  <Plus />
                </IconButton>
              </h2>
              {/* An empty project shows no placeholder: its row offers "+" under the pointer. */}
              {!collapsed && renderSessions(key, members)}
            </section>
          );
        })}
        {localProjects && groups.length === 0 && (
          <p className="project-empty">{search ? '没有匹配的项目' : '还没有项目'}</p>
        )}
        {plain.length > 0 && <div className="list-heading">最近</div>}
        {plain.map(renderSession)}
        {othersCount > 0 && (
          <section className="elsewhere-group">
            <div
              className="list-heading"
              title="这些会话的项目目录在你的其他电脑上；那台电脑在线时可以直接在这里操作，也可以接到这台电脑上继续"
            >
              {foldHeading({
                open: othersOpen,
                label: '其他设备的会话',
                name: '其他设备',
                members: others.flatMap(([, device]) => [
                  ...device.plain,
                  ...[...device.projects.values()].flatMap((project) => project.sessions),
                ]),
                toggle: () =>
                  setPrefs((value) => ({ ...value, elsewhereOpen: !value.elsewhereOpen })),
              })}
            </div>
            {othersOpen &&
              others.map(([id, device]) => {
                // Each computer folds under its name, and each folder on it as a project does; a search opens
                // them. Its sessions without a project are listed under its name, after its projects.
                const open = (key: string) =>
                  !!search.trim() || !prefs.collapsedElsewhere.includes(key);
                const projects = [...device.projects.entries()];
                return (
                  <Fragment key={id}>
                    <div className="device-heading">
                      {foldHeading({
                        open: open(id),
                        label: `设备 · ${device.name}`,
                        name: device.name,
                        members: [
                          ...projects.flatMap(([, project]) => project.sessions),
                          ...device.plain,
                        ],
                        toggle: foldElsewhere(id),
                      })}
                      <span className={`device-state${device.online ? ' online' : ''}`}>
                        {device.online ? '在线' : '离线'}
                      </span>
                    </div>
                    {open(id) &&
                      projects.map(([path, project]) => {
                        const key = `${id}\n${path}`;
                        const name = folderName(project.path);
                        return (
                          <section className="project-group elsewhere-project" key={path}>
                            <h2 title={project.path}>
                              {foldToggle({
                                open: open(key),
                                label: `项目 · ${device.name} · ${name}`,
                                name,
                                members: project.sessions,
                                toggle: foldElsewhere(key),
                              })}
                            </h2>
                            {open(key) && renderSessions(key, project.sessions)}
                          </section>
                        );
                      })}
                    {open(id) && renderSessions(`${id}\n`, device.plain, true)}
                  </Fragment>
                );
              })}
          </section>
        )}
        {search &&
          groups.length === 0 &&
          plain.length === 0 &&
          pinned.length === 0 &&
          othersCount === 0 && <p className="list-empty">没有匹配会话</p>}
      </nav>
      <Presence>
        {card && (
          <div className="session-card" role="tooltip" style={{ top: card.top, left: card.left }}>
            <strong>{card.session.title}</strong>
            <span>
              <Folder />
              {isInside(card.session.projectPath, workspaceRoots)
                ? '普通会话'
                : card.session.projectPath}
            </span>
            <small>
              {activity(card.session, rowState(card.session, failed))} ·{' '}
              {new Date(card.session.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            </small>
          </div>
        )}
      </Presence>
    </SidebarShell>
  );
}
