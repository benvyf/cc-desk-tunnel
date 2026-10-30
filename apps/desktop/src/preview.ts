import { useCallback, useEffect, useRef, useState } from 'react';
import type { Link } from './links.ts';
import { pathKey } from './paths.ts';

export type PreviewSurface = 'main' | 'terminal' | 'inline-terminal';
export type PreviewBounds = { x: number; y: number; width: number; height: number };
export type PreviewView = { surface: PreviewSurface; key: string };
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
  kind: 'text' | 'markdown' | 'image' | 'html';
  text?: string;
  image?: string;
  url?: string;
  token?: string;
};
export type PreviewTab = {
  id: string;
  kind: 'file' | 'web';
  target: string;
  root?: string;
  restricted?: boolean;
};
type Board = { tabs: PreviewTab[]; active: string; expanded: boolean };
const empty: Board = { tabs: [], active: '', expanded: false };

export function previewWebsite(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// Keep each session's files separate. Neither this state nor preview contents enter the model protocol.
export function usePreviewWorkspace(
  workspace: string | null,
  session: string | undefined,
  surface: PreviewSurface,
  sessionIds: string,
) {
  const [boards, setBoards] = useState<Record<string, Board>>({});
  const [width, resize] = useState(440);
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const board = session ? (boards[session] ?? empty) : empty;
  const change = useCallback(
    (update: (board: Board) => Board) => {
      if (!session) return;
      setBoards((current) => ({ ...current, [session]: update(current[session] ?? empty) }));
    },
    [session],
  );
  const release = useCallback(
    (tab: PreviewTab) => {
      void window.desktop?.preview?.release({ surface, key: tab.id }).catch(() => {});
    },
    [surface],
  );
  useEffect(() => {
    setBoards({});
    return () => {
      for (const board of Object.values(boardsRef.current))
        for (const tab of board.tabs) release(tab);
    };
  }, [workspace, release]);
  useEffect(() => {
    const live = new Set(sessionIds.split('\n'));
    const removed = Object.keys(boardsRef.current).filter((id) => !live.has(id));
    if (!removed.length) return;
    for (const id of removed) for (const tab of boardsRef.current[id].tabs) release(tab);
    setBoards((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
    );
  }, [sessionIds, release]);
  function open(kind: PreviewTab['kind'], target: string, root?: string, restricted?: boolean) {
    change((current) => {
      const existing = current.tabs.find(
        (tab) =>
          tab.kind === kind &&
          (kind === 'file' ? pathKey(tab.target) === pathKey(target) : tab.target === target),
      );
      const tab = existing ?? { id: crypto.randomUUID(), kind, target, root, restricted };
      return {
        tabs: existing ? current.tabs : [...current.tabs, tab],
        active: tab.id,
        expanded: true,
      };
    });
  }
  return {
    ...board,
    width,
    resize,
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
    select: (id: string) => change((current) => ({ ...current, active: id })),
    toggle: () => change((current) => ({ ...current, expanded: !current.expanded })),
    collapse: () => change((current) => ({ ...current, expanded: false })),
    close: (id: string) => {
      const tab = board.tabs.find((tab) => tab.id === id);
      if (tab) release(tab);
      change((current) => {
        const tabs = current.tabs.filter((tab) => tab.id !== id);
        return {
          tabs,
          expanded: current.expanded,
          active: current.active === id ? (tabs.at(-1)?.id ?? '') : current.active,
        };
      });
    },
  };
}
export type PreviewWorkspace = ReturnType<typeof usePreviewWorkspace>;
