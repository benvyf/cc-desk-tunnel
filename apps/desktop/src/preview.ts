import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Link } from './links.ts';
import {
  emptyBoard,
  openTab,
  closeTab,
  closeTabs,
  paneTabsToClose,
  pinTab,
  previewTabsFull,
  moveTab,
  splitPane,
  floatTab,
  dockPane,
  restoreLayout,
  previewWebsite,
  navigateFile,
} from './previewLayout.ts';
import { requestedLine } from './previewCode.ts';
import type { FindTarget } from './previewCode.ts';
import type { Declined } from './links.ts';
import { pathKey } from './paths.ts';
import type { PreviewTab, PreviewBoard, FloatRect } from './previewLayout.ts';
import { createPreviewPersistence } from './previewPersistence.ts';
import type { PreviewReading } from './previewViewState.ts';
export type { PreviewTab, PreviewPane, FloatRect } from './previewLayout.ts';
export { previewSpan, previewTabLimit, previewTreeWidth, previewWebsite } from './previewLayout.ts';

export type PreviewSurface = 'main' | 'terminal' | 'inline-terminal';
export type PreviewBounds = { x: number; y: number; width: number; height: number };
export type PreviewView = { surface: PreviewSurface; key: string; pane?: string };
export type PreviewBrowserState = PreviewView & {
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error: string;
  open?: { kind: 'file' | 'web'; target: string; root?: string; restricted?: boolean };
};
export type PreviewFile = {
  path: string;
  kind: 'text' | 'markdown' | 'image' | 'html' | 'pdf' | 'spreadsheet';
  format?: string;
  data?: string;
  missingFonts?: string[];
  text?: string;
  image?: string;
  url?: string;
  token?: string;
  // Text not in UTF-8: 'utf-16le', 'utf-16be' or 'gb18030'.
  encoding?: string;
  // Only the beginning of a larger text file was read; size is the whole file's, in bytes.
  truncated?: boolean;
  size?: number;
};
function restoreWorkspace(key: string | null) {
  let serialized: string | null = null;
  try {
    if (key) serialized = localStorage.getItem(key);
  } catch {}
  const layout = restoreLayout(serialized);
  return {
    key,
    ...layout,
    persistence: createPreviewPersistence(key, layout, serialized, {
      setItem: (name, value) => localStorage.setItem(name, value),
    }),
  };
}
// Layout metadata stays in this client's profile, never in the model protocol.
export function usePreviewWorkspace(
  workspace: string | null,
  session: string | undefined,
  surface: PreviewSurface,
  sessionIds: string,
) {
  const storageKey = workspace
    ? `cc-preview-v1:${window.desktop?.boot?.connection ?? ''}:${surface}:${workspace}`
    : null;
  const [state, setState] = useState(() => restoreWorkspace(storageKey));
  const [pending, setPending] = useState<Set<string>>(
    () =>
      new Set(
        Object.values(state.boards)
          .flatMap((b) => b.tabs)
          .filter((t) => t.kind === 'web' || /\.html?$/i.test(t.target))
          .map((t) => t.id),
      ),
  );
  const [restoredTabs, setRestoredTabs] = useState<Set<string>>(
    () =>
      new Set(
        Object.values(state.boards)
          .flatMap((b) => b.tabs)
          .map((t) => t.id),
      ),
  );
  // Transient tab choices share the navigation owner/lifecycle, never the model or saved layout.
  const tabViews = useRef(new Map<string, { navigation?: string; source?: boolean }>());
  const boards = state.key === storageKey ? state.boards : {};
  useLayoutEffect(() => {
    state.persistence.updateLayout({ boards: state.boards, width: state.width });
  }, [state]);
  const current = useRef(boards);
  current.current = boards;
  const board = session ? (boards[session] ?? emptyBoard()) : emptyBoard();
  // The workspace and session ([storageKey, session]) where an opening was refused for want of room (every one of
  // the 64 tabs kept) since a tab of its last closed; the sidebar there says so.
  const scope = JSON.stringify([storageKey, session]);
  const [full, setFull] = useState<string | null>(null);
  const release = useCallback(
    (tab: PreviewTab) => {
      if (tab.kind === 'chat') return;
      void window.desktop?.preview?.release({ surface, key: tab.id }).catch(() => {});
    },
    [surface],
  );
  // A tab that leaves a session's board, closed or taken over by the next temporary opening, gives up its view
  // state and its native view. Whole boards (a session gone, another workspace) are released where they go.
  const shown = useRef(state);
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = state;
    if (previous.persistence !== state.persistence || previous.boards === state.boards) return;
    for (const [id, before] of Object.entries(previous.boards)) {
      const after = state.boards[id];
      if (!after || after === before || after.tabs === before.tabs) continue;
      const kept = new Set(after.tabs.map((t) => t.id));
      for (const tab of before.tabs)
        if (!kept.has(tab.id)) {
          tabViews.current.delete(JSON.stringify([id, tab.id]));
          release(tab);
          if (full === JSON.stringify([state.key, id])) setFull(null);
        }
    }
  }, [state, release, full]);
  useEffect(() => {
    // StrictMode replays setup after cleanup; a closed owner must never be reused.
    const restored =
      state.key === storageKey && !state.persistence.closed ? state : restoreWorkspace(storageKey);
    const owner = restored.persistence;
    tabViews.current.clear();
    if (restored !== state) setState(restored);
    setRestoredTabs(
      new Set(
        Object.values(restored.boards)
          .flatMap((b) => b.tabs)
          .map((t) => t.id),
      ),
    );
    setPending(
      new Set(
        Object.values(restored.boards)
          .flatMap((b) => b.tabs)
          .filter((t) => t.kind === 'web' || /\.html?$/i.test(t.target))
          .map((t) => t.id),
      ),
    );
    const persist = owner.flush;
    window.addEventListener('beforeunload', persist);
    window.addEventListener('pagehide', persist);
    return () => {
      window.removeEventListener('beforeunload', persist);
      window.removeEventListener('pagehide', persist);
      owner.close();
      for (const b of Object.values(owner.layout.boards)) for (const t of b.tabs) release(t);
    };
  }, [storageKey, release]);
  useEffect(() => {
    // Session lists are initially empty during reconnect; prune only once hydrated.
    if (!sessionIds) return;
    const live = new Set(sessionIds.split('\n'));
    const removed = Object.keys(current.current).filter((id) => !live.has(id));
    if (!removed.length) return;
    for (const id of removed)
      for (const t of current.current[id].tabs) {
        tabViews.current.delete(JSON.stringify([id, t.id]));
        release(t);
      }
    setState((s) => ({
      ...s,
      boards: Object.fromEntries(Object.entries(s.boards).filter(([id]) => live.has(id))),
    }));
  }, [sessionIds, release]);
  const change = useCallback(
    (update: (board: PreviewBoard) => PreviewBoard) => {
      if (!session || !storageKey) return;
      setState((s) => {
        if (s.key !== storageKey) return s;
        const before = s.boards[session];
        const next = update(before ?? emptyBoard());
        // An update that changes nothing keeps the state, so nothing renders or is saved again.
        return before && next === before ? s : { ...s, boards: { ...s.boards, [session]: next } };
      });
    },
    [session, storageKey],
  );
  const activate = (id: string) => {
    setRestoredTabs((old) => {
      const next = new Set(old);
      next.delete(id);
      return next;
    });
    setPending((old) => {
      const next = new Set(old);
      next.delete(id);
      return next;
    });
  };
  function open(
    kind: PreviewTab['kind'],
    target: string,
    root?: string,
    restricted?: boolean,
    title?: string,
    position?: { line?: number; column?: number; find?: FindTarget[] },
    temporary = false,
    // The tab whose link this follows: kept first, so a temporary tab's own link never takes its place.
    source?: string,
  ) {
    if (
      session &&
      previewTabsFull(pinTab(current.current[session] ?? emptyBoard(), source ?? ''), {
        kind,
        target,
      })
    ) {
      setFull(scope);
      change((b) => (b.expanded ? b : { ...b, expanded: true }));
      return;
    }
    const find = position?.find?.length ? position.find : undefined;
    // Text to look for goes to its line, or to the top where it is not found.
    const line = requestedLine(position?.line) ?? (find ? 1 : undefined);
    const navigation = line
      ? { id: crypto.randomUUID(), line, column: requestedLine(position?.column), find }
      : undefined;
    if (navigation && session) {
      const existing = current.current[session]?.tabs.find(
        (tab) => tab.kind === 'file' && pathKey(tab.target) === pathKey(target),
      );
      if (existing)
        setPending((old) => {
          if (!old.has(existing.id)) return old;
          const next = new Set(old);
          next.delete(existing.id);
          return next;
        });
      // Keep restoredTabs: switching from source to an executable page still needs confirmation.
    }
    change((b) => {
      const next = openTab(source ? pinTab(b, source) : b, {
        id: crypto.randomUUID(),
        kind,
        target,
        root,
        restricted,
        title,
        ...(temporary ? { temporary } : {}),
      });
      return navigation ? navigateFile(next, target, navigation) : next;
    });
  }
  const active = board.panes.find((p) => p.id === board.focused)?.active ?? '';
  const reading = useMemo(
    () => ({
      beforeFlush: state.persistence.beforeFlush,
      get: (id: string) => (session ? state.persistence.get(session, id) : undefined),
      set: (id: string, value: PreviewReading | undefined) => {
        if (session) state.persistence.set(session, id, value);
      },
    }),
    [state.persistence, session],
  );
  return {
    ...board,
    scope,
    active,
    width: state.width,
    full: full === scope,
    pending,
    restoredTabs,
    reading,
    navigated: {
      has: (id: string, request: string) =>
        tabViews.current.get(JSON.stringify([session, id]))?.navigation === request,
      mark: (id: string, request: string) => {
        const key = JSON.stringify([session, id]);
        tabViews.current.set(key, { ...tabViews.current.get(key), navigation: request });
      },
    },
    sourceMode: {
      get: (id: string) => tabViews.current.get(JSON.stringify([session, id]))?.source,
      set: (id: string, source: boolean) => {
        const key = JSON.stringify([session, id]);
        tabViews.current.set(key, { ...tabViews.current.get(key), source });
      },
    },
    wrap: (id: string, value: boolean) =>
      change((b) => ({
        ...b,
        tabs: b.tabs.map((tab) => (tab.id === id ? { ...tab, wrap: value } : tab)),
      })),
    activate,
    resize: (value: number | ((previous: number) => number)) =>
      setState((s) => ({ ...s, width: typeof value === 'function' ? value(s.width) : value })),
    // `temporary`: a single click in the workspace tree or the Git changes, or a followed link, opens the file in
    // the pane's temporary tab; anything else (the file picker, a double-click) opens a kept tab, or keeps it.
    openFile: (
      path: string,
      root?: string,
      restricted?: boolean,
      position?: { line?: number; column?: number },
      temporary?: boolean,
      source?: string,
    ) => open('file', path, root, restricted, undefined, position, temporary, source),
    openChat: (id: string, title = '侧边对话') => open('chat', id, undefined, undefined, title),
    openWebsite: (url: string, temporary?: boolean, source?: string) => {
      const target = previewWebsite(url);
      if (target)
        open('web', target, undefined, undefined, undefined, undefined, temporary, source);
    },
    // Whether the link is shown here (true); one that is not (false) is opened as it would be without a preview
    // (followLink). A folder, or a file the preview cannot show, is declined: what it is comes back, for the
    // caller to show it in the file manager (openDeclined). A link from a restricted document is always shown
    // here, where the preview keeps it inside its workspace (preview-files.cjs), and never handed to the system.
    async follow(
      link: Link,
      root?: string,
      restricted?: boolean,
      find?: FindTarget[],
      // The preview tab the link is in, if any (open's `source`).
      source?: string,
    ): Promise<boolean | Declined> {
      if (!window.desktop?.preview || !session || !workspace) return false;
      if (link.kind === 'path') {
        if (!restricted) {
          const info = await inspectQuickly(link.path);
          if (info?.kind === 'directory') return { kind: 'directory', runs: info.runs };
          if (info?.kind === 'file' && !previewable(link.path))
            return { kind: 'unpreviewable', runs: info.runs };
        }
        // A followed link, from the conversation, a tool card or a document, opens a temporary tab.
        open('file', link.path, root, restricted, undefined, { ...link, find }, true, source);
        return true;
      }
      if (link.kind === 'web') {
        const target = previewWebsite(link.url);
        if (target) {
          open('web', target, undefined, undefined, undefined, undefined, true, source);
          return true;
        }
      }
      return false;
    },
    focus: (id: string) => change((b) => (b.focused === id ? b : { ...b, focused: id })),
    select: (id: string) =>
      change((b) => ({
        ...b,
        focused: b.panes.find((p) => p.tabs.includes(id))?.id ?? b.focused,
        panes: b.panes.map((p) => (p.tabs.includes(id) ? { ...p, active: id } : p)),
      })),
    toggle: () => change((b) => ({ ...b, expanded: !b.expanded })),
    collapse: () => change((b) => ({ ...b, expanded: false })),
    toggleTree: () => change((b) => ({ ...b, tree: !b.tree })),
    split: (pane: string, id: string) => change((b) => splitPane(b, pane, id, crypto.randomUUID())),
    float: (id: string) => change((b) => floatTab(b, id, crypto.randomUUID())),
    dock: (id: string) => change((b) => dockPane(b, id)),
    move: (id: string, pane: string, index?: number) => change((b) => moveTab(b, id, pane, index)),
    rect: (id: string, rect: FloatRect) =>
      change((b) => ({
        ...b,
        panes: b.panes.map((p) => (p.id === id ? { ...p, floating: rect } : p)),
      })),
    pin: (id: string) => change((b) => pinTab(b, id)),
    // A closed tab's views are released as it leaves the board (above).
    close: (id: string) => change((b) => closeTab(b, id)),
    // The tab menu's "关闭其他标签" (which also shows the tab kept), "关闭右侧标签" and "关闭全部", in the tab's pane.
    closeMany: (id: string, which: 'others' | 'right' | 'all') =>
      change((b) => {
        const next = closeTabs(b, paneTabsToClose(b, id, which));
        return which === 'others'
          ? {
              ...next,
              panes: next.panes.map((p) => (p.tabs.includes(id) ? { ...p, active: id } : p)),
            }
          : next;
      }),
  };
}
export type PreviewWorkspace = ReturnType<typeof usePreviewWorkspace>;

// What a path is, if the desktop says so soon: a path it cannot look at, or not in time, opens in the preview as
// before, which says what is wrong with it.
async function inspectQuickly(path: string) {
  const desktop = window.desktop!;
  return Promise.race([
    Promise.resolve()
      .then(() => desktop.inspectPath(path))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
  ]);
}

// Kinds of file the preview cannot show (preview-files.cjs reads text, pictures, PDF, office documents and
// spreadsheets): programs, archives, media, fonts, databases. Any other file is tried, and one that turns out
// not to be text says so in its tab.
const unpreviewable = new Set(
  (
    'exe dll msi msix appx sys com scr lnk so dylib o lib pdb class jar war apk ipa wasm pyc pyo node ' +
    'zip 7z rar tar gz tgz bz2 xz zst cab iso img dmg vhd vhdx bin ' +
    'mp3 wav flac ogg oga m4a aac wma opus mp4 m4v mov avi mkv webm wmv flv ' +
    'woff woff2 ttf otf eot sqlite sqlite3 db mdb accdb psd ai sketch fig tif tiff heic heif raw ' +
    'blend fbx glb'
  ).split(' '),
);
export const previewable = (path: string) =>
  !unpreviewable.has(/\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase() ?? '');
