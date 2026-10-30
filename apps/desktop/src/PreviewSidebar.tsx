import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FileCode,
  FileText,
  ExternalLink,
  FolderOpen,
  Globe,
  Image,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from './icons.tsx';
import { Button, IconButton, Modal } from './ui.tsx';
import RichText, { CodeBlock } from './RichText.tsx';
import { CopyButton } from './copy.tsx';
import { LinkPlace, linkTarget } from './links.ts';
import { followLink } from './linkActions.ts';
import { previewWebsite } from './preview.ts';
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
const iconOf = (tab: PreviewTab) =>
  tab.kind === 'web'
    ? Globe
    : /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(tab.target)
      ? Image
      : /\.(html?|[cm]?js|jsx|tsx?|json|css|py|sh|ps1)$/i.test(tab.target)
        ? FileCode
        : FileText;

function NativePreview({
  tab,
  url,
  surface,
  onError,
}: {
  tab: PreviewTab;
  url: string;
  surface: PreviewSurface;
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
    const update = () => {
      frame = 0;
      if (disposed) return;
      const rect = element.getBoundingClientRect();
      const covered =
        !!doc.querySelector('[data-preview-resizing], [data-sidebar-resizing]') ||
        [
          ...doc.querySelectorAll(
            'dialog[open], .menu, .terminal-list, .sidebar-shade, .preview-full',
          ),
        ].some((overlay) => {
          if (overlay.contains(element)) return false;
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
        void api.show({ surface, key: tab.id, url, bounds }).catch((e) => error.current(e.message));
      } else if (started) void api.bounds({ surface, bounds }).catch(() => {});
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const changes = new MutationObserver(schedule);
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
      void window.desktop?.preview.hide(surface).catch(() => {});
    };
  }, [tab.id, url, surface]);
  return <div ref={ref} className="preview-native" aria-label="网页预览区域" />;
}

function PreviewContent({
  tab,
  surface,
  workspace,
}: {
  tab: PreviewTab;
  surface: PreviewSurface;
  workspace: PreviewWorkspace;
}) {
  const [file, setFile] = useState<PreviewFile | null>(null);
  const [error, setError] = useState('');
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
      {(error || browser?.error) && (
        <p className="preview-error" role="alert">
          {error || browser?.error}
        </p>
      )}
      {native && (tab.kind === 'web' || file?.url) ? (
        <NativePreview
          tab={tab}
          url={tab.kind === 'web' ? tab.target : file!.url!}
          surface={surface}
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
            if (link && !workspace.follow(link, tab.root)) void followLink(link, setError);
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

export default function PreviewSidebar({
  workspace,
  surface = 'main',
  root,
}: {
  workspace: PreviewWorkspace;
  surface?: PreviewSurface;
  root?: string;
}) {
  const [website, setWebsite] = useState(false);
  const [url, setUrl] = useState('http://localhost:5173');
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const { width, resize: setWidth } = workspace;
  const contentId = useId();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resizeHandle = useRef<HTMLDivElement>(null);
  const active = workspace.tabs.find((tab) => tab.id === workspace.active);
  const closeWebsite = () => {
    setWebsite(false);
    setError('');
  };
  useLayoutEffect(() => {
    resizeHandle.current?.parentElement
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [workspace.active]);
  const collapse = () => {
    const aside = resizeHandle.current?.parentElement;
    const trigger =
      aside
        ?.closest('.terminal-preview-layout')
        ?.querySelector<HTMLButtonElement>('[data-preview-toggle]') ??
      aside?.ownerDocument.querySelector<HTMLButtonElement>('.titlebar [data-preview-toggle]');
    workspace.collapse();
    trigger?.focus();
  };
  useEffect(() => {
    const handle = resizeHandle.current!;
    const win = handle.ownerDocument.defaultView!;
    const finish = () => {
      drag.current = null;
      handle.parentElement?.removeAttribute('data-preview-resizing');
    };
    win.addEventListener('blur', finish);
    return () => {
      win.removeEventListener('blur', finish);
      finish();
    };
  }, []);
  useEffect(
    () => () => {
      void window.desktop?.preview.hide(surface).catch(() => {});
    },
    [surface],
  );
  const pick = async () => {
    setError('');
    try {
      const path = await window.desktop!.preview.pick(surface);
      if (path) workspace.openFile(path, root);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法打开文件。');
    }
  };
  return (
    <aside
      className={`preview-sidebar ${full ? 'preview-full' : ''}`}
      style={{ '--preview-width': `${width}px` } as CSSProperties}
      aria-label="文件与网站预览"
    >
      <div
        ref={resizeHandle}
        className="preview-resize"
        role="separator"
        aria-label="调整预览宽度"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={900}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width };
          event.currentTarget.parentElement?.setAttribute('data-preview-resizing', '');
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setWidth(
              Math.max(320, Math.min(900, drag.current.width + drag.current.x - event.clientX)),
            );
        }}
        onPointerUp={() => {
          drag.current = null;
          resizeHandle.current?.parentElement?.removeAttribute('data-preview-resizing');
        }}
        onPointerCancel={() => {
          drag.current = null;
          resizeHandle.current?.parentElement?.removeAttribute('data-preview-resizing');
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          resizeHandle.current?.parentElement?.removeAttribute('data-preview-resizing');
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            setWidth((value) =>
              event.key === 'Home'
                ? 320
                : event.key === 'End'
                  ? 900
                  : Math.max(320, Math.min(900, value + (event.key === 'ArrowLeft' ? 20 : -20))),
            );
          }
        }}
      />
      <header className="preview-heading">
        <strong>预览</strong>
        <div className="preview-heading-actions">
          <IconButton title="打开本机文件" size="sm" onClick={() => void pick()}>
            <FolderOpen />
          </IconButton>
          <IconButton
            title="打开本机网站"
            size="sm"
            onClick={() => {
              setError('');
              setWebsite(true);
            }}
          >
            <Globe />
          </IconButton>
          <Button
            size="sm"
            variant="ghost"
            aria-label={full ? '还原预览' : '放大预览'}
            onClick={() => setFull((value) => !value)}
          >
            {full ? '还原' : '放大'}
          </Button>
          <IconButton title="收起预览" size="sm" onClick={collapse}>
            <X />
          </IconButton>
        </div>
      </header>
      {!!workspace.tabs.length && (
        <div className="preview-tabs" role="tablist" aria-label="预览标签">
          {workspace.tabs.map((tab) => {
            const Icon = iconOf(tab);
            return (
              <div key={tab.id} className={`preview-tab ${tab.id === active?.id ? 'active' : ''}`}>
                <button
                  role="tab"
                  aria-selected={tab.id === active?.id}
                  aria-controls={contentId}
                  tabIndex={tab.id === active?.id ? 0 : -1}
                  onClick={() => workspace.select(tab.id)}
                  onKeyDown={(event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const at = workspace.tabs.findIndex((item) => item.id === tab.id);
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? workspace.tabs.length - 1
                          : (at + (event.key === 'ArrowRight' ? 1 : -1) + workspace.tabs.length) %
                            workspace.tabs.length;
                    workspace.select(workspace.tabs[next].id);
                    event.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                      [next]?.focus();
                  }}
                  title={tab.target}
                >
                  <Icon scale="xs" />
                  <span>{nameOf(tab)}</span>
                </button>
                <IconButton
                  title={`关闭预览 ${nameOf(tab)}`}
                  size="xs"
                  onClick={() => {
                    const aside = resizeHandle.current?.parentElement;
                    workspace.close(tab.id);
                    aside?.ownerDocument.defaultView?.requestAnimationFrame(() => {
                      (
                        aside.querySelector<HTMLButtonElement>(
                          '[role="tab"][aria-selected="true"]',
                        ) ?? aside.querySelector<HTMLButtonElement>('[aria-label="打开本机文件"]')
                      )?.focus();
                    });
                  }}
                >
                  <X />
                </IconButton>
              </div>
            );
          })}
        </div>
      )}
      {error && !website && (
        <p role="alert" className="preview-error">
          {error}
        </p>
      )}
      <div
        id={contentId}
        className="preview-content"
        role="tabpanel"
        aria-label={active ? nameOf(active) : '预览内容'}
      >
        {active ? (
          <PreviewContent key={active.id} tab={active} surface={surface} workspace={workspace} />
        ) : (
          <div className="preview-empty">
            <FolderOpen />
            <h2>在这里查看成果</h2>
            <p>打开本机文件，或预览已启动的本机网站。</p>
            <div className="preview-empty-actions">
              <Button variant="primary" onClick={() => void pick()}>
                <Plus />
                打开文件
              </Button>
              <Button
                onClick={() => {
                  setError('');
                  setWebsite(true);
                }}
              >
                <Globe />
                打开本机网站
              </Button>
            </div>
          </div>
        )}
      </div>
      {website && (
        <Modal title="打开本机网站" onClose={closeWebsite} initialFocus="input">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const target = previewWebsite(url);
              if (!target) {
                setError('请输入 localhost、127.0.0.1 或 [::1] 的 HTTP(S) 地址。');
                return;
              }
              workspace.openWebsite(target);
              setWebsite(false);
              setError('');
            }}
          >
            <label>
              网站地址
              <input value={url} onChange={(e) => setUrl(e.target.value)} required />
            </label>
            <p>请先在 Windows 启动开发服务，再输入对应地址。</p>
            {error && <p role="alert">{error}</p>}
            <div className="dialog-actions">
              <Button onClick={closeWebsite}>取消</Button>
              <Button type="submit" variant="primary">
                打开预览
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </aside>
  );
}
