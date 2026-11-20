import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  ExternalLink,
  FileText,
  RefreshCw,
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
const keyOf = (path: string) => pathKey(path).replaceAll('\\', '/').replace(/\/$/, '');
const menuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');

// Rows are the side column's (32px, 8px corners, hover and selected fills across the whole row); the depth only
// moves the row's content, so nested rows are not narrower targets.
function Directory({
  root,
  path,
  depth,
  active,
  open,
  surface,
  locate,
  menu,
  draggable,
}: {
  root: string;
  path: string;
  depth: number;
  active?: string;
  open: (path: string, temporary: boolean) => void;
  surface: PreviewSurface;
  locate: number;
  menu: OpenMenu;
  // A row can be dragged into the message box, which attaches its path.
  draggable: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const id = useId();
  useEffect(() => {
    if (!active) return;
    setExpanded(
      (current) =>
        new Set([
          ...current,
          ...entries
            .filter((e) => e.kind === 'directory' && keyOf(active).startsWith(keyOf(e.path) + '/'))
            .map((e) => e.path),
        ]),
    );
  }, [active, entries, locate]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    void window
      .desktop!.preview.list({ root, path })
      .then(
        (values) => {
          if (!disposed) setEntries(values);
        },
        (e) => {
          if (!disposed) {
            setError(e.message);
            setEntries([]);
          }
        },
      )
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [root, path, revision]);
  useEffect(() => {
    const key = `${surface}:tree:${id}`;
    const stop = window.desktop!.preview.onChanged((e) => {
      if (e.key === key) setRevision((n) => n + 1);
    });
    void window.desktop!.preview.watch({ root, path, key }).catch((e) => setError(e.message));
    return () => {
      stop();
      void window.desktop?.preview.unwatch(key);
    };
  }, [root, path, id, surface]);
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
          <Button size="sm" onClick={() => setRevision((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
      {!loading && !error && !entries.length && (
        <p className="preview-tree-notice" style={indent}>
          空文件夹
        </p>
      )}
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            role="treeitem"
            className="preview-tree-item"
            style={indent}
            aria-level={depth + 1}
            aria-label={entry.name}
            aria-selected={keyOf(active ?? '') === keyOf(entry.path)}
            aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined}
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
              entry.kind === 'file'
                ? open(entry.path, true)
                : setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  })
            }
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              if (menuKey(event)) {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                menu({ x: box.left + 24, y: box.bottom }, entry);
                return;
              }
              if (entry.kind === 'directory' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault();
                setExpanded((old) => {
                  const next = new Set(old);
                  if (event.key === 'ArrowRight') next.add(entry.path);
                  else next.delete(entry.path);
                  return next;
                });
              }
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const all = [
                  ...event.currentTarget
                    .closest('[role="tree"]')!
                    .querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
                ];
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
              }
            }}
          >
            {entry.kind === 'directory' ? (
              expanded.has(entry.path) ? (
                <ChevronDown />
              ) : (
                <ChevronRight />
              )
            ) : (
              <FileText />
            )}
            <span>{entry.name}</span>
          </button>
          {entry.kind === 'directory' && expanded.has(entry.path) && (
            <div role="group" className="preview-tree-group">
              <Directory
                root={root}
                path={entry.path}
                depth={depth + 1}
                active={active}
                open={open}
                surface={surface}
                locate={locate}
                menu={menu}
                draggable={draggable}
              />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
export default function PreviewTree({
  root,
  active,
  open,
  surface,
  attach,
}: {
  root: string;
  active?: string;
  // `temporary`: a single click, which the next one replaces; a double-click opens a kept tab.
  open: (path: string, temporary: boolean) => void;
  surface: PreviewSurface;
  // Puts a path in the message box as an attachment; absent where there is no box to take it.
  attach?: (path: string) => AttachResult;
}) {
  const [revision, setRevision] = useState(0),
    [locate, setLocate] = useState(0);
  const [menu, setMenu] = useState<(MenuPosition & { items: MenuItem[] }) | null>(null);
  const [status, setStatus] = useState({ text: '', revision: 0 });
  const locating = useRef<MutationObserver | null>(null);
  useEffect(() => {
    if (!status.text) return;
    const timer = setTimeout(() => setStatus((now) => ({ ...now, text: '' })), 2000);
    return () => clearTimeout(timer);
  }, [status]);
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
        <IconButton title="刷新目录" size="xs" onClick={() => setRevision((n) => n + 1)}>
          <RefreshCw />
        </IconButton>
      </header>
      <div role="tree" aria-label="工作区文件">
        <Directory
          key={`${root}:${revision}`}
          root={root}
          path={root}
          depth={0}
          active={active}
          open={open}
          surface={surface}
          locate={locate}
          menu={openMenu}
          draggable={!!attach}
        />
      </div>
      <p className="preview-tree-status" role="status">
        {status.text}
      </p>
      {menu && <Menu label="文件操作" {...menu} onClose={() => setMenu(null)} />}
    </section>
  );
}
