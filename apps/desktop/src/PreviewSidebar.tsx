import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { FileText, FolderOpen, Globe, Plus, X } from './icons.tsx';
import { Button, IconButton, Modal } from './ui.tsx';
import { previewWebsite } from './preview.ts';
import type { PreviewSurface, PreviewWorkspace } from './preview.ts';
import PreviewTree from './PreviewTree.tsx';
import PreviewPaneView from './PreviewPane.tsx';

export default function PreviewSidebar({
  workspace,
  surface = 'main',
  root,
  filesAvailable = true,
  renderChat,
}: {
  workspace: PreviewWorkspace;
  surface?: PreviewSurface;
  root?: string;
  filesAvailable?: boolean;
  renderChat?: (tab: import('./preview.ts').PreviewTab) => ReactNode;
}) {
  const [website, setWebsite] = useState(false);
  const [url, setUrl] = useState('http://localhost:5173');
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const [ownerDocument, setOwnerDocument] = useState<Document>(() => document);
  const { width, resize: setWidth } = workspace;
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resizeHandle = useRef<HTMLDivElement>(null);
  const paneElements = useRef(new Map<string, HTMLElement>());
  const registerPane = (id: string, element: HTMLElement | null) => {
    if (element) paneElements.current.set(id, element);
    else paneElements.current.delete(id);
  };
  const focusPane = (id: string) => {
    const panes = paneElements.current;
    const pane = panes.get(id) ?? panes.get(workspace.focused) ?? panes.values().next().value;
    const tab = pane?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    (
      tab ??
      resizeHandle.current?.parentElement?.querySelector<HTMLButtonElement>(
        '.preview-heading button',
      )
    )?.focus();
  };
  useEffect(() => {
    if (!filesAvailable) {
      setWebsite(false);
      setError('');
    }
  }, [filesAvailable]);
  const active = workspace.tabs.find((tab) => tab.id === workspace.active);
  const closeWebsite = () => {
    setWebsite(false);
    setError('');
  };
  useLayoutEffect(() => {
    if (resizeHandle.current) setOwnerDocument(resizeHandle.current.ownerDocument);
  }, []);
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
          {root && (
            <IconButton
              title="工作区目录"
              size="sm"
              aria-pressed={workspace.tree}
              onClick={workspace.toggleTree}
            >
              <FileText />
            </IconButton>
          )}
          <IconButton
            title="打开本机文件"
            size="sm"
            disabled={!filesAvailable}
            onClick={() => void pick()}
          >
            <FolderOpen />
          </IconButton>
          <IconButton
            title="打开本机网站"
            disabled={!filesAvailable}
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
      {error && !website && (
        <p role="alert" className="preview-error">
          {error}
        </p>
      )}
      <div className="preview-workarea">
        {workspace.tree && root && (
          <PreviewTree
            root={root}
            active={active?.target}
            open={(path) => workspace.openFile(path, root, true)}
            surface={surface}
          />
        )}
        <div className="preview-panes">
          {workspace.panes.map((pane) => (
            <PreviewPaneView
              key={pane.id}
              pane={pane}
              doc={ownerDocument}
              renderChat={renderChat}
              filesAvailable={filesAvailable}
              register={registerPane}
              focus={focusPane}
              workspace={workspace}
              surface={surface}
              empty={
                <div className="preview-empty">
                  <FolderOpen />
                  <h2>在这里查看成果</h2>
                  <p>选择目录中的文件，或打开本机文件。</p>
                  <Button onClick={() => void pick()}>
                    <Plus />
                    打开文件
                  </Button>
                </div>
              }
            />
          ))}
        </div>
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
