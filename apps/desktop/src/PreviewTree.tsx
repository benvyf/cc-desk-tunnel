import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { isWindowsPath } from '@cc-desk-tunnel/protocol';
import { Button, IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  ExternalLink,
  FileText,
  RefreshCw,
  Search,
} from './icons.tsx';
import type { PreviewSurface } from './preview.ts';
import { pathKey } from './paths.ts';
import { copyText } from './copy.tsx';
import { fileManager } from './linkActions.ts';
import { attachWords, pathMime } from './composerAttach.ts';
import type { AttachResult } from './composerAttach.ts';
type Entry = { name: string; path: string; kind: 'file' | 'directory' };
// A row's menu, opened by a right-click or from the keyboard (the menu key, Shift+F10).
type OpenMenu = (at: MenuPosition, entry: Entry) => void;
// The open folders, named by their place under the root (previewLayout.ts treeFolders): kept with the session's
// layout rather than in each folder's rows, so that they outlast the tree, a refresh and a restart.
type Folders = {
  has: (folder: string) => boolean;
  set: (folder: string, open: boolean) => void;
  // Opens these folders (the ones holding the shown file).
  reveal: (folders: string[]) => void;
  // A folder read in full: the open folders right under it that it no longer holds are forgotten.
  prune: (parent: string, present: Set<string>) => void;
};
const keyOf = (path: string) => pathKey(path).replaceAll('\\', '/').replace(/\/$/, '');
const menuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
// The tree's rows in their order on screen, which is the keyboard's order too.
const rowsOf = (from: Element) => [
  ...from.closest('[role="tree"]')!.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
];
// A listing as the desktop gives it; an older one (and some test doubles) gives just the entries.
type Listing = { entries: Entry[]; total: number };
const listing = (value: Listing | Entry[]): Listing =>
  Array.isArray(value) ? { entries: value, total: value.length } : value;

// Rows are the side column's (32px, 8px corners, hover and selected fills across the whole row); the depth only
// moves the row's content, so nested rows are not narrower targets.
function Directory({
  root,
  path,
  folder,
  depth,
  active,
  open,
  surface,
  locate,
  menu,
  draggable,
  folders,
  refresh,
}: {
  root: string;
  path: string;
  // This folder's place under the root ('' for the root itself).
  folder: string;
  depth: number;
  active?: string;
  open: (path: string, temporary: boolean) => void;
  surface: PreviewSurface;
  locate: number;
  menu: OpenMenu;
  // A row can be dragged into the message box, which attaches its path.
  draggable: boolean;
  folders: Folders;
  // The header's 刷新目录: every shown folder reads itself again, and stays open.
  refresh: number;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [total, setTotal] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    // A press of 重试, which lists and watches the folder again.
    [attempt, setAttempt] = useState(0);
  const id = useId();
  // Names compare as the root's file system does: without case on Windows.
  const placeOf = (name: string) => {
    const part = isWindowsPath(root) ? name.toLowerCase() : name;
    return folder ? `${folder}/${part}` : part;
  };
  useEffect(() => {
    if (!active) return;
    folders.reveal(
      entries
        .filter((e) => e.kind === 'directory' && keyOf(active).startsWith(keyOf(e.path) + '/'))
        .map((e) => placeOf(e.name)),
    );
  }, [active, entries, locate]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    void window
      .desktop!.preview.list({ root, path })
      .then(
        (value) => {
          if (disposed) return;
          const { entries, total } = listing(value);
          setEntries(entries);
          setTotal(total);
          // A folder that is gone (or is a file now) is forgotten once its parent is read in full.
          if (total <= entries.length)
            folders.prune(
              folder,
              new Set(entries.filter((e) => e.kind === 'directory').map((e) => placeOf(e.name))),
            );
        },
        (e) => {
          if (!disposed) {
            setError(e.message);
            setEntries([]);
            setTotal(0);
          }
        },
      )
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [root, path, revision, refresh, attempt]);
  useEffect(() => {
    const key = `${surface}:tree:${id}`;
    const stop = window.desktop!.preview.onChanged((e) => {
      if (e.key === key) setRevision((n) => n + 1);
    });
    // At the desktop's limit of watched folders this fails; 重试 (or 刷新目录) asks again, so a folder whose
    // watch could not be kept does not go on silently without its automatic refresh.
    void window.desktop!.preview.watch({ root, path, key }).catch((e) => setError(e.message));
    return () => {
      stop();
      void window.desktop?.preview.unwatch(key);
    };
  }, [root, path, id, surface, refresh, attempt]);
  const indent = { '--tree-depth': depth } as CSSProperties;
  return (
    <>
      {loading && (
        <p className="preview-tree-notice" role="status" style={indent}>
          正在读取目录…
        </p>
      )}
      {error && (
        <div className="preview-tree-notice" role="alert" style={indent}>
          {error}
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
      {!loading && !error && !entries.length && (
        <p className="preview-tree-notice" style={indent}>
          空文件夹
        </p>
      )}
      {total > entries.length && (
        <p className="preview-tree-notice" style={indent}>
          此文件夹有 {total} 项，只显示前 {entries.length} 项
        </p>
      )}
      {entries.map((entry) => {
        const place = placeOf(entry.name);
        const expanded = entry.kind === 'directory' && folders.has(place);
        return (
          <div key={entry.path}>
            <button
              role="treeitem"
              className="preview-tree-item"
              style={indent}
              aria-level={depth + 1}
              aria-label={entry.name}
              aria-selected={keyOf(active ?? '') === keyOf(entry.path)}
              aria-expanded={entry.kind === 'directory' ? expanded : undefined}
              title={entry.path}
              draggable={draggable}
              onDragStart={(event) => {
                event.dataTransfer.setData(pathMime, entry.path);
                event.dataTransfer.setData('text/plain', entry.path);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                menu({ x: event.clientX, y: event.clientY }, entry);
              }}
              // A click opens the file in the temporary tab, a double-click keeps it (preview.ts openFile).
              onDoubleClick={() => {
                if (entry.kind === 'file') open(entry.path, false);
              }}
              onClick={() =>
                entry.kind === 'file' ? open(entry.path, true) : folders.set(place, !expanded)
              }
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                if (menuKey(event)) {
                  event.preventDefault();
                  const box = event.currentTarget.getBoundingClientRect();
                  menu({ x: box.left + 24, y: box.bottom }, entry);
                  return;
                }
                // Enter on the file already shown keeps its tab, as a double-click does.
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  entry.kind === 'file' &&
                  keyOf(active ?? '') === keyOf(entry.path)
                ) {
                  event.preventDefault();
                  open(entry.path, false);
                  return;
                }
                if (event.key === 'ArrowRight' && entry.kind === 'directory') {
                  event.preventDefault();
                  folders.set(place, true);
                  return;
                }
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  // An open folder shuts; a file or a shut folder hands the focus to its folder's row.
                  const group = event.currentTarget.parentElement?.parentElement;
                  if (expanded) folders.set(place, false);
                  else if (group?.getAttribute('role') === 'group')
                    (group.previousElementSibling as HTMLElement | null)?.focus();
                  return;
                }
                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const all = rowsOf(event.currentTarget);
                  const at = all.indexOf(event.currentTarget);
                  all[
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? all.length - 1
                        : Math.max(
                            0,
                            Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)),
                          )
                  ]?.focus();
                  return;
                }
                // A typed letter goes to the next row whose name begins with it, round to the first.
                if (event.key.length === 1 && event.key.trim()) {
                  const letter = event.key.toLowerCase();
                  const all = rowsOf(event.currentTarget);
                  const at = all.indexOf(event.currentTarget);
                  const next = [...all.slice(at + 1), ...all.slice(0, at)].find((row) =>
                    (row.getAttribute('aria-label') ?? '').toLowerCase().startsWith(letter),
                  );
                  if (next) {
                    event.preventDefault();
                    next.focus();
                  }
                }
              }}
            >
              {entry.kind === 'directory' ? (
                expanded ? (
                  <ChevronDown />
                ) : (
                  <ChevronRight />
                )
              ) : (
                <FileText />
              )}
              <span>{entry.name}</span>
            </button>
            {expanded && (
              <div role="group" className="preview-tree-group">
                <Directory
                  root={root}
                  path={entry.path}
                  folder={place}
                  depth={depth + 1}
                  active={active}
                  open={open}
                  surface={surface}
                  locate={locate}
                  menu={menu}
                  draggable={draggable}
                  folders={folders}
                  refresh={refresh}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
export default function PreviewTree({
  root,
  active,
  open,
  surface,
  attach,
  folders: openFolders,
  setFolders,
  quickOpen,
}: {
  root: string;
  active?: string;
  // `temporary`: a single click, which the next one replaces; a double-click opens a kept tab.
  open: (path: string, temporary: boolean) => void;
  surface: PreviewSurface;
  // Puts a path in the message box as an attachment; absent where there is no box to take it.
  attach?: (path: string) => AttachResult;
  // The open folders, kept with the session's layout (preview.ts setFolders).
  folders: string[];
  setFolders: (update: (folders: string[]) => string[]) => void;
  // Opens the box that finds a file by its name (PreviewQuickOpen.tsx).
  quickOpen?: () => void;
}) {
  const [refresh, setRefresh] = useState(0),
    [locate, setLocate] = useState(0);
  const [menu, setMenu] = useState<(MenuPosition & { items: MenuItem[] }) | null>(null);
  const [status, setStatus] = useState({ text: '', revision: 0 });
  const locating = useRef<MutationObserver | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const update = useRef(setFolders);
  update.current = setFolders;
  const folders = useMemo<Folders>(() => {
    const shown = new Set(openFolders);
    const below = (folder: string, parent: string) =>
      folder === parent || folder.startsWith(parent + '/');
    return {
      has: (folder) => shown.has(folder),
      set: (folder, value) =>
        update.current((list) =>
          value
            ? [...list.filter((item) => item !== folder), folder]
            : list.filter((item) => item !== folder),
        ),
      reveal: (wanted) => {
        if (wanted.every((folder) => shown.has(folder))) return;
        update.current((list) => [...list.filter((item) => !wanted.includes(item)), ...wanted]);
      },
      prune: (parent, present) =>
        update.current((list) => {
          const prefix = parent ? parent + '/' : '';
          const gone = list.filter(
            (item) =>
              item.startsWith(prefix) &&
              !item.slice(prefix.length).includes('/') &&
              !present.has(item),
          );
          return gone.length
            ? list.filter((item) => !gone.some((folder) => below(item, folder)))
            : list;
        }),
    };
  }, [openFolders]);
  useEffect(() => {
    if (!status.text) return;
    const timer = setTimeout(() => setStatus((now) => ({ ...now, text: '' })), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  // One row is in the Tab order (a roving tab stop): the one last focused, else the selected one, else the first.
  // The rows come and go as folders are read, so the stop is set again whenever they change.
  useEffect(() => {
    const element = tree.current!;
    let last = '';
    const settle = () => {
      const rows = [...element.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const stop =
        rows.find((row) => row.title === last) ??
        rows.find((row) => row.getAttribute('aria-selected') === 'true') ??
        rows[0];
      for (const row of rows) {
        const index = row === stop ? '0' : '-1';
        if (row.getAttribute('tabindex') !== index) row.setAttribute('tabindex', index);
      }
    };
    const focused = (event: FocusEvent) => {
      const row = (event.target as Element).closest?.<HTMLElement>('[role="treeitem"]');
      if (!row) return;
      last = row.title;
      settle();
    };
    const observer = new element.ownerDocument.defaultView!.MutationObserver(settle);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected'],
    });
    element.addEventListener('focusin', focused);
    settle();
    return () => {
      observer.disconnect();
      element.removeEventListener('focusin', focused);
    };
  }, []);
  const tell = (text: string) => setStatus((now) => ({ text, revision: now.revision + 1 }));
  const act = (action: 'open' | 'reveal', path: string) =>
    void window.desktop!.actOnPath(action, path).then(
      (said) => said && tell(said),
      () => tell('操作失败，请重试。'),
    );
  const copyPath = (path: string) =>
    void copyText(path).then(
      () => tell('已复制路径'),
      () => tell('复制失败，请重试。'),
    );
  const openMenu: OpenMenu = (at, entry) =>
    setMenu({
      ...at,
      items: [
        ...(entry.kind === 'file'
          ? [{ label: '打开并固定', run: () => open(entry.path, false) }]
          : []),
        ...(attach
          ? [
              {
                label: '添加到输入框',
                run: () => {
                  const result = attach(entry.path);
                  if (result !== 'added') tell(attachWords[result]);
                },
              },
            ]
          : []),
        { label: `在${fileManager()}中显示`, run: () => act('reveal', entry.path) },
        { label: '复制路径', run: () => copyPath(entry.path) },
      ],
    });
  useEffect(
    () => () => {
      locating.current?.disconnect();
      locating.current = null;
    },
    [root, active],
  );
  return (
    <section className="preview-tree" aria-label="工作区目录">
      {/* As tall as the tab row beside it, so the two hairlines meet; the folder's name is a group heading. */}
      <header>
        <span title={root}>{root.split(/[\\/]/).filter(Boolean).at(-1)}</span>
        {quickOpen && (
          <IconButton title="按名称打开文件" size="xs" onClick={quickOpen}>
            <Search />
          </IconButton>
        )}
        <IconButton
          title="定位当前文件"
          size="xs"
          onClick={(event) => {
            const tree = event.currentTarget.closest('.preview-tree')!;
            locating.current?.disconnect();
            locating.current = null;
            setLocate((n) => n + 1);
            const scroll = () => {
              const selected = tree.querySelector<HTMLElement>('[aria-selected="true"]');
              if (!selected) return false;
              selected.scrollIntoView({ block: 'nearest' });
              locating.current?.disconnect();
              locating.current = null;
              return true;
            };
            if (!scroll()) {
              locating.current = new tree.ownerDocument.defaultView!.MutationObserver(scroll);
              locating.current.observe(tree, { childList: true, subtree: true });
            }
          }}
        >
          <Crosshair />
        </IconButton>
        <IconButton title={`在${fileManager()}中打开`} size="xs" onClick={() => act('open', root)}>
          <ExternalLink />
        </IconButton>
        {/* Every shown folder reads itself again; open folders stay open. */}
        <IconButton title="刷新目录" size="xs" onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw />
        </IconButton>
      </header>
      <div ref={tree} role="tree" aria-label="工作区文件">
        <Directory
          key={root}
          root={root}
          path={root}
          folder=""
          depth={0}
          active={active}
          open={open}
          surface={surface}
          locate={locate}
          menu={openMenu}
          draggable={!!attach}
          folders={folders}
          refresh={refresh}
        />
      </div>
      <p className="preview-tree-status" role="status">
        {status.text}
      </p>
      {menu && <Menu label="文件操作" {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}
