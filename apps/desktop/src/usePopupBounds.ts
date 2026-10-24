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
    const fit = () => {
      const edge = Math.max(8, (workspace?.getBoundingClientRect().top ?? 0) + 8);
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      popup.style.maxHeight = `${Math.max(0, height - edge - 8)}px`;
      popup.style.transform = '';
      const box = popup.getBoundingClientRect();
      const x = Math.max(8 - box.left, Math.min(0, width - 8 - box.right));
      const y = Math.max(edge - box.top, Math.min(0, height - 8 - box.bottom));
      if (x || y) popup.style.transform = `translate(${x}px, ${y}px)`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(popup);
    if (composer) observer.observe(composer);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [container, selector, open, contentKey]);
}
