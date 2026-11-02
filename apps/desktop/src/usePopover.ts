import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// A card that opens upward from its button, closes on an outside click or Escape, opens below the button when
// there is no room above it, and is moved sideways when it would run past the window's edge — or, in the strip under
// the input box, past the input box's edges.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // The room above ends where the conversation's scrolling area begins, under the title bar, not at the top of the
  // window.
  useLayoutEffect(() => {
    // Presence retains the last card while closing; preserve its fitted position through the fade.
    if (!open) return;
    const element = card.current;
    if (!element) return;
    const top = element.closest('.conversation')?.getBoundingClientRect().top ?? 0;
    element.classList.toggle('below', element.getBoundingClientRect().top < top + 8);
    element.style.transform = '';
    const { left, right } = element.getBoundingClientRect();
    const column = element.closest('.session-bar')?.getBoundingClientRect();
    const edge = Math.min(document.documentElement.clientWidth - 8, column?.right ?? Infinity);
    const start = Math.max(8, column?.left ?? 0);
    const shift = right > edge ? edge - right : left < start ? start - left : 0;
    if (shift) element.style.transform = `translateX(${shift}px)`;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return { open, setOpen, container, card };
}
