import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from './ui.tsx';
import { FileText, Globe, X } from './icons.tsx';
import PreviewContent from './PreviewContent.tsx';
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
}: {
  pane: PreviewPane;
  workspace: PreviewWorkspace;
  surface: PreviewSurface;
  empty: ReactNode;
  doc: Document;
}) {
  const viewport = doc.defaultView ?? window;
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
  const floating = pane.floating ? fitFloat(pane.floating, size.width, size.height) : undefined;
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
      data-preview-pane={pane.id}
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
        <span>{floating ? '浮动预览' : '预览窗格'}</span>
        {floating ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label="停靠预览"
            onClick={() => workspace.dock(pane.id)}
          >
            停靠
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="分栏预览"
              disabled={tabs.length < 2 || workspace.panes.length >= 4}
              onClick={() => workspace.split(pane.id, pane.active)}
            >
              分栏
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="浮动预览"
              disabled={!active || workspace.panes.length >= 4}
              onClick={() => workspace.float(pane.active)}
            >
              浮动
            </Button>
          </>
        )}
        {workspace.panes.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="移动到下一窗格"
            disabled={!active}
            onClick={() =>
              workspace.move(
                pane.active,
                workspace.panes[(workspace.panes.indexOf(pane) + 1) % workspace.panes.length].id,
              )
            }
          >
            移动
          </Button>
        )}
      </header>
      {!!tabs.length && (
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
                document
                  .querySelectorAll('[data-drop]')
                  .forEach((el) => el.removeAttribute('data-drop'))
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
                title={tab.target}
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
                {tab.kind === 'web' ? <Globe scale="xs" /> : <FileText scale="xs" />}
                <span>
                  {tab.kind === 'web' ? tab.target.replace(/^https?:\/\//, '') : name(tab.target)}
                </span>
              </button>
              <IconButton
                title={`关闭预览 ${tab.kind === 'web' ? tab.target.replace(/^https?:\/\//, '') : name(tab.target)}`}
                size="xs"
                onClick={() => {
                  workspace.close(tab.id);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLButtonElement>(
                        `[data-preview-pane="${pane.id}"] [aria-selected="true"]`,
                      )
                      ?.focus(),
                  );
                }}
              >
                <X />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div
        className="preview-content"
        id={content}
        role="tabpanel"
        aria-label={active ? name(active.target) : '预览内容'}
      >
        {active ? (
          workspace.pending.has(active.id) ? (
            <div className="preview-empty">
              <FileText />
              <p>已恢复标签。点击后加载此预览。</p>
              <Button onClick={() => workspace.activate(active.id)}>加载此预览</Button>
            </div>
          ) : (
            <PreviewContent
              key={active.id}
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
                  180,
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
                  180,
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
