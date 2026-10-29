import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrefs, setPrefs, sidebarWidthRange } from './prefs.ts';

const { min, max, default: defaultWidth } = sidebarWidthRange;
// Account for the page rail and preserve 400px for chat whenever the window permits.
const maxWidth = (shell: HTMLElement) => Math.max(min, Math.min(max, shell.clientWidth - 52 - 400));
const clamp = (width: number, ceiling: number) =>
  Math.max(min, Math.min(ceiling, Math.round(width)));

type Drag = {
  shell: HTMLElement;
  handle: HTMLDivElement;
  pointerId: number;
  startX: number;
  startWidth: number;
  ceiling: number;
  width: number;
};

export default function SidebarResize({ open }: { open: boolean }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [size, setSize] = useState({ width: defaultWidth, max });

  const finish = useCallback((save: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    current.shell.removeAttribute('data-sidebar-resizing');
    // Focusing or clicking the divider must not replace a larger saved preference
    // with the temporary width imposed by a smaller window.
    const changed = save && current.width !== current.startWidth;
    current.shell.style.setProperty(
      '--sidebar-width',
      `${changed ? current.width : getPrefs().sidebarWidth}px`,
    );
    if (current.handle.hasPointerCapture(current.pointerId))
      current.handle.releasePointerCapture(current.pointerId);
    if (changed && getPrefs().sidebarWidth !== current.width)
      setPrefs((prefs) => ({ ...prefs, sidebarWidth: current.width }));
  }, []);

  useEffect(() => {
    if (!open) return;
    const sidebar = handle.current!.parentElement!;
    const shell = sidebar.closest<HTMLElement>('.shell')!;
    const observer = new ResizeObserver(() => {
      const width = Math.round(sidebar.getBoundingClientRect().width);
      const ceiling = maxWidth(shell);
      setSize((current) =>
        current.width === width && current.max === ceiling ? current : { width, max: ceiling },
      );
    });
    observer.observe(sidebar);
    observer.observe(shell);
    const cancel = () => finish(false);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      observer.disconnect();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      finish(false);
    };
  }, [finish, open]);

  function move(clientX: number) {
    const current = drag.current!;
    current.width = clamp(current.startWidth + clientX - current.startX, current.ceiling);
  }

  return (
    <div
      ref={handle}
      className="sidebar-resize"
      role="separator"
      aria-label="调整侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={size.max}
      aria-valuenow={size.width}
      tabIndex={0}
      title="拖动调整侧栏宽度，双击恢复默认"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        const sidebar = event.currentTarget.parentElement!;
        const shell = sidebar.closest<HTMLElement>('.shell')!;
        const width = Math.round(sidebar.getBoundingClientRect().width);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        drag.current = {
          shell,
          handle: event.currentTarget,
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
          ceiling: maxWidth(shell),
          width,
        };
        shell.setAttribute('data-sidebar-resizing', '');
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        move(event.clientX);
        if (frame.current) return;
        // Update only the grid variable; avoid re-rendering chat and saving prefs on every move.
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          const current = drag.current!;
          const width = `${current.width}px`;
          if (current.shell.style.getPropertyValue('--sidebar-width') !== width)
            current.shell.style.setProperty('--sidebar-width', width);
        });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        move(event.clientX);
        finish(true);
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(false);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(false);
      }}
      onDoubleClick={() => setPrefs((prefs) => ({ ...prefs, sidebarWidth: defaultWidth }))}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          finish(false);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || drag.current) return;
        event.preventDefault();
        const width =
          event.key === 'Home'
            ? min
            : event.key === 'End'
              ? size.max
              : clamp(size.width + (event.key === 'ArrowRight' ? 10 : -10), size.max);
        setPrefs((prefs) => ({ ...prefs, sidebarWidth: width }));
      }}
    />
  );
}
