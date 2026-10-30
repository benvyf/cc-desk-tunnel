import { pathKey } from './paths.ts';

export type PreviewTab = {
  id: string;
  kind: 'file' | 'web';
  target: string;
  root?: string;
  restricted?: boolean;
};
export type FloatRect = { x: number; y: number; width: number; height: number };
export type PreviewPane = { id: string; tabs: string[]; active: string; floating?: FloatRect };
export type PreviewBoard = {
  tabs: PreviewTab[];
  panes: PreviewPane[];
  focused: string;
  expanded: boolean;
  tree: boolean;
};
export const emptyBoard = (): PreviewBoard => ({
  tabs: [],
  panes: [{ id: 'primary', tabs: [], active: '' }],
  focused: 'primary',
  expanded: false,
  tree: false,
});
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
export function normalize(board: PreviewBoard): PreviewBoard {
  let panes = board.panes.filter((p) => p.tabs.length);
  if (!panes.length) panes = emptyBoard().panes;
  return {
    ...board,
    panes,
    focused: panes.some((p) => p.id === board.focused) ? board.focused : panes[0].id,
  };
}
export function openTab(board: PreviewBoard, tab: PreviewTab): PreviewBoard {
  const existing = board.tabs.find(
    (t) =>
      t.kind === tab.kind &&
      (t.kind === 'file' ? pathKey(t.target) === pathKey(tab.target) : t.target === tab.target),
  );
  if (existing) {
    const pane = board.panes.find((p) => p.tabs.includes(existing.id))!;
    return {
      ...board,
      focused: pane.id,
      expanded: true,
      panes: board.panes.map((p) => (p === pane ? { ...p, active: existing.id } : p)),
    };
  }
  if (board.tabs.length >= 64) return board;
  const target = board.panes.find((p) => p.id === board.focused) ?? board.panes[0];
  return {
    ...board,
    tabs: [...board.tabs, tab],
    expanded: true,
    panes: board.panes.map((p) =>
      p === target ? { ...p, tabs: [...p.tabs, tab.id], active: tab.id } : p,
    ),
  };
}
export function moveTab(
  board: PreviewBoard,
  id: string,
  paneId: string,
  index?: number,
): PreviewBoard {
  if (!board.tabs.some((t) => t.id === id) || !board.panes.some((p) => p.id === paneId))
    return board;
  return normalize({
    ...board,
    focused: paneId,
    panes: board.panes.map((p) => {
      const tabs = p.tabs.filter((t) => t !== id);
      if (p.id === paneId)
        tabs.splice(Math.max(0, Math.min(index ?? tabs.length, tabs.length)), 0, id);
      return {
        ...p,
        tabs,
        active: p.id === paneId ? id : tabs.includes(p.active) ? p.active : (tabs.at(-1) ?? ''),
      };
    }),
  });
}
export function splitPane(
  board: PreviewBoard,
  paneId: string,
  tabId: string,
  newId: string,
): PreviewBoard {
  const pane = board.panes.find((p) => p.id === paneId);
  if (!pane?.tabs.includes(tabId) || pane.tabs.length < 2 || board.panes.length >= 4) return board;
  return moveTab(
    { ...board, panes: [...board.panes, { id: newId, tabs: [], active: '' }] },
    tabId,
    newId,
  );
}
export function floatTab(board: PreviewBoard, tabId: string, newId: string): PreviewBoard {
  if (!board.tabs.some((t) => t.id === tabId) || board.panes.length >= 4) return board;
  return moveTab(
    {
      ...board,
      panes: [
        ...board.panes,
        { id: newId, tabs: [], active: '', floating: { x: 40, y: 60, width: 480, height: 420 } },
      ],
    },
    tabId,
    newId,
  );
}
export function dockPane(board: PreviewBoard, paneId: string): PreviewBoard {
  const source = board.panes.find((p) => p.id === paneId);
  if (!source?.floating) return board;
  const target = board.panes.find((p) => !p.floating);
  if (!target)
    return {
      ...board,
      panes: board.panes.map((p) => (p === source ? { ...p, floating: undefined } : p)),
    };
  return {
    ...board,
    focused: target.id,
    expanded: true,
    panes: board.panes
      .filter((p) => p !== source)
      .map((p) =>
        p === target ? { ...p, tabs: [...p.tabs, ...source.tabs], active: source.active } : p,
      ),
  };
}
export function closeTab(board: PreviewBoard, id: string): PreviewBoard {
  return normalize({
    ...board,
    tabs: board.tabs.filter((t) => t.id !== id),
    panes: board.panes.map((p) => {
      const tabs = p.tabs.filter((t) => t !== id);
      return { ...p, tabs, active: p.active === id ? (tabs.at(-1) ?? '') : p.active };
    }),
  });
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const local = (value: unknown): value is string =>
  text(value) && !/^[\\/]{2}/.test(value) && /^(?:[a-z]:[\\/]|\/)/i.test(value);
const bound = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
export function restoreLayout(serialized: string | null): {
  width: number;
  boards: Record<string, PreviewBoard>;
} {
  const fallback = { width: 440, boards: {} };
  if (!serialized || serialized.length > 2_000_000) return fallback;
  try {
    const input = JSON.parse(serialized);
    if (!input || typeof input !== 'object') return fallback;
    const boards: Record<string, PreviewBoard> = {};
    for (const [session, raw] of Object.entries(input.boards ?? {}).slice(0, 100)) {
      if (
        !text(session) ||
        ['__proto__', 'constructor', 'prototype'].includes(session) ||
        !raw ||
        typeof raw !== 'object'
      )
        continue;
      const value = raw as Record<string, any>;
      const tabs: PreviewTab[] = [];
      for (const t of Array.isArray(value.tabs) ? value.tabs.slice(0, 64) : []) {
        if (!t || !text(t.id) || tabs.some((x) => x.id === t.id)) continue;
        if (t.kind === 'file' && local(t.target))
          tabs.push({
            id: t.id,
            kind: 'file',
            target: t.target,
            ...(local(t.root) ? { root: t.root } : {}),
            restricted: t.restricted === true,
          });
        if (t.kind === 'web' && text(t.target) && previewWebsite(t.target))
          tabs.push({ id: t.id, kind: 'web', target: previewWebsite(t.target)! });
      }
      const assigned = new Set<string>(),
        panes: PreviewPane[] = [];
      for (const p of Array.isArray(value.panes) ? value.panes.slice(0, 4) : []) {
        if (!p || !text(p.id) || panes.some((x) => x.id === p.id)) continue;
        const ids: string[] = [];
        for (const id of Array.isArray(p.tabs) ? p.tabs : [])
          if (tabs.some((t) => t.id === id) && !assigned.has(id)) {
            assigned.add(id);
            ids.push(id);
          }
        if (!ids.length) continue;
        const floating =
          p.floating && typeof p.floating === 'object'
            ? {
                x: bound(p.floating.x, 0, 4000, 40),
                y: bound(p.floating.y, 0, 3000, 60),
                width: bound(p.floating.width, 280, 1200, 480),
                height: bound(p.floating.height, 180, 1000, 420),
              }
            : undefined;
        panes.push({
          id: p.id,
          tabs: ids,
          active: ids.includes(p.active) ? p.active : ids[0],
          ...(floating ? { floating } : {}),
        });
      }
      if (!panes.length) panes.push(...emptyBoard().panes);
      for (const t of tabs) if (!assigned.has(t.id)) panes[0].tabs.push(t.id);
      if (!panes[0].active) panes[0].active = panes[0].tabs[0] ?? '';
      boards[session] = normalize({
        tabs,
        panes,
        focused: value.focused,
        expanded: value.expanded === true,
        tree: value.tree === true,
      });
    }
    return { width: bound(input.width, 320, 900, 440), boards };
  } catch {
    return fallback;
  }
}

export function fitFloat(
  rect: FloatRect,
  viewportWidth: number,
  viewportHeight: number,
): FloatRect {
  const width = Math.min(Math.max(280, rect.width), Math.max(0, viewportWidth));
  const height = Math.min(Math.max(180, rect.height), Math.max(0, viewportHeight - 36));
  return {
    x: Math.max(0, Math.min(viewportWidth - width, rect.x)),
    y: Math.max(36, Math.min(viewportHeight - height, rect.y)),
    width,
    height,
  };
}
