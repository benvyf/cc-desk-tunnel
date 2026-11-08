import { useCallback, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ReadingPosition } from './previewViewState.ts';

// Restore only a newly loaded revision. Subsequent resizing belongs to the reader/browser.
export function usePreviewReading(
  root: RefObject<HTMLElement | null>,
  ready: unknown,
  mode: string,
  get: () => ReadingPosition,
  save: (position: ReadingPosition) => void,
  horizontalSelector: string | undefined,
  owner: { beforeFlush: (capture: () => void) => () => void },
  interruption?: RefObject<boolean>,
) {
  const capture = useRef(() => {});
  const localInterruption = useRef(false);
  const interrupted = interruption ?? localInterruption;
  const identity = useRef({ ready, mode, owner });
  const previous = useRef({ ready, mode, owner });
  identity.current = { ready, mode, owner };
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const old = previous.current;
    if (old.ready && (old.ready !== ready || old.mode !== mode || old.owner !== owner))
      interrupted.current = false;
    previous.current = { ready, mode, owner };
    const win = element.ownerDocument.defaultView!;
    const content = element.firstElementChild;
    const horizontal = horizontalSelector
      ? (element.querySelector<HTMLElement>(horizontalSelector) ?? element)
      : element;
    const position = () => ({ top: element.scrollTop, left: horizontal.scrollLeft });
    let active = true;
    let waiting = !!ready && !interrupted.current;
    let frame = 0;
    let stable = 0;
    let dimensions = '';
    let observer: ResizeObserver | undefined;
    const target = get();
    let savedWidth = element.clientWidth;
    let savedHeight = element.clientHeight;
    const visible = () => element.clientHeight > 0 && element.clientWidth > 0;
    const capturePosition = () => {
      if (ready && !waiting && visible()) {
        savedWidth = element.clientWidth;
        savedHeight = element.clientHeight;
        save(position());
      }
    };
    capture.current = capturePosition;
    const request = () => {
      if (active && !frame) frame = win.requestAnimationFrame(restore);
    };
    const restore = () => {
      frame = 0;
      if (!active) return;
      if (!waiting) {
        capturePosition();
        return;
      }
      if (!visible()) return;
      element.scrollTop = target.top;
      horizontal.scrollLeft = target.left;
      const current = `${element.scrollHeight}:${element.clientHeight}:${horizontal.scrollWidth}:${horizontal.clientWidth}`;
      stable = current === dimensions ? stable + 1 : 0;
      dimensions = current;
      const imagesPending = [...element.querySelectorAll('img')].some((image) => !image.complete);
      const fontsPending = element.ownerDocument.fonts.status === 'loading';
      if (stable >= 2 && !imagesPending && !fontsPending) {
        waiting = false;
        observer?.disconnect();
        capturePosition();
      } else if (!imagesPending && !fontsPending) request();
    };
    const interrupt = () => {
      interrupted.current = true;
      waiting = false;
      observer?.disconnect();
      win.cancelAnimationFrame(frame);
      frame = 0;
      request(); // Read after the input's default scroll has happened.
    };
    const keydown = (event: KeyboardEvent) => {
      if (/^(?:Arrow(?:Up|Down|Left|Right)|PageUp|PageDown|Home|End| )$/.test(event.key))
        interrupt();
    };
    const scroll = (event: Event) => {
      if (event.target === element || event.target === horizontal) capturePosition();
    };
    element.addEventListener('scroll', scroll, true);
    element.addEventListener('wheel', interrupt, { passive: true });
    element.addEventListener('touchstart', interrupt, { passive: true });
    element.addEventListener('pointerdown', interrupt);
    element.addEventListener('keydown', keydown);
    const removeCapture = owner.beforeFlush(capturePosition);
    if (waiting) {
      observer = new ResizeObserver(request);
      observer.observe(element);
      if (content) observer.observe(content);
      element.addEventListener('load', request, true);
      element.addEventListener('error', request, true);
      void element.ownerDocument.fonts.ready.then(() => {
        if (waiting) request();
      });
      restore();
    } else if (ready) {
      // The user cancelled while the placeholder was mounted. Commit that new position
      // before a later tab switch can discard the recreated PDF viewport.
      capturePosition();
    }
    return () => {
      // On a revision/mode replacement the old DOM may already be gone. Refresh/toggle
      // captures before the mutation; only an actual unmount samples its surviving DOM.
      if (
        identity.current.ready === ready &&
        identity.current.mode === mode &&
        identity.current.owner === owner &&
        // React may remove the parent's toolbar before this descendant's cleanup,
        // enlarging the viewport and clamping its position. Keep the last valid sample.
        element.clientWidth === savedWidth &&
        element.clientHeight === savedHeight &&
        content?.isConnected &&
        element.contains(content)
      )
        capturePosition();
      active = false;
      win.cancelAnimationFrame(frame);
      observer?.disconnect();
      element.removeEventListener('scroll', scroll, true);
      element.removeEventListener('wheel', interrupt);
      element.removeEventListener('touchstart', interrupt);
      element.removeEventListener('pointerdown', interrupt);
      element.removeEventListener('keydown', keydown);
      element.removeEventListener('load', request, true);
      element.removeEventListener('error', request, true);
      removeCapture();
      if (capture.current === capturePosition) capture.current = () => {};
    };
    // The callbacks belong to this mounted revision/mode, not unrelated parent renders.
  }, [root, ready, mode, horizontalSelector, owner]);
  return useCallback(() => capture.current(), []);
}
