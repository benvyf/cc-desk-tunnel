import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui.tsx';

export type QuoteDestination = 'main' | 'side';
type Actions = {
  quote: (messageId: string, text: string, destination: QuoteDestination) => void;
  sideAvailable: boolean;
  sideReason?: string;
};
export const QuoteActionsContext = createContext<Actions | null>(null);
export function AnswerQuoteActions({ messageId, text }: { messageId: string; text: string }) {
  const actions = useContext(QuoteActionsContext);
  if (!actions || !text.trim()) return null;
  return (
    <span className="answer-quote-actions">
      <Button
        size="sm"
        variant="ghost"
        aria-label="引用回答"
        onClick={() => actions.quote(messageId, text, 'main')}
      >
        引用
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="在侧边聊天中提问"
        disabled={!actions.sideAvailable}
        title={
          actions.sideAvailable
            ? '创建独立侧边会话'
            : (actions.sideReason ?? '当前节点需要更新以支持侧边会话')
        }
        onClick={() => actions.quote(messageId, text, 'side')}
      >
        侧栏问
      </Button>
    </span>
  );
}
export function assistantSelection(root: HTMLElement) {
  const selection = root.ownerDocument.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount !== 1 ||
    !selection.toString().trim()
  )
    return null;
  const content = (node: Node | null) => {
    const element = node?.nodeType === 1 ? (node as HTMLElement) : node?.parentElement;
    const body = element?.closest<HTMLElement>('.message.assistant [data-copy-text]');
    return body && root.contains(body) ? body : null;
  };
  const body = content(selection.anchorNode);
  if (!body || body !== content(selection.focusNode)) return null;
  const message = body.closest<HTMLElement>('[data-message-id]');
  if (!message?.dataset.messageId) return null;
  const area = selection.getRangeAt(0).getBoundingClientRect();
  if (!area.width && !area.height) return null;
  return { messageId: message.dataset.messageId, text: selection.toString(), area };
}
export function QuoteSelection({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const actions = useContext(QuoteActionsContext);
  const [selected, setSelected] = useState<ReturnType<typeof assistantSelection>>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!actions || !element) return;
    const doc = element.ownerDocument,
      win = doc.defaultView!;
    let frame = 0;
    const update = () => {
      frame = 0;
      setSelected(assistantSelection(element));
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(update);
    };
    const clear = () => {
      win.cancelAnimationFrame(frame);
      frame = 0;
      setSelected(null);
    };
    const dismiss = (event: PointerEvent) => {
      if (!toolbar.current?.contains(event.target as Node)) clear();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      clear();
      if (assistantSelection(element)) doc.getSelection()?.removeAllRanges();
    };
    doc.addEventListener('selectionchange', schedule);
    doc.addEventListener('scroll', clear, true);
    doc.addEventListener('pointerdown', dismiss);
    doc.addEventListener('keydown', escape);
    win.addEventListener('resize', clear);
    return () => {
      win.cancelAnimationFrame(frame);
      doc.removeEventListener('selectionchange', schedule);
      doc.removeEventListener('scroll', clear, true);
      doc.removeEventListener('pointerdown', dismiss);
      doc.removeEventListener('keydown', escape);
      win.removeEventListener('resize', clear);
    };
  }, [actions, root]);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element || !selected) return;
    const win = element.ownerDocument.defaultView!;
    const fit = () => {
      element.style.maxWidth = `${Math.max(0, Math.min(320, win.innerWidth - 16))}px`;
      const { width, height } = element.getBoundingClientRect();
      const x = selected.area.left + selected.area.width / 2 - width / 2;
      const above = selected.area.top - height - 6;
      const y = above < 8 ? selected.area.bottom + 6 : above;
      element.style.left = `${Math.max(8, Math.min(win.innerWidth - width - 8, x))}px`;
      element.style.top = `${Math.max(8, Math.min(win.innerHeight - height - 8, y))}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected]);
  if (!actions || !selected || !root.current) return null;
  const doc = root.current.ownerDocument;
  const run = (destination: QuoteDestination) => {
    actions.quote(selected.messageId, selected.text, destination);
    doc.getSelection()?.removeAllRanges();
    setSelected(null);
  };
  return createPortal(
    <div
      ref={toolbar}
      className="quote-selection-toolbar"
      role="toolbar"
      aria-label="引用选中文字"
      onPointerDown={(event) => event.preventDefault()}
    >
      <Button size="sm" variant="ghost" onClick={() => run('main')}>
        添加到对话
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!actions.sideAvailable}
        title={actions.sideReason}
        onClick={() => run('side')}
      >
        在侧边聊天中提问
      </Button>
    </div>,
    doc.body,
  );
}
