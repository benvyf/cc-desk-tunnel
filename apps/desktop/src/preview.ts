import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Link } from './links.ts';
import {
  emptyBoard,
  openTab,
  closeTab,
  moveTab,
  splitPane,
  floatTab,
  dockPane,
  restoreLayout,
  previewWebsite,
} from './previewLayout.ts';
import type { PreviewTab, PreviewBoard, FloatRect } from './previewLayout.ts';
import { createPreviewPersistence } from './previewPersistence.ts';
import type { PreviewReading } from './previewViewState.ts';
export type { PreviewTab, PreviewPane, FloatRect } from './previewLayout.ts';
export { previewWebsite } from './previewLayout.ts';

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
  kind: 'text' | 'markdown' | 'image' | 'html' | 'pdf';
  data?: string;
  missingFonts?: string[];
  text?: string;
  image?: string;
  url?: string;
  token?: string;
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
  const boards = state.key === storageKey ? state.boards : {};
  useLayoutEffect(() => {
    state.persistence.updateLayout({ boards: state.boards, width: state.width });
  }, [state]);
  const current = useRef(boards);
  current.current = boards;
  const board = session ? (boards[session] ?? emptyBoard()) : emptyBoard();
  const release = useCallback(
    (tab: PreviewTab) => {
      if (tab.kind === 'chat') return;
      void window.desktop?.preview?.release({ surface, key: tab.id }).catch(() => {});
    },
    [surface],
  );
  useEffect(() => {
    // StrictMode replays setup after cleanup; a closed owner must never be reused.
    const restored =
      state.key === storageKey && !state.persistence.closed ? state : restoreWorkspace(storageKey);
    const owner = restored.persistence;
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
    for (const id of removed) for (const t of current.current[id].tabs) release(t);
    setState((s) => ({
      ...s,
      boards: Object.fromEntries(Object.entries(s.boards).filter(([id]) => live.has(id))),
    }));
  }, [sessionIds, release]);
  const change = useCallback(
    (update: (board: PreviewBoard) => PreviewBoard) => {
      if (!session || !storageKey) return;
      setState((s) =>
        s.key === storageKey
          ? { ...s, boards: { ...s.boards, [session]: update(s.boards[session] ?? emptyBoard()) } }
          : s,
      );
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
  ) {
    change((b) => openTab(b, { id: crypto.randomUUID(), kind, target, root, restricted, title }));
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
    scope: JSON.stringify([storageKey, session]),
    active,
    width: state.width,
    pending,
    restoredTabs,
    reading,
    activate,
    resize: (value: number | ((previous: number) => number)) =>
      setState((s) => ({ ...s, width: typeof value === 'function' ? value(s.width) : value })),
    openFile: (path: string, root?: string, restricted?: boolean) =>
      open('file', path, root, restricted),
    openChat: (id: string, title = '侧边对话') => open('chat', id, undefined, undefined, title),
    openWebsite: (url: string) => {
      const target = previewWebsite(url);
      if (target) open('web', target);
    },
    follow(link: Link, root?: string, restricted?: boolean) {
      if (!window.desktop?.preview || !session || !workspace) return false;
      if (link.kind === 'path') {
        open('file', link.path, root, restricted);
        return true;
      }
      if (link.kind === 'web') {
        const target = previewWebsite(link.url);
        if (target) {
          open('web', target);
          return true;
        }
      }
      return false;
    },
    focus: (id: string) => change((b) => ({ ...b, focused: id })),
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
    close: (id: string) => {
      const tab = board.tabs.find((t) => t.id === id);
      if (tab) release(tab);
      change((b) => closeTab(b, id));
    },
  };
}
export type PreviewWorkspace = ReturnType<typeof usePreviewWorkspace>;
