import { useEffect, useId, useRef, useState } from 'react';
import { Button, IconButton } from './ui.tsx';
import { ChevronDown, ChevronRight, FileText, FolderOpen, RefreshCw } from './icons.tsx';
import type { PreviewSurface } from './preview.ts';
import { pathKey } from './paths.ts';
type Entry = { name: string; path: string; kind: 'file' | 'directory' };
const keyOf = (path: string) => pathKey(path).replaceAll('\\', '/').replace(/\/$/, '');

function Directory({
  root,
  path,
  active,
  open,
  surface,
  locate,
}: {
  root: string;
  path: string;
  active?: string;
  open: (path: string) => void;
  surface: PreviewSurface;
  locate: number;
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
  return (
    <>
      {loading && (
        <p className="preview-tree-notice" role="status">
          正在读取目录…
        </p>
      )}
      {error && (
        <div className="preview-tree-notice" role="alert">
          {error}
          <Button size="sm" onClick={() => setRevision((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
      {!loading && !error && !entries.length && <p className="preview-tree-notice">空文件夹</p>}
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            role="treeitem"
            className="preview-tree-item"
            aria-label={entry.name}
            aria-selected={keyOf(active ?? '') === keyOf(entry.path)}
            aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined}
            title={entry.path}
            onClick={() =>
              entry.kind === 'file'
                ? open(entry.path)
                : setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  })
            }
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
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
                <ChevronDown scale="xs" />
              ) : (
                <ChevronRight scale="xs" />
              )
            ) : (
              <FileText scale="xs" />
            )}
            <span>{entry.name}</span>
          </button>
          {entry.kind === 'directory' && expanded.has(entry.path) && (
            <div role="group" className="preview-tree-group">
              <Directory
                root={root}
                path={entry.path}
                active={active}
                open={open}
                surface={surface}
                locate={locate}
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
}: {
  root: string;
  active?: string;
  open: (path: string) => void;
  surface: PreviewSurface;
}) {
  const [revision, setRevision] = useState(0),
    [locate, setLocate] = useState(0);
  const locating = useRef<MutationObserver | null>(null);
  useEffect(
    () => () => {
      locating.current?.disconnect();
      locating.current = null;
    },
    [root, active],
  );
  return (
    <section className="preview-tree" aria-label="工作区目录">
      <header>
        <FolderOpen scale="sm" />
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
          <FileText />
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
          active={active}
          open={open}
          surface={surface}
          locate={locate}
        />
      </div>
    </section>
  );
}
