import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Brand from './Brand.tsx';
import SidebarShell, { SearchField } from './SidebarShell.tsx';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import {
  Activity,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Laptop,
  Pin,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
  Check,
  Trash2,
  FolderInput as Archive,
  X,
} from './icons.tsx';
import { pruned, ranged, toggled as chosenToggled } from './sessionSelection.ts';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice } from './client.ts';
import type { Notifications } from './notifications.ts';
import { activityGroups, nextDay } from './activityView.ts';
import { usePreview } from './activityPreviews.ts';
import { ago, folderName, isInside, pathKey } from './paths.ts';
import { setPrefs, toggled, usePrefs } from './prefs.ts';
import { useConnectionName } from './shared.ts';
import { IconButton } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';
import Presence from './Presence.tsx';
import { terminalState } from './RunStatus.tsx';
import type { SshTarget } from './desktop.d.ts';
import { projectPreferenceKey } from './developmentProjects.ts';
import { forkRows, withAncestors } from './sessionTree.ts';
import type { ForkRow } from './sessionTree.ts';

// What a session is doing, as its row names it in `data-state`: the stylesheet colours the dot and the word by it.
type RowState = 'running' | 'approval' | 'question' | 'background' | 'terminal' | 'failed' | 'done';
const stateLabels: Record<RowState, string> = {
  running: '运行中',
  approval: '等待审批',
  question: '等待回答',
  background: '后台任务',
  terminal: '原生终端',
  failed: '失败',
  done: '已完成',
};
// A folded list shows the one state that most needs the user. A finished run waits to be read, which
// matters more than one still going.
const stateRank: Record<RowState, number> = {
  failed: 4,
  approval: 3,
  question: 3,
  done: 2,
  running: 1,
  background: 0,
  terminal: 0,
};
type Outcomes = Pick<Notifications, 'failed' | 'done'>;
function rowState(session: Session, { failed, done }: Outcomes): RowState | undefined {
  const run = session.activeRun;
  if (!run) return failed.has(session.id) ? 'failed' : done.has(session.id) ? 'done' : undefined;
  if (run.surface === 'terminal') return run.activity === 'waiting' ? 'approval' : 'terminal';
  if (run.waiting === 'background') return 'background';
  if (run.status !== 'awaiting_approval') return 'running';
  return run.waiting === 'question' ? 'question' : 'approval';
}
// A run that is alive breathes; one that waits for the user, or has failed, rests.
const breathes = (state: RowState) =>
  state === 'running' || state === 'background' || state === 'terminal';
// How long a finished session's light breathes before it stays lit (style.css: three breaths of 2.4s).
const doneBreathing = 7200;
// A finished session's light, as far into its breathing as the time since it finished: a folded project opened, or
// a list drawn anew, does not start it over. The delay is taken once, when the light is drawn: set again on a
// later drawing, the browser would count it on top of the time the breathing has already run. A later finish
// draws a new light, which breathes from the start.
function DoneDot({ at, className = 'done-dot' }: { at: number | undefined; className?: string }) {
  const delay = useMemo(
    () => Math.min(at === undefined ? doneBreathing : Math.max(0, Date.now() - at), doneBreathing),
    [at],
  );
  return (
    <i
      key={at}
      className={className}
      aria-hidden="true"
      style={{ animationDelay: `-${delay}ms` }}
    />
  );
}
// A session whose turn finished out of sight stays lit while only its background tasks go on.
const lit = (session: Session, done: ReadonlyMap<string, number>) =>
  done.has(session.id) && (!session.activeRun || session.activeRun.waiting === 'background');
function activity(session: Session, state: RowState | undefined) {
  if (session.activeRun?.surface === 'terminal') return terminalState(session.activeRun.activity);
  return state ? stateLabels[state] : ago(Date.parse(session.updatedAt));
}
// How much a session needs the user, for the activity view's 优先事项: waiting for an answer, failed, or
// finished out of sight and not yet read. None for the others.
function urgency(session: Session, outcomes: Outcomes) {
  const state = rowState(session, outcomes);
  if (state === 'approval' || state === 'question' || state === 'failed') return stateRank[state];
  return lit(session, outcomes.done) ? stateRank.done : undefined;
}
// The activity view's second line: the state when there is one, then the opening of the latest reply this
// computer has seen (activityPreviews.ts), or the time the session last changed.
function ActivityLine({ session, state }: { session: Session; state: RowState | undefined }) {
  const preview = usePreview(session.id);
  const word = state || session.activeRun?.surface === 'terminal' ? activity(session, state) : '';
  return (
    <span className="activity-preview">
      {word && <b className="activity-state">{word}</b>}
      {word && preview && ' · '}
      {preview ?? (word ? '' : clock.format(Date.parse(session.updatedAt)))}
    </span>
  );
}
// The time of day a session changed: its day is the heading it is listed under.
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
// The activity view lists this many of its days' sessions at first, and as many more at each "show more".
const ACTIVITY_PAGE = 50;
// A folder this program made for a session without a project: a day and under it a time. Not a project's name.
const madeFolder = /[\\/]\d{4}-\d{2}-\d{2}[\\/]\d{6}(-\d+)?[\\/]?$/;

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
  archived = [],
  chosen = new Set(),
  setChosen = () => {},
  choosable = () => false,
  canArchive = false,
  archiveChosen,
  deleteChosen,
  batchProgress,
  activityHint,
  openNotifySettings,
}: {
  // The activity view's keyboard shortcut, told on its button.
  activityHint?: string;
  // The notification settings, from the 优先事项 heading.
  openNotifySettings?: () => void;
  // Sessions put away: listed apart, at the foot, and found by a search.
  archived?: Session[];
  // The sessions chosen to act on together (sessionSelection.ts); choosing is on while any is.
  chosen?: ReadonlySet<string>;
  setChosen?: (next: ReadonlySet<string>) => void;
  // Not at work, nor held by its terminal: may be chosen.
  choosable?: (session: Session) => boolean;
  canArchive?: boolean;
  archiveChosen?: (sessions: Session[], archived: boolean) => void;
  deleteChosen?: (sessions: Session[]) => void;
  batchProgress?: string | null;
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

  const { failed, done } = notifications;
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
    for (const path of projects)
      if (!prefs.hiddenProjects.includes(pathKey(path))) grouped.set(pathKey(path), []);
    for (const session of sessions) {
      const workspace = isInside(session.projectPath, workspaceRoots);
      const loose = workspace || prefs.hiddenProjects.includes(pathKey(session.projectPath));
      const text = `${session.title} 本机 ${session.device?.name ?? ''} ${workspace ? '' : session.projectPath} ${prefs.projectNames[pathKey(session.projectPath)] ?? ''}`;
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
        for (const session of members) {
          const key = projectPreferenceKey(projectScope, target.id, session.projectPath);
          if (
            prefs.hiddenProjects.includes(key) &&
            `${session.title} ${target.name} ${session.projectPath} ${prefs.projectNames[key] ?? ''}`
              .toLowerCase()
              .includes(term)
          ) {
            if (prefs.pinnedSessions.includes(session.id)) pinned.push(session);
            else plain.push(session);
          }
        }
        return paths
          .filter(
            (path) =>
              !prefs.hiddenProjects.includes(projectPreferenceKey(projectScope, target.id, path)),
          )
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
      plain: plain.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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
    prefs.hiddenProjects,
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
        madeFolder.test(session.projectPath)
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

  // When the latest of a folded list's finished sessions finished, for its light.
  const latestDone = (members: Session[]) =>
    members.reduce<number | undefined>((latest, session) => {
      const at = done.get(session.id);
      return at !== undefined && (latest === undefined || at > latest) ? at : latest;
    }, undefined);
  // What a folded list most needs the user for: the state of the one session that ranks highest.
  const topState = (members: Session[]) =>
    members
      .map((session) => {
        const state = rowState(session, notifications);
        return lit(session, done) && (!state || stateRank.done > stateRank[state]) ? 'done' : state;
      })
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
          {/* An empty project has nothing to show open: its folder stays closed. */}
          {open && members.length > 0 ? (
            <FolderOpen className="fold-folder" />
          ) : (
            <Folder className="fold-folder" />
          )}
          {open ? <ChevronDown className="fold-caret" /> : <ChevronRight className="fold-caret" />}
        </span>
        <span>{name}</span>
        {state === 'done' ? (
          <DoneDot at={latestDone(members)} className="running-dot done-dot" />
        ) : (
          state && <i className={`running-dot${breathes(state) ? ' breathing' : ''}`} />
        )}
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
    icon,
  }: {
    open: boolean;
    label: string;
    name: string;
    members: Session[];
    toggle: () => void;
    // A computer's heading leads with its icon, which turns into the folding arrow as a project's folder does.
    icon?: ReactNode;
  }) {
    const state = open ? undefined : topState(members);
    const caret = open ? (
      <ChevronDown className="fold-caret" />
    ) : (
      <ChevronRight className="fold-caret" />
    );
    return (
      <button
        type="button"
        className="project-toggle heading-toggle"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}`}
        data-state={state}
        onClick={toggle}
      >
        {icon && (
          <span className="fold-icon" aria-hidden="true">
            {icon}
            {caret}
          </span>
        )}
        <span>{name}</span>
        {!icon && caret}
        {state === 'done' ? (
          <DoneDot at={latestDone(members)} className="running-dot done-dot" />
        ) : (
          state && <i className={`running-dot${breathes(state) ? ' breathing' : ''}`} />
        )}
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
        index < PAGE ||
        session.id === selectedId ||
        session.activeRun ||
        failed.has(session.id) ||
        done.has(session.id),
    );
    // A shortened list keeps the sources of the forks it keeps; if that is all of them, nothing is left to show.
    const shortened = withAncestors(kept, members);
    if (search.trim() || shortened.length === members.length) return renderTree(members);
    const full = listed.includes(key);
    return (
      <>
        {renderTree(full ? members : shortened)}
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

  // Forks under what they were forked from (sessionTree.ts).
  function renderTree(members: Session[]) {
    return forkRows(members).map((row) => renderSession(row.session, row));
  }

  // Choosing: Ctrl (Command) and a click take a row in or out and start choosing; Shift and a click take the rows
  // from the last one taken; while choosing, a click, Space or Enter takes a row in or out, and Esc stops.
  const choosing = chosen.size > 0;
  const anchor = useRef<string | undefined>(undefined);
  const shownIds = () =>
    [...(aside.current?.querySelectorAll<HTMLElement>('.session-row[data-session-id]') ?? [])]
      .filter((row) => row.dataset.choosable === 'true')
      .map((row) => row.dataset.sessionId!);
  const allSessions = [...sessions, ...elsewhere, ...archived];
  // What is chosen and can no longer be (at work now, gone) or is out of sight (folded away, filtered out by a
  // search) drops out: only what is shown is acted on.
  useEffect(() => {
    if (!chosen.size) return;
    const shown = new Set(
      [
        ...(aside.current?.querySelectorAll<HTMLElement>('.session-row[data-session-id]') ?? []),
      ].map((row) => row.dataset.sessionId!),
    );
    const possible = new Set(
      allSessions
        .filter((session) => choosable(session) && shown.has(session.id))
        .map((session) => session.id),
    );
    const next = pruned(chosen, possible);
    if (next !== chosen) setChosen(next);
  });
  function choose(session: Session, event: { shiftKey: boolean }) {
    if (!choosable(session)) return;
    if (event.shiftKey)
      setChosen(ranged(chosen, shownIds(), anchor.current ?? selectedId, session.id));
    else setChosen(chosenToggled(chosen, session.id));
    anchor.current = session.id;
  }
  const chosenSessions = allSessions.filter((session) => chosen.has(session.id));
  const allArchived =
    chosenSessions.length > 0 && chosenSessions.every((session) => session.archivedAt);
  const [archivedOpen, setArchivedOpen] = useState(false);

  function renderSession(session: Session, row?: ForkRow, inActivity = false) {
    const state = rowState(session, notifications);
    const depth = row?.depth ?? 0;
    const canChoose = choosable(session);
    const taken = chosen.has(session.id);
    return (
      <div
        className={`session-row ${selectedId === session.id ? 'selected' : ''}${taken ? ' chosen' : ''}${inActivity ? ' activity-row' : ''}`}
        data-state={state}
        data-session-id={session.id}
        data-choosable={canChoose}
        {...(depth
          ? {
              'data-depth': depth,
              'data-last': row?.last || undefined,
              style: { '--depth': Math.min(depth, 4) } as CSSProperties,
            }
          : {})}
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
        {/* The lines of the levels above, where they go on past this row; then its own. Four levels at most. */}
        {row?.rails.map(
          (through, level) =>
            through &&
            level < 3 && (
              <span
                key={level}
                className="fork-rail through"
                aria-hidden="true"
                style={{ '--level': level + 1 } as CSSProperties}
              />
            ),
        )}
        {depth > 0 && <span className="fork-rail" aria-hidden="true" />}
        <button
          type="button"
          className="session-select"
          {...(choosing
            ? {
                role: 'checkbox',
                'aria-checked': taken,
                'aria-disabled': canChoose ? undefined : true,
                title: canChoose ? undefined : '正在运行的会话不能选择',
              }
            : {})}
          onClick={(event) => {
            if (choosing || event.ctrlKey || event.metaKey || (event.shiftKey && canChoose)) {
              event.preventDefault();
              choose(session, event);
              return;
            }
            select(session.id);
          }}
          onKeyDown={(event) => {
            if (choosing && (event.key === ' ' || event.key === 'Enter')) {
              event.preventDefault();
              choose(session, event);
              return;
            }
            if (choosing && event.key === 'Escape') {
              event.preventDefault();
              setChosen(new Set());
              return;
            }
            if (event.key === ' ' && event.ctrlKey && canChoose) {
              event.preventDefault();
              choose(session, event);
              return;
            }
            if (!asksForMenu(event)) return;
            event.preventDefault();
            leave();
            sessionMenu(session, below(event.currentTarget));
          }}
        >
          {choosing && (
            <span className={`choose-box${taken ? ' taken' : ''}`} aria-hidden="true">
              {taken && <Check />}
            </span>
          )}
          {/* Finished while out of sight: a green light before the title, until the session is opened. */}
          {lit(session, done) && <DoneDot at={done.get(session.id)} />}
          {inActivity ? (
            <span className="activity-text">
              <span className="activity-line">
                <strong>{session.title}</strong>
                {state && state !== 'done' && (
                  <span className={`running-dot${breathes(state) ? ' breathing' : ''}`} />
                )}
                {projectLabel(session) && (
                  <span className="activity-project">{projectLabel(session)}</span>
                )}
              </span>
              <ActivityLine session={session} state={state} />
            </span>
          ) : (
            <>
              <strong>{session.title}</strong>
              {row?.parentTitle && <span className="sr-only">，派生自 {row.parentTitle}</span>}
              {state && state !== 'done' && (
                <span className={`running-dot${breathes(state) ? ' breathing' : ''}`} />
              )}
              <small>{activity(session, state)}</small>
            </>
          )}
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
  // The activity view: every session as one list by when it changed, under what needs the user (优先事项). The
  // project list stays as it was, folded or not, for when the view is closed.
  const inActivity = prefs.sidebarView === 'activity';
  const elsewhereIds = useMemo(() => new Set(elsewhere.map((session) => session.id)), [elsewhere]);
  // What the project is called where a row has room for it: the name given here, or the folder's. A session
  // without a project names the other computer it is on, or nothing.
  function projectLabel(session: Session) {
    const away = elsewhereIds.has(session.id);
    if (away ? madeFolder.test(session.projectPath) : isInside(session.projectPath, workspaceRoots))
      return away ? (session.device?.name ?? '') : '';
    const key =
      away && session.device
        ? projectPreferenceKey(projectScope, session.device.id, session.projectPath)
        : pathKey(session.projectPath);
    return prefs.projectNames[key] || folderName(session.projectPath);
  }
  // The day headings move on at midnight: one timer, while the view is open.
  const [today, setToday] = useState(() => Date.now());
  useEffect(() => {
    if (!inActivity) return;
    const now = Date.now();
    if (nextDay(today) <= now) setToday(now);
    const timer = setTimeout(() => setToday(Date.now()), nextDay(now) - now + 1000);
    return () => clearTimeout(timer);
  }, [inActivity, today]);
  // The session open on the page of a window in front shows what it waits for itself: it is listed, but not
  // counted on the button (as the notices left it out). Read anew with each change of the sessions.
  const reading =
    document.hasFocus() && document.visibilityState === 'visible' ? selectedId : undefined;
  const urgent = useMemo(
    () =>
      [...sessions, ...elsewhere].filter(
        (session) => session.id !== reading && urgency(session, { failed, done }) !== undefined,
      ).length,
    [sessions, elsewhere, failed, done, reading],
  );
  // What was reported apart from any session (a lost connection, a task not sent): kept until put away.
  const reminders = notifications.notices.filter((notice) => !notice.sessionId);
  const unreadReminders = reminders.filter((notice) => !notice.read).length;
  const { markRead } = notifications;
  // Opening the view reads what it shows. A reminder that comes while it is open is at its head: the list goes
  // back up to it, so that it is seen before it counts as read.
  useEffect(() => {
    if (!inActivity || !notifications.unread) return;
    if (unreadReminders && list.current) list.current.scrollTop = 0;
    markRead();
  }, [inActivity, notifications.unread, unreadReminders, markRead]);
  const recent = useMemo(() => {
    if (!inActivity) return null;
    const term = search.trim().toLowerCase();
    const found = term
      ? [...sessions, ...elsewhere].filter((session) =>
          `${session.title} ${session.projectPath} ${session.device?.name ?? '本机'} ${projectLabel(session)}`
            .toLowerCase()
            .includes(term),
        )
      : [...sessions, ...elsewhere];
    return activityGroups(found, (session) => urgency(session, { failed, done }), today);
    // projectLabel reads what is listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    inActivity,
    sessions,
    elsewhere,
    failed,
    done,
    search,
    today,
    workspaceRoots,
    projectScope,
    prefs.projectNames,
  ]);
  const [activityShown, setActivityShown] = useState(ACTIVITY_PAGE);
  // Each view comes back where it was left.
  const list = useRef<HTMLElement>(null);
  const scrolled = useRef<Record<string, number>>({});
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = scrolled.current[prefs.sidebarView] ?? 0;
  }, [prefs.sidebarView]);
  const toggleView = () =>
    setPrefs((value) => ({
      ...value,
      sidebarView: value.sidebarView === 'activity' ? 'projects' : 'activity',
    }));
  const waiting = urgent + unreadReminders;
  function renderActivity() {
    if (!recent) return null;
    const term = search.trim();
    let left = term ? Infinity : activityShown;
    const total = recent.days.reduce((sum, day) => sum + day.sessions.length, 0);
    return (
      <>
        <div className="list-heading">
          优先事项
          {openNotifySettings && (
            <IconButton title="通知设置" onClick={openNotifySettings}>
              <SlidersHorizontal />
            </IconButton>
          )}
        </div>
        {reminders.map((notice) => (
          <div className={`activity-reminder ${notice.kind}`} key={notice.id} role="note">
            <span>
              <strong>{notice.title}</strong>
              <small>{ago(notice.at)}</small>
            </span>
            <span className="notice-body">{notice.body}</span>
            <IconButton
              title="移除这条提醒"
              size="sm"
              className="activity-dismiss"
              onClick={() => notifications.dismiss(notice.id)}
            >
              <X />
            </IconButton>
          </div>
        ))}
        {recent.priority.map((session) => renderSession(session, undefined, true))}
        {!recent.priority.length && !reminders.length && (
          <p className="project-empty">暂无需要关注的聊天</p>
        )}
        {recent.days.map((day) => {
          if (left <= 0) return null;
          const shown = day.sessions.slice(0, left);
          left -= shown.length;
          return (
            <section className="activity-day" key={day.key} aria-label={day.label}>
              <div className="list-heading">{day.label}</div>
              {shown.map((session) => renderSession(session, undefined, true))}
            </section>
          );
        })}
        {!term && total > activityShown && (
          <button
            type="button"
            className="project-more loose"
            onClick={() => setActivityShown((value) => value + ACTIVITY_PAGE)}
          >
            显示更多 ({total - activityShown})
          </button>
        )}
        {term && !recent.priority.length && !total && <p className="list-empty">没有匹配会话</p>}
      </>
    );
  }
  return (
    <SidebarShell
      open={sideOpen}
      asideRef={aside}
      header={
        <>
          <Brand connectionName={connectionName} />
          <div className="activity-toggle">
            {/* Its name tells the count as well, which its tooltip leaves to the badge. */}
            <button
              type="button"
              className="icon-button"
              title={
                inActivity ? '关闭活动视图' : `查看活动${activityHint ? `  ${activityHint}` : ''}`
              }
              // The name stays and `aria-pressed` tells whether the view shows; the tooltip says what a press does.
              aria-label={waiting ? `查看活动（${waiting} 项需要关注）` : '查看活动'}
              aria-pressed={inActivity}
              onClick={toggleView}
            >
              <Activity />
            </button>
            {!inActivity && waiting > 0 && (
              <span className="notice-badge" aria-hidden="true">
                {waiting > 9 ? '9+' : waiting}
              </span>
            )}
          </div>
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
      {choosing && (
        <div
          className="choose-bar"
          role="toolbar"
          aria-label="已选会话的操作"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setChosen(new Set());
          }}
        >
          <span aria-hidden="true">已选 {chosen.size} 个</span>
          {batchProgress && <small>{batchProgress}</small>}
          {canArchive && archiveChosen && (
            <IconButton
              // Those already in the state asked for are left as they are, and not counted.
              title={
                allArchived
                  ? `恢复 ${chosen.size} 个`
                  : `归档 ${chosenSessions.filter((session) => !session.archivedAt).length} 个`
              }
              size="sm"
              disabled={busy || !connected}
              onClick={() =>
                archiveChosen(
                  allArchived
                    ? chosenSessions
                    : chosenSessions.filter((session) => !session.archivedAt),
                  !allArchived,
                )
              }
            >
              <Archive />
            </IconButton>
          )}
          {deleteChosen && (
            <IconButton
              title={`删除 ${chosen.size} 个`}
              size="sm"
              disabled={busy || !connected}
              onClick={() => deleteChosen(chosenSessions)}
            >
              <Trash2 />
            </IconButton>
          )}
          <IconButton
            title="取消选择"
            size="sm"
            className="choose-cancel"
            onClick={() => setChosen(new Set())}
          >
            <X />
          </IconButton>
        </div>
      )}
      {/* Always there, so that a screen reader is told of the first choice as of the next. */}
      <span className="choose-status" role="status">
        {choosing ? `已选 ${chosen.size} 个会话${batchProgress ? `，${batchProgress}` : ''}` : ''}
      </span>
      <nav
        className="session-list"
        aria-label={inActivity ? '最近的会话' : '会话列表'}
        onKeyDown={moveInList}
        ref={list}
        onScroll={(event) => {
          scrolled.current[prefs.sidebarView] = event.currentTarget.scrollTop;
        }}
      >
        {inActivity ? (
          renderActivity()
        ) : (
          <>
            {pinned.length > 0 && <div className="list-heading">置顶</div>}
            {pinned.map((session) => renderSession(session))}
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
                deviceId
                  ? remoteProjectMenu?.(deviceId, path, position)
                  : projectMenu(path, position);
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
            {renderTree(plain)}
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
                            icon: <Laptop className="fold-folder" />,
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
            {(() => {
              // Put away, at the foot: folded until opened, and open on what a search finds there.
              const term = search.trim().toLowerCase();
              const found = archived
                .filter((session) =>
                  `${session.title} ${session.projectPath} ${session.device?.name ?? ''}`
                    .toLowerCase()
                    .includes(term),
                )
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
              if (!found.length) return null;
              const shown = archivedOpen || !!term;
              return (
                <section className="archived-group">
                  <button
                    type="button"
                    className="project-toggle list-heading archived-toggle"
                    aria-expanded={shown}
                    onClick={() => setArchivedOpen(!archivedOpen)}
                  >
                    已归档 ({found.length})
                  </button>
                  {shown && found.map((session) => renderSession(session))}
                </section>
              );
            })()}
            {search &&
              groups.length === 0 &&
              plain.length === 0 &&
              pinned.length === 0 &&
              othersCount === 0 &&
              !archived.some((session) =>
                session.title.toLowerCase().includes(search.trim().toLowerCase()),
              ) && <p className="list-empty">没有匹配会话</p>}
          </>
        )}
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
              {activity(card.session, rowState(card.session, notifications))} ·{' '}
              {new Date(card.session.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            </small>
          </div>
        )}
      </Presence>
    </SidebarShell>
  );
}
