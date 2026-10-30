import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [state, setState] = useState(() => ({
    key: storageKey,
    ...restoreLayout(storageKey ? localStorage.getItem(storageKey) : null),
  }));
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
  const scope = useRef({ key: storageKey, boards: state.boards, width: state.width });
  if (scope.current.key === storageKey) {
    scope.current.boards = boards;
    scope.current.width = state.width;
  }
  const current = useRef(boards);
  current.current = boards;
  const board = session ? (boards[session] ?? emptyBoard()) : emptyBoard();
  const release = useCallback(
    (tab: PreviewTab) => {
      void window.desktop?.preview?.release({ surface, key: tab.id }).catch(() => {});
    },
    [surface],
  );
  useEffect(() => {
    const restored = restoreLayout(storageKey ? localStorage.getItem(storageKey) : null);
    const owner = { key: storageKey, boards: restored.boards, width: restored.width };
    scope.current = owner;
    setState({ key: storageKey, ...restored });
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
    const persist = () => {
      if (owner.key)
        try {
          localStorage.setItem(
            owner.key,
            JSON.stringify({ width: owner.width, boards: owner.boards }),
          );
        } catch {}
    };
    window.addEventListener('beforeunload', persist);
    window.addEventListener('pagehide', persist);
    return () => {
      window.removeEventListener('beforeunload', persist);
      window.removeEventListener('pagehide', persist);
      persist();
      for (const b of Object.values(owner.boards)) for (const t of b.tabs) release(t);
    };
  }, [storageKey, release]);
  useEffect(() => {
    if (!storageKey || state.key !== storageKey) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ width: state.width, boards: state.boards }),
        );
      } catch {}
    }, 150);
    return () => clearTimeout(timer);
  }, [state, storageKey]);
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
  function open(kind: PreviewTab['kind'], target: string, root?: string, restricted?: boolean) {
    change((b) => openTab(b, { id: crypto.randomUUID(), kind, target, root, restricted }));
  }
  const active = board.panes.find((p) => p.id === board.focused)?.active ?? '';
  return {
    ...board,
    active,
    width: state.width,
    pending,
    restoredTabs,
    activate,
    resize: (value: number | ((previous: number) => number)) =>
      setState((s) => ({ ...s, width: typeof value === 'function' ? value(s.width) : value })),
    openFile: (path: string, root?: string, restricted?: boolean) =>
      open('file', path, root, restricted),
    openWebsite: (url: string) => {
      const target = previewWebsite(url);
      if (target) open('web', target);
    },
    follow(link: Link, root?: string) {
      if (!window.desktop?.preview || !session || !workspace) return false;
      if (link.kind === 'path') {
        open('file', link.path, root);
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
