import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from './icons.tsx';
import { Button, IconButton } from './ui.tsx';
import RichText, { CodeBlock } from './RichText.tsx';
import { CopyButton } from './copy.tsx';
import { LinkPlace, linkTarget } from './links.ts';
import { followLink } from './linkActions.ts';
import { previewWebsite } from './preview.ts';
import { isInside } from './paths.ts';
import type {
  PreviewBrowserState,
  PreviewFile,
  PreviewSurface,
  PreviewTab,
  PreviewWorkspace,
} from './preview.ts';

const nameOf = (tab: PreviewTab) =>
  tab.kind === 'file' ? tab.target.split(/[\\/]/).pop()! : tab.target.replace(/^https?:\/\//, '');
const parentOf = (path: string) =>
  path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
const languageOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? 'text';
const PreviewPdf = lazy(() => import('./PreviewPdf.tsx'));
const previewOverlays =
  'dialog[open], .menu, .terminal-list, .sidebar-shade, .preview-full, .preview-pane-floating, .quote-selection-toolbar, [role="dialog"], [role="alertdialog"], [role="menu"]';

function NativePreview({
  tab,
  url,
  surface,
  pane,
  onError,
}: {
  tab: PreviewTab;
  url: string;
  surface: PreviewSurface;
  pane: string;
  onError: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const error = useRef(onError);
  error.current = onError;
  useLayoutEffect(() => {
    const element = ref.current!;
    const doc = element.ownerDocument;
    const win = doc.defaultView!;
    let started = false,
      frame = 0,
      disposed = false,
      previous = '';
    let knownOverlays = new WeakSet<Element>();
    const update = () => {
      frame = 0;
      if (disposed) return;
      const rect = element.getBoundingClientRect();
      const overlays = [...doc.querySelectorAll(previewOverlays)];
      // Remember prior matches so removing an overlay's class in place also restores the view.
      knownOverlays = new WeakSet(overlays);
      const covered =
        !!doc.querySelector('[data-preview-resizing], [data-sidebar-resizing]') ||
        overlays.some((overlay) => {
          if (overlay.contains(element)) return false;
          const ownFloat = element.closest('.preview-pane-floating');
          if (ownFloat && overlay.matches('.preview-full')) return false;
          if (ownFloat && overlay.matches('.preview-pane-floating')) {
            const overlayZ = Number(win.getComputedStyle(overlay).zIndex) || 0;
            const ownZ = Number(win.getComputedStyle(ownFloat).zIndex) || 0;
            if (
              overlayZ < ownZ ||
              (overlayZ === ownZ && !(ownFloat.compareDocumentPosition(overlay) & 4))
            )
              return false;
          }
          const area = overlay.getBoundingClientRect();
          return (
            area.width &&
            area.height &&
            area.left < rect.right &&
            area.right > rect.left &&
            area.top < rect.bottom &&
            area.bottom > rect.top
          );
        });
      const bounds =
        rect.width && rect.height && !covered
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      const signature = JSON.stringify(bounds);
      if (signature === previous) return;
      previous = signature;
      const api = window.desktop!.preview;
      if (!started && bounds) {
        started = true;
        void api
          .show({ surface, pane, key: tab.id, url, bounds })
          .catch((e) => error.current(e.message));
      } else if (started) void api.bounds({ surface, pane, bounds }).catch(() => {});
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const changes = new MutationObserver((records) => {
      // Streaming text and draft edits do not move this separate viewport. Its ResizeObserver and
      // scroll listener cover geometry changes; keep inspecting actual overlays, including removals.
      const changed = records.some((record) => {
        const target =
          record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
        if (
          !target?.closest('.conversation, .composer-input') ||
          target.closest(previewOverlays) ||
          knownOverlays.has(target)
        )
          return true;
        if (
          record.type === 'attributes' &&
          (record.attributeName === 'role' || record.attributeName === 'open')
        )
          return true;
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node.nodeType === 1 &&
            ((node as Element).matches(previewOverlays) ||
              !!(node as Element).querySelector(previewOverlays)),
        );
      });
      if (changed) schedule();
    });
    changes.observe(doc.body, { subtree: true, attributes: true, childList: true });
    win.addEventListener('resize', schedule);
    doc.addEventListener('scroll', schedule, true);
    update();
    return () => {
      disposed = true;
      win.cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      win.removeEventListener('resize', schedule);
      doc.removeEventListener('scroll', schedule, true);
      void window.desktop?.preview.hide(surface, pane).catch(() => {});
    };
  }, [tab.id, url, surface, pane]);
  return <div ref={ref} className="preview-native" aria-label="网页预览区域" />;
}

export default function PreviewContent({
  tab,
  surface,
  workspace,
  pane,
}: {
  tab: PreviewTab;
  surface: PreviewSurface;
  workspace: PreviewWorkspace;
  pane: string;
}) {
  const [file, setFile] = useState<PreviewFile | null>(null);
  const [error, setError] = useState('');
  const [watchError, setWatchError] = useState('');
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [browser, setBrowser] = useState<PreviewBrowserState | null>(null);
  const [address, setAddress] = useState(tab.target);
  const editingAddress = useRef(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  useLayoutEffect(
    () =>
      window.desktop!.preview.onState((state) => {
        if (state.surface !== surface || state.key !== tab.id) return;
        if (state.open) {
          if (state.open.kind === 'file')
            workspaceRef.current.openFile(
              state.open.target,
              state.open.root,
              state.open.restricted,
            );
          else workspaceRef.current.openWebsite(state.open.target);
          return;
        }
        setBrowser((previous) => ({
          ...state,
          error: state.error || (state.loading ? '' : (previous?.error ?? '')),
        }));
        if (state.url && !editingAddress.current) setAddress(state.url);
      }),
    [tab.id, surface],
  );
  useEffect(() => {
    if (tab.kind !== 'file') return;
    let disposed = false,
      token: string | undefined;
    setFile(null);
    setError('');
    void window
      .desktop!.preview.read({ path: tab.target, root: tab.root, restricted: tab.restricted })
      .then(
        (result) => {
          token = result.token;
          if (disposed) {
            if (token) void window.desktop!.preview.releaseFile(token);
            return;
          }
          setFile(result);
        },
        (e) => {
          if (!disposed) setError(e.message);
        },
      );
    return () => {
      disposed = true;
      if (token) void window.desktop!.preview.releaseFile(token);
      void window.desktop!.preview.release({ surface, key: tab.id }).catch(() => {});
    };
  }, [tab.id, tab.kind, tab.target, tab.root, tab.restricted, revision, surface]);
  const watchPath = file?.path ?? tab.target;
  const watchRoot =
    tab.restricted || (tab.root && isInside(watchPath, [tab.root]))
      ? (tab.root ?? parentOf(watchPath))
      : parentOf(watchPath);
  useEffect(() => {
    if (tab.kind !== 'file' || !window.desktop?.preview.watch) return;
    let disposed = false;
    setWatchError('');
    const key = `${surface}:file:${tab.id}`;
    const stop = window.desktop.preview.onChanged((event) => {
      if (event.key === key) setRevision((value) => value + 1);
    });
    void window.desktop.preview
      .watch({ key, path: watchPath, root: watchRoot, file: true })
      .catch((e) => {
        if (!disposed) setWatchError(`自动刷新不可用：${e.message}`);
      });
    return () => {
      disposed = true;
      stop();
      void window.desktop?.preview.unwatch(key);
    };
  }, [tab.id, tab.kind, watchPath, watchRoot, surface]);
  const native = tab.kind === 'web' || (file?.kind === 'html' && !source);
  const switchable =
    tab.kind === 'file' &&
    (file
      ? ['html', 'markdown'].includes(file.kind)
      : /\.(?:html?|md|markdown)$/i.test(tab.target));
  const action = (action: 'back' | 'forward' | 'reload') => {
    setError('');
    void window
      .desktop!.preview.action({ surface, key: tab.id, action })
      .catch((e) => setError(e.message));
  };
  return (
    <>
      <div className="preview-toolbar">
        {tab.kind === 'web' ? (
          <>
            <IconButton
              title="预览后退"
              size="sm"
              disabled={!browser?.back}
              onClick={() => action('back')}
            >
              <ArrowLeft />
            </IconButton>
            <IconButton
              title="预览前进"
              size="sm"
              disabled={!browser?.forward}
              onClick={() => action('forward')}
            >
              <ArrowRight />
            </IconButton>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const url = previewWebsite(address);
                if (!url) {
                  setError('请输入本机网站地址，例如 http://localhost:5173。');
                  return;
                }
                setError('');
                editingAddress.current = false;
                event.currentTarget.querySelector('input')?.blur();
                void window
                  .desktop!.preview.action({ surface, key: tab.id, action: 'go', url })
                  .catch((e) => setError(e.message));
              }}
            >
              <input
                aria-label="预览地址"
                value={address}
                onFocus={() => {
                  editingAddress.current = true;
                }}
                onBlur={() => {
                  editingAddress.current = false;
                  if (browser?.url) setAddress(browser.url);
                }}
                onChange={(e) => setAddress(e.target.value)}
              />
            </form>
          </>
        ) : (
          <span className="preview-path" title={file?.path ?? tab.target}>
            {file?.path ?? tab.target}
          </span>
        )}
        <IconButton
          title="刷新预览"
          size="sm"
          onClick={() =>
            tab.kind === 'web' ? action('reload') : setRevision((value) => value + 1)
          }
        >
          <RefreshCw className={browser?.loading && native ? 'spinning' : ''} />
        </IconButton>
        <CopyButton
          label={tab.kind === 'web' ? '复制网站地址' : '复制文件路径'}
          text={() =>
            tab.kind === 'web' ? browser?.url || tab.target : (file?.path ?? tab.target)
          }
        />
        {switchable && (
          <Button
            size="sm"
            variant="ghost"
            title={source ? '切换到预览' : '查看源码'}
            disabled={!file}
            onClick={() => setSource((value) => !value)}
          >
            {source ? '预览' : '源码'}
          </Button>
        )}
        <IconButton
          title="在系统应用中打开"
          size="sm"
          onClick={() => {
            setError('');
            if (tab.kind === 'web')
              void window
                .desktop!.openLink(previewWebsite(browser?.url || tab.target) ?? tab.target)
                .catch((e) => setError(e.message));
            else
              void window.desktop!.actOnPath('open', tab.target).then(
                (message) => {
                  if (message) setError(message);
                },
                (e) => setError(e.message),
              );
          }}
        >
          <ExternalLink />
        </IconButton>
      </div>
      {(error || browser?.error || watchError) && (
        <p className="preview-error" role="alert">
          {error || browser?.error || watchError}
        </p>
      )}
      {file?.kind === 'html' && workspace.restoredTabs.has(tab.id) ? (
        <div className="preview-empty">
          <FileText />
          <p>已恢复 HTML 标签。点击后加载页面。</p>
          <Button onClick={() => workspace.activate(tab.id)}>加载此预览</Button>
        </div>
      ) : file?.kind === 'pdf' ? (
        <Suspense
          fallback={
            <p role="status" className="preview-loading">
              正在打开 PDF…
            </p>
          }
        >
          <PreviewPdf data={file.data!} missingFonts={file.missingFonts} />
        </Suspense>
      ) : native && (tab.kind === 'web' || file?.url) ? (
        <NativePreview
          tab={tab}
          url={tab.kind === 'web' ? tab.target : file!.url!}
          surface={surface}
          pane={pane}
          onError={setError}
        />
      ) : (
        <div
          className="preview-document"
          onClick={(event) => {
            const anchor = (event.target as HTMLElement).closest('a[data-link]');
            if (!anchor) return;
            event.preventDefault();
            const link = linkTarget(anchor.getAttribute('data-link')!, {
              projectPath: parentOf(file?.path ?? tab.target),
              here: true,
              browser: false,
            });
            if (link && !workspace.follow(link, tab.root, tab.restricted))
              void followLink(link, setError);
          }}
        >
          {!file && !error && (
            <div className="preview-loading" role="status">
              <LoaderCircle className="spinning" />
              正在读取文件…
            </div>
          )}
          {!file && error && (
            <div className="preview-unavailable">
              <FileText />
              <p>暂时无法预览此文件</p>
            </div>
          )}
          {file?.kind === 'image' ? (
            <>
              <div className="preview-image-tools">
                <Button
                  size="sm"
                  disabled={zoom <= 0.25}
                  onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}
                >
                  缩小
                </Button>
                <Button size="sm" title="恢复原始比例" onClick={() => setZoom(1)}>
                  {Math.round(zoom * 100)}%
                </Button>
                <Button
                  size="sm"
                  disabled={zoom >= 4}
                  onClick={() => setZoom((value) => Math.min(4, value + 0.25))}
                >
                  放大
                </Button>
              </div>
              <img className="preview-image" src={file.image} alt={nameOf(tab)} style={{ zoom }} />
            </>
          ) : file?.kind === 'markdown' && !source ? (
            <LinkPlace.Provider
              value={{ projectPath: parentOf(file.path), here: true, browser: false }}
            >
              <div className="message-content preview-markdown">
                <RichText text={file.text!} />
              </div>
            </LinkPlace.Provider>
          ) : (
            file && (
              <div className="message-content preview-code">
                <CodeBlock>
                  <code className={`language-${languageOf(file.path)}`}>{file.text}</code>
                </CodeBlock>
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}
