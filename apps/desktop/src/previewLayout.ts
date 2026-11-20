import { pathKey } from './paths.ts';
import type { FindTarget } from './previewCode.ts';

export type PreviewTab = {
  id: string;
  kind: 'file' | 'web' | 'chat';
  title?: string;
  target: string;
  root?: string;
  restricted?: boolean;
  wrap?: boolean;
  // A temporary tab (VS Code's preview mode): what a single click or a followed link opens. The next such opening
  // in its pane takes its place instead of adding a tab; double-clicking, moving it or "固定标签" keeps it.
  temporary?: boolean;
  // One explicit user navigation; filtered out when a layout is restored.
  // `find`: text to look for in the file, whose line is gone to instead; nowhere, where it is not found.
  navigation?: { id: string; line: number; column?: number; find?: FindTarget[] };
  // A file shown as its changes (PreviewDiff.tsx) rather than as itself; kept with the layout.
  view?: 'diff';
  // One request to show a file's first change (the changes panel's 打开); filtered out when a layout is saved.
  reveal?: string;
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
// The workspace tree is a column of its own: opening it widens the preview by this much, so the file keeps its
// width (the width the user drags is the panes').
export const previewTreeWidth = 200;
export const previewSpan = (width: number, tree: boolean) => width + (tree ? previewTreeWidth : 0);
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
export const previewTabLimit = 64;
const sameTab = (a: PreviewTab, b: Pick<PreviewTab, 'kind' | 'target'>) =>
  a.kind === b.kind &&
  (a.kind === 'file' ? pathKey(a.target) === pathKey(b.target) : a.target === b.target);
// The tab an opening would take the place of: the temporary tab of the pane it opens in, or, with no room left
// for another tab, any temporary tab.
function replaceable(board: PreviewBoard, tab: PreviewTab) {
  const target = board.panes.find((p) => p.id === board.focused) ?? board.panes[0];
  return (
    (tab.temporary
      ? board.tabs.find((t) => t.temporary && target.tabs.includes(t.id))
      : undefined) ??
    (board.tabs.length >= previewTabLimit ? board.tabs.find((t) => t.temporary) : undefined)
  );
}
// Whether opening this tab finds no room: every one of the 64 tabs is kept, and it is not one of them.
export function previewTabsFull(board: PreviewBoard, tab: Pick<PreviewTab, 'kind' | 'target'>) {
  return (
    board.tabs.length >= previewTabLimit && !board.tabs.some((t) => t.temporary || sameTab(t, tab))
  );
}
const pinned = (tab: PreviewTab): PreviewTab => {
  if (!tab.temporary) return tab;
  const { temporary: _, ...rest } = tab;
  return rest;
};
export function pinTab(board: PreviewBoard, id: string): PreviewBoard {
  if (!board.tabs.some((t) => t.id === id && t.temporary)) return board;
  return { ...board, tabs: board.tabs.map((t) => (t.id === id ? pinned(t) : t)) };
}
export function openTab(board: PreviewBoard, tab: PreviewTab): PreviewBoard {
  const existing = board.tabs.find((t) => sameTab(t, tab));
  if (existing) {
    const pane = board.panes.find((p) => p.tabs.includes(existing.id))!;
    // Already shown as asked: the same board, so nothing renders or is saved again.
    if (
      board.expanded &&
      board.focused === pane.id &&
      pane.active === existing.id &&
      (tab.temporary || !existing.temporary)
    )
      return board;
    return {
      // Opening a temporary tab's file to keep it (the file picker, a double-click) keeps the tab.
      ...(tab.temporary ? board : pinTab(board, existing.id)),
      focused: pane.id,
      expanded: true,
      panes: board.panes.map((p) => (p === pane ? { ...p, active: existing.id } : p)),
    };
  }
  const replaced = replaceable(board, tab);
  if (replaced) {
    // The new tab takes the old one's place under a new id, so nothing of the old file's view (its reading state,
    // its native view) carries over; preview.ts releases it as it does a closed tab's.
    const pane = board.panes.find((p) => p.tabs.includes(replaced.id))!;
    return {
      ...board,
      focused: pane.id,
      expanded: true,
      tabs: board.tabs.map((t) => (t === replaced ? tab : t)),
      panes: board.panes.map((p) =>
        p === pane
          ? { ...p, tabs: p.tabs.map((id) => (id === replaced.id ? tab.id : id)), active: tab.id }
          : p,
      ),
    };
  }
  if (board.tabs.length >= previewTabLimit) return board;
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
// A line to go to is in the file itself: a tab showing the file's changes shows the file again.
export function navigateFile(
  board: PreviewBoard,
  target: string,
  navigation: NonNullable<PreviewTab['navigation']>,
): PreviewBoard {
  return {
    ...board,
    tabs: board.tabs.map((tab) => {
      if (tab.kind !== 'file' || pathKey(tab.target) !== pathKey(target)) return tab;
      const { view: _view, reveal: _reveal, ...rest } = tab;
      return { ...rest, navigation };
    }),
  };
}
// The file's tab shows its changes, from the first (`reveal`); a line it was still to go to is dropped.
export function showChanges(board: PreviewBoard, target: string, reveal: string): PreviewBoard {
  return {
    ...board,
    tabs: board.tabs.map((tab) => {
      if (tab.kind !== 'file' || pathKey(tab.target) !== pathKey(target)) return tab;
      const { navigation: _, ...rest } = tab;
      return { ...rest, view: 'diff', reveal };
    }),
  };
}
// A tab shown as its changes (`diff`), or as itself.
export function setTabView(
  board: PreviewBoard,
  id: string,
  view: 'diff' | undefined,
): PreviewBoard {
  const tab = board.tabs.find((t) => t.id === id);
  if (!tab || tab.kind !== 'file' || tab.view === view) return board;
  const { view: _view, reveal: _reveal, ...rest } = tab;
  return {
    ...board,
    tabs: board.tabs.map((t) => (t === tab ? { ...rest, ...(view ? { view } : {}) } : t)),
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
  // A temporary tab moved to another pane (a drop there, a split, a float) is one the user keeps.
  const moved = !board.panes.find((p) => p.id === paneId)!.tabs.includes(id);
  return normalize({
    ...(moved ? pinTab(board, id) : board),
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
  // The docked pane takes the floating one's tabs as kept tabs, so it never has two temporary tabs.
  const moved = new Set(source.tabs);
  return {
    ...board,
    tabs: board.tabs.map((t) => (moved.has(t.id) ? pinned(t) : t)),
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
  return closeTabs(board, [id]);
}
export function closeTabs(board: PreviewBoard, ids: readonly string[]): PreviewBoard {
  const closing = new Set(ids);
  if (!board.tabs.some((t) => closing.has(t.id))) return board;
  return normalize({
    ...board,
    tabs: board.tabs.filter((t) => !closing.has(t.id)),
    panes: board.panes.map((p) => {
      const tabs = p.tabs.filter((t) => !closing.has(t));
      return { ...p, tabs, active: closing.has(p.active) ? (tabs.at(-1) ?? '') : p.active };
    }),
  });
}
// The tabs of a tab's pane that "关闭其他标签" / "关闭右侧标签" / "关闭全部" close.
export function paneTabsToClose(
  board: PreviewBoard,
  id: string,
  which: 'others' | 'right' | 'all',
): string[] {
  const tabs = board.panes.find((p) => p.tabs.includes(id))?.tabs ?? [];
  if (which === 'all') return [...tabs];
  if (which === 'others') return tabs.filter((t) => t !== id);
  return tabs.slice(tabs.indexOf(id) + 1);
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
            wrap: t.wrap === true,
            // Layouts saved before the changes view carry no view: their tabs show the file.
            ...(t.view === 'diff' ? { view: 'diff' as const } : {}),
            // Layouts saved before temporary tabs carry no flag: their tabs are kept ones.
            ...(t.temporary === true ? { temporary: true } : {}),
          });
        if (t.kind === 'web' && text(t.target) && previewWebsite(t.target))
          tabs.push({
            id: t.id,
            kind: 'web',
            target: previewWebsite(t.target)!,
            ...(t.temporary === true ? { temporary: true } : {}),
          });
        if (
          t.kind === 'chat' &&
          text(t.target) &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(t.target)
        )
          tabs.push({
            id: t.id,
            kind: 'chat',
            target: t.target,
            title: text(t.title) ? t.title.slice(0, 120) : '侧边对话',
          });
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
