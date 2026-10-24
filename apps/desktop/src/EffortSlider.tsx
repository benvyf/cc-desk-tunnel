import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Effort } from '@cc-desk-tunnel/protocol';
import { effortNames } from './modelDefaults.ts';

export default function EffortSlider({
  levels,
  value,
  disabled,
  onPreview,
  onCommit,
}: {
  levels: Effort[];
  value: Effort | null;
  disabled: boolean;
  onPreview: (value: Effort | null) => void;
  onCommit: (value: Effort) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const dragging = useRef(false);
  const generation = useRef(0);
  const restoreFocus = useRef(false);
  const max = Math.max(0, levels.length - 1);
  const committed = Math.max(0, levels.indexOf(value ?? 'high'));
  const current = position ?? committed;
  const shown = position === null ? value : levels[Math.round(current)];
  const signature = levels.join(',');
  function cancel() {
    dragging.current = false;
    pending.current = null;
    setPosition(null);
    onPreview(null);
  }
  useEffect(() => {
    generation.current++;
    cancel();
  }, [value, signature]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (disabled && pending.current !== null) cancel();
    if (!disabled && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body && !input.current?.closest('[inert]'))
        input.current?.focus();
    }
  }, [disabled]);
  function preview(next: number) {
    pending.current = next;
    setPosition(next);
    onPreview(levels[Math.round(next)]);
  }
  async function commit() {
    dragging.current = false;
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    if (disabled || input.current?.closest('[inert]')) {
      cancel();
      return;
    }
    const index = Math.round(next);
    const level = levels[index];
    if (!level || level === value) {
      cancel();
      return;
    }
    const turn = ++generation.current;
    restoreFocus.current = document.activeElement === input.current;
    setPosition(index);
    onPreview(level);
    try {
      await onCommit(level);
    } catch {
      // The caller presents request failures; restore the authoritative value below.
    } finally {
      if (turn === generation.current) cancel();
    }
  }
  return (
    <input
      ref={input}
      type="range"
      className="effort-slider"
      aria-label="推理强度"
      min={0}
      max={max}
      step="any"
      disabled={disabled || levels.length < 2}
      value={current}
      aria-valuetext={shown ? effortNames[shown] : '原生默认'}
      data-unset={shown ? undefined : ''}
      style={{ '--fill': `${max ? (current / max) * 100 : 0}%` } as CSSProperties}
      onPointerDown={() => {
        dragging.current = true;
        pending.current = current;
      }}
      onChange={(event) => preview(Number(event.currentTarget.value))}
      onPointerUp={() => void commit()}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (dragging.current) cancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          cancel();
          return;
        }
        const direction = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)
          ? 1
          : ['ArrowLeft', 'ArrowDown', 'PageDown'].includes(event.key)
            ? -1
            : 0;
        if (direction || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? max
                : Math.round(pending.current ?? current) + direction;
          preview(Math.max(0, Math.min(max, next)));
        }
      }}
      onKeyUp={(event) => {
        if (
          [
            'ArrowRight',
            'ArrowUp',
            'PageUp',
            'ArrowLeft',
            'ArrowDown',
            'PageDown',
            'Home',
            'End',
          ].includes(event.key)
        )
          void commit();
      }}
      onBlur={() => {
        if (dragging.current) cancel();
        else void commit();
      }}
    />
  );
}
