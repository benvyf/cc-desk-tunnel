import { useLayoutEffect, useRef, type RefObject } from 'react';
import './ConversationWidthControls.css';
import {
  chatWidthEdges,
  chatWidthKey,
  chatWidthMin,
  readChatWidth,
  reloadChatWidth,
  resolveChatWidth,
  saveChatWidth,
} from './chatWidth.ts';

// Width is a local presentation preference. Pointer frames never update React or remote state.
export default function ConversationWidthControls({
  scroll,
  active,
}: {
  scroll: RefObject<HTMLDivElement | null>;
  active: boolean;
}) {
  const controls = useRef<HTMLDivElement>(null);
  const preference = useRef<{ width: number | null } | null>(null);
  useLayoutEffect(() => {
    const chrome = controls.current!,
      box = scroll.current!;
    const frameBox = chrome.parentElement!;
    const workspace = chrome.closest<HTMLElement>('.chat-workspace')!;
    const doc = chrome.ownerDocument,
      win = doc.defaultView!;
    preference.current ??= { width: readChatWidth() };
    const handles = [...chrome.querySelectorAll<HTMLElement>('[data-chat-width-handle]')];
    let column = frameBox.clientWidth;
    let height = frameBox.clientHeight;
    let frame = 0;
    let drag: {
      handle: HTMLElement;
      pointerId: number;
      x: number;
      start: number;
      width: number;
    } | null = null;
    let pointer: { handle: HTMLElement; y: number } | null = null;
    let top = 0;
    const ceiling = () => Math.max(chatWidthMin, column - chatWidthEdges);
    const publish = (width = resolveChatWidth(column, preference.current!.width)) => {
      const px = `${width}px`;
      if (workspace.style.getPropertyValue('--chat-content-width') !== px)
        workspace.style.setProperty('--chat-content-width', px);
      chrome.toggleAttribute('data-available', active && column >= chatWidthMin + chatWidthEdges);
      for (const handle of handles) {
        handle.setAttribute('aria-valuenow', String(width));
        handle.setAttribute('aria-valuemax', String(ceiling()));
      }
    };
    const flush = () => {
      frame = 0;
      if (drag) publish(drag.width);
      if (pointer) pointer.handle.style.setProperty('--chat-width-pointer-y', `${pointer.y}px`);
    };
    const schedule = () => {
      frame ||= win.requestAnimationFrame(flush);
    };
    const removeCancelListeners = () => {
      win.removeEventListener('blur', cancel);
      doc.removeEventListener('visibilitychange', visibility);
      doc.removeEventListener('keydown', escape, true);
    };
    const finish = (save: boolean) => {
      if (!drag) return;
      const ended = drag;
      drag = null;
      win.cancelAnimationFrame(frame);
      frame = 0;
      // Hover outlives the gesture: later header changes still move the visible hint.
      // pointerleave owns this position's cleanup; drag is already cleared above.
      ended.handle.removeAttribute('data-dragging');
      workspace.removeAttribute('data-chat-width-dragging');
      removeCancelListeners();
      // Clicking the divider or dragging against a limit must not replace a larger saved width.
      if (save && ended.width !== ended.start) {
        preference.current!.width = ended.width;
        saveChatWidth(ended.width);
      }
      publish();
      if (ended.handle.hasPointerCapture(ended.pointerId))
        ended.handle.releasePointerCapture(ended.pointerId);
    };
    const cancel = () => finish(false);
    const visibility = () => {
      if (doc.hidden) cancel();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    const commit = (width: number | null) => {
      preference.current!.width = width;
      saveChatWidth(width);
      publish();
    };
    const unsubscribes = handles.map((handle) => {
      const side = handle.dataset.chatWidthHandle === 'right' ? 1 : -1;
      const move = (event: PointerEvent) => {
        if (drag && event.pointerId !== drag.pointerId) return;
        pointer = { handle, y: event.clientY - top };
        if (drag)
          drag.width = Math.round(
            resolveChatWidth(column, drag.start + (event.clientX - drag.x) * side * 2),
          );
        schedule();
      };
      const enter = () => {
        if (!drag) top = handle.getBoundingClientRect().top;
      };
      const down = (event: PointerEvent) => {
        if (event.button !== 0 || drag || !active || column < chatWidthMin + chatWidthEdges) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        top = handle.getBoundingClientRect().top;
        const start = resolveChatWidth(column, preference.current!.width);
        drag = { handle, pointerId: event.pointerId, x: event.clientX, start, width: start };
        handle.setAttribute('data-dragging', '');
        workspace.setAttribute('data-chat-width-dragging', '');
        win.addEventListener('blur', cancel);
        doc.addEventListener('visibilitychange', visibility);
        doc.addEventListener('keydown', escape, true);
        move(event);
      };
      const up = (event: PointerEvent) => {
        if (drag?.pointerId !== event.pointerId) return;
        move(event);
        finish(true);
      };
      const lost = (event: PointerEvent) => {
        if (drag?.pointerId === event.pointerId) cancel();
      };
      const leave = () => {
        if (drag) return;
        pointer = null;
        win.cancelAnimationFrame(frame);
        frame = 0;
      };
      const reset = () => {
        cancel();
        commit(null);
      };
      const key = (event: KeyboardEvent) => {
        if (drag || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const current = resolveChatWidth(column, preference.current!.width);
        const width =
          event.key === 'Home'
            ? chatWidthMin
            : event.key === 'End'
              ? ceiling()
              : resolveChatWidth(column, current + (event.key === 'ArrowRight' ? 10 : -10) * side);
        if (width !== current) commit(width);
      };
      const wheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.deltaY === 0) return;
        event.preventDefault();
        // Preserve the Conversation's reader-intent/follow logic before scrolling its existing box.
        box.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            deltaY: event.deltaY,
            deltaMode: event.deltaMode,
          }),
        );
        box.scrollBy({
          top:
            event.deltaY *
            (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? box.clientHeight : 1),
        });
      };
      const events = {
        pointerdown: down,
        pointerenter: enter,
        pointermove: move,
        pointerup: up,
        pointercancel: lost,
        lostpointercapture: lost,
        pointerleave: leave,
        dblclick: reset,
        keydown: key,
        wheel,
      };
      for (const [name, listener] of Object.entries(events))
        handle.addEventListener(name, listener as EventListener, { passive: false });
      return () => {
        for (const [name, listener] of Object.entries(events))
          handle.removeEventListener(name, listener as EventListener);
      };
    });
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (column !== next) {
        cancel();
        column = next;
        publish();
      }
      const nextHeight = Math.round(entry.contentRect.height);
      if (height === nextHeight) return;
      height = nextHeight;
      // Find/connection chrome can move the body while the pointer is captured.
      // Refresh the cached origin only on layout changes, never on each pointer move.
      if (pointer) {
        const nextTop = frameBox.getBoundingClientRect().top;
        pointer.y += top - nextTop;
        top = nextTop;
        schedule();
      }
    });
    observer.observe(frameBox);
    const storage = (event: StorageEvent) => {
      if (event.key !== chatWidthKey && event.key !== null) return;
      cancel();
      preference.current!.width = reloadChatWidth();
      publish();
    };
    win.addEventListener('storage', storage);
    publish();
    return () => {
      cancel();
      win.cancelAnimationFrame(frame);
      observer.disconnect();
      win.removeEventListener('storage', storage);
      for (const unsubscribe of unsubscribes) unsubscribe();
      workspace.style.removeProperty('--chat-content-width');
    };
  }, [active, scroll]);
  return (
    <div className="chat-width-controls" ref={controls}>
      {(['left', 'right'] as const).map((side) => (
        <div
          key={side}
          className="chat-width-handle"
          data-chat-width-handle={side}
          role="separator"
          aria-label={`调整聊天正文宽度（${side === 'left' ? '左侧' : '右侧'}）`}
          aria-orientation="vertical"
          aria-valuemin={chatWidthMin}
          aria-description="拖动或按左右方向键调整，双击恢复默认"
          tabIndex={0}
        />
      ))}
    </div>
  );
}
