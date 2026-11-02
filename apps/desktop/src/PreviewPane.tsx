import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './ui.tsx';
import {
  ArrowLeftRight,
  Columns2,
  FileText,
  Globe,
  MessageSquare,
  PanelDock,
  PictureInPicture,
  X,
} from './icons.tsx';
import PreviewContent from './PreviewContent.tsx';
import { usePrefs } from './prefs.ts';
import { fitFloat } from './previewLayout.ts';
import type { PreviewPane, PreviewSurface, PreviewWorkspace, FloatRect } from './preview.ts';
const name = (target: string) => target.split(/[\\/]/).pop() || target;
const mime = 'application/x-cc-preview-tab';
export default function PreviewPaneView({
  pane,
  workspace,
  surface,
  empty,
  doc,
  renderChat,
  filesAvailable = true,
  register,
  focus,
  actions,
}: {
  pane: PreviewPane;
  workspace: PreviewWorkspace;
  surface: PreviewSurface;
  empty: ReactNode;
  doc: Document;
  renderChat?: (tab: import('./preview.ts').PreviewTab) => ReactNode;
  filesAvailable?: boolean;
  register: (id: string, element: HTMLElement | null) => void;
  focus: (id: string) => void;
  // The preview's own controls (the tree, opening, enlarging, closing), carried by the first docked pane's row.
  actions?: ReactNode;
}) {
  const viewport = doc.defaultView ?? window;
  const { fontSizes } = usePrefs();
  const [size, setSize] = useState(() => ({
    width: viewport.innerWidth,
    height: viewport.innerHeight,
  }));
  useEffect(() => {
    const update = () => setSize({ width: viewport.innerWidth, height: viewport.innerHeight });
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  }, [viewport]);
  const content = useId(),
    handle = useRef<{ x: number; y: number; rect: FloatRect; resize: boolean } | null>(null);
  const active = workspace.tabs.find((t) => t.id === pane.active);
  const tabs = pane.tabs.map((id) => workspace.tabs.find((t) => t.id === id)!).filter(Boolean);
  const minHeight = active?.kind === 'chat' ? 30 * fontSizes.interface : 180;
  const floating = pane.floating
    ? fitFloat(
        { ...pane.floating, height: Math.max(minHeight, pane.floating.height) },
        size.width,
        size.height,
      )
    : undefined;
  useEffect(() => {
    const finish = () => {
      handle.current = null;
      doc.body.removeAttribute('data-preview-resizing');
    };
    viewport.addEventListener('blur', finish);
    return () => {
      viewport.removeEventListener('blur', finish);
      finish();
    };
  }, [doc, viewport]);
  const node = (
    <section
      ref={(element) => register(pane.id, element)}
      data-preview-pane={pane.id}
      aria-label={floating ? '浮动预览' : '预览窗格'}
      className={`preview-pane ${floating ? 'preview-pane-floating' : ''} ${workspace.focused === pane.id ? 'is-focused' : ''}`}
      style={
        floating
          ? {
              left: Math.min(floating.x, Math.max(0, size.width - floating.width)),
              top: Math.min(floating.y, Math.max(36, size.height - floating.height)),
              width: Math.min(floating.width, size.width),
              height: Math.min(floating.height, size.height - 36),
            }
          : undefined
      }
      onPointerDownCapture={() => workspace.focus(pane.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(mime)) {
          e.preventDefault();
          e.currentTarget.dataset.drop = 'true';
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) delete e.currentTarget.dataset.drop;
      }}
      onDrop={(e) => {
        delete e.currentTarget.dataset.drop;
        const id = e.dataTransfer.getData(mime);
        if (id) {
          e.preventDefault();
          workspace.move(id, pane.id);
        }
      }}
    >
      <header
        className="preview-pane-heading"
        onPointerDown={(event) => {
          if (!floating || event.button !== 0 || (event.target as HTMLElement).closest('button'))
            return;
          handle.current = { x: event.clientX, y: event.clientY, rect: floating, resize: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          doc.body.setAttribute('data-preview-resizing', '');
        }}
        onPointerMove={(event) => {
          const drag = handle.current;
          if (!drag || drag.resize) return;
          workspace.rect(pane.id, {
            ...drag.rect,
            x: Math.max(
              0,
              Math.min(size.width - drag.rect.width, drag.rect.x + event.clientX - drag.x),
            ),
            y: Math.max(
              36,
              Math.min(size.height - drag.rect.height, drag.rect.y + event.clientY - drag.y),
            ),
          });
        }}
        onPointerUp={() => {
          handle.current = null;
          doc.body.removeAttribute('data-preview-resizing');
        }}
        onLostPointerCapture={() => {
          handle.current = null;
          doc.body.removeAttribute('data-preview-resizing');
        }}
      >
        {/* One row (audit H1): the pane's tabs, then its own controls as icons, and for the first docked pane the
            preview's controls; the file's path and actions are the second row (PreviewContent.tsx). */}
        {/* A floating pane is moved by its name at the start of the row. */}
        {floating && <span className="preview-pane-grip">浮动预览</span>}
        <div className="preview-tabs" role="tablist" aria-label="预览标签">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(mime, tab.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() =>
                doc.querySelectorAll('[data-drop]').forEach((el) => el.removeAttribute('data-drop'))
              }
              onDrop={(e) => {
                const id = e.dataTransfer.getData(mime);
                if (id) {
                  e.preventDefault();
                  e.stopPropagation();
                  workspace.move(id, pane.id, index);
                  e.currentTarget.closest('[data-drop]')?.removeAttribute('data-drop');
                }
              }}
              className={`preview-tab ${tab.id === active?.id ? 'active' : ''}`}
            >
              <button
                role="tab"
                aria-selected={tab.id === active?.id}
                aria-controls={content}
                tabIndex={tab.id === active?.id ? 0 : -1}
                title={tab.kind === 'chat' ? (tab.title ?? '侧边会话') : tab.target}
                onClick={() => workspace.select(tab.id)}
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                          tabs.length;
                  workspace.select(tabs[next].id);
                  event.currentTarget
                    .closest('[role="tablist"]')
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                {tab.kind === 'web' ? (
                  <Globe scale="xs" />
                ) : tab.kind === 'chat' ? (
                  <MessageSquare scale="xs" />
                ) : (
                  <FileText scale="xs" />
                )}
                <span>
                  {tab.kind === 'web'
                    ? tab.target.replace(/^https?:\/\//, '')
                    : tab.kind === 'chat'
                      ? (tab.title ?? '侧边对话')
                      : name(tab.target)}
                </span>
              </button>
              <IconButton
                title={`关闭预览 ${tab.kind === 'web' ? tab.target.replace(/^https?:\/\//, '') : tab.kind === 'chat' ? (tab.title ?? '侧边对话') : name(tab.target)}`}
                size="xs"
                onClick={() => {
                  workspace.close(tab.id);
                  viewport.requestAnimationFrame(() => focus(pane.id));
                }}
              >
                <X />
              </IconButton>
            </div>
          ))}
        </div>
        <span className="preview-pane-actions">
          {floating ? (
            <IconButton title="停靠预览" size="sm" onClick={() => workspace.dock(pane.id)}>
              <PanelDock />
            </IconButton>
          ) : (
            <>
              <IconButton
                title="分栏预览"
                size="sm"
                disabled={tabs.length < 2 || workspace.panes.length >= 4}
                onClick={() => workspace.split(pane.id, pane.active)}
              >
                <Columns2 />
              </IconButton>
              <IconButton
                title="浮动预览"
                size="sm"
                disabled={!active || workspace.panes.length >= 4}
                onClick={() => workspace.float(pane.active)}
              >
                <PictureInPicture />
              </IconButton>
            </>
          )}
          {workspace.panes.length > 1 && (
            <IconButton
              title="移动到下一窗格"
              size="sm"
              disabled={!active}
              onClick={() =>
                workspace.move(
                  pane.active,
                  workspace.panes[(workspace.panes.indexOf(pane) + 1) % workspace.panes.length].id,
                )
              }
            >
              <ArrowLeftRight />
            </IconButton>
          )}
        </span>
        {actions}
      </header>
      <div
        className="preview-content"
        id={content}
        role="tabpanel"
        aria-label={
          active
            ? active.kind === 'chat'
              ? (active.title ?? '侧边对话')
              : name(active.target)
            : '预览内容'
        }
      >
        {active ? (
          active.kind === 'chat' ? (
            (renderChat?.(active) ?? <p className="preview-empty">此窗口暂不支持侧边会话。</p>)
          ) : !filesAvailable ? (
            <p className="preview-empty">此文件预览需要项目所在设备。</p>
          ) : workspace.pending.has(active.id) ? (
            <div className="preview-empty">
              <FileText />
              <p>已恢复标签。点击后加载此预览。</p>
              <Button onClick={() => workspace.activate(active.id)}>加载此预览</Button>
            </div>
          ) : (
            <PreviewContent
              key={JSON.stringify([workspace.scope, active.id])}
              tab={active}
              pane={pane.id}
              surface={surface}
              workspace={workspace}
            />
          )
        ) : (
          empty
        )}
      </div>
      {floating && (
        <div
          role="separator"
          aria-label="调整浮窗大小"
          tabIndex={0}
          className="preview-float-resize"
          onPointerDown={(e) => {
            e.preventDefault();
            handle.current = { x: e.clientX, y: e.clientY, rect: floating, resize: true };
            e.currentTarget.setPointerCapture(e.pointerId);
            doc.body.setAttribute('data-preview-resizing', '');
          }}
          onPointerMove={(e) => {
            const drag = handle.current;
            if (drag?.resize)
              workspace.rect(pane.id, {
                ...drag.rect,
                width: Math.max(
                  280,
                  Math.min(size.width - drag.rect.x, drag.rect.width + e.clientX - drag.x),
                ),
                height: Math.max(
                  minHeight,
                  Math.min(size.height - drag.rect.y, drag.rect.height + e.clientY - drag.y),
                ),
              });
          }}
          onPointerUp={() => {
            handle.current = null;
            doc.body.removeAttribute('data-preview-resizing');
          }}
          onLostPointerCapture={() => {
            handle.current = null;
            doc.body.removeAttribute('data-preview-resizing');
          }}
          onKeyDown={(e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
              e.preventDefault();
              workspace.rect(pane.id, {
                ...floating,
                width: Math.max(
                  280,
                  Math.min(
                    size.width - floating.x,
                    floating.width +
                      (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0),
                  ),
                ),
                height: Math.max(
                  minHeight,
                  Math.min(
                    size.height - floating.y,
                    floating.height + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0),
                  ),
                ),
              });
            }
          }}
        />
      )}
    </section>
  );
  return floating ? createPortal(node, doc.body) : node;
}
