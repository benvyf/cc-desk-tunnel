import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

// Keep composer popups reachable as a draft grows or the window is resized.
export function usePopupBounds(
  container: RefObject<HTMLElement | null>,
  selector: string,
  open: boolean,
  contentKey: unknown = null,
) {
  useLayoutEffect(() => {
    if (!open) return;
    const popup = container.current?.querySelector<HTMLElement>(selector);
    if (!popup) return;
    const composer = popup.closest('.composer');
    const workspace = popup.closest('.workspace');
    const side = popup.closest('.side-conversation');
    const doc = popup.ownerDocument,
      viewport = doc.defaultView!;
    const fit = () => {
      const bounds = side?.getBoundingClientRect();
      const edge = Math.max(8, (bounds?.top ?? workspace?.getBoundingClientRect().top ?? 0) + 8);
      const left = Math.max(8, (bounds?.left ?? 0) + 8);
      const right = Math.min(doc.documentElement.clientWidth - 8, (bounds?.right ?? Infinity) - 8);
      const bottom = Math.min(
        doc.documentElement.clientHeight - 8,
        (bounds?.bottom ?? Infinity) - 8,
      );
      popup.style.maxHeight = `${Math.max(0, bottom - edge)}px`;
      if (bounds) popup.style.maxWidth = `${Math.max(0, right - left)}px`;
      popup.style.transform = '';
      const box = popup.getBoundingClientRect();
      const x = Math.max(left - box.left, Math.min(0, right - box.right));
      const y = Math.max(edge - box.top, Math.min(0, bottom - box.bottom));
      if (x || y) popup.style.transform = `translate(${x}px, ${y}px)`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(popup);
    if (composer) observer.observe(composer);
    if (side) observer.observe(side);
    side?.addEventListener('scroll', fit, { passive: true });
    viewport.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      side?.removeEventListener('scroll', fit);
      viewport.removeEventListener('resize', fit);
    };
  }, [container, selector, open, contentKey]);
}
