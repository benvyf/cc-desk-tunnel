import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

type Option<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
};

// The grid and indicator share their geometry; measurements only keep selection in the scrollport.
export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
  role = 'group',
  className = '',
}: {
  label: string;
  value: Value;
  options: readonly Option<Value>[];
  onChange: (value: Value) => void;
  role?: 'group' | 'radiogroup';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.findIndex((option) => option.value === value);
  const tabStop =
    selected >= 0 && !options[selected].disabled
      ? selected
      : options.findIndex((option) => !option.disabled);
  useLayoutEffect(() => {
    const control = ref.current!;
    const track = control.firstElementChild!;
    const reveal = () => {
      const button = control.querySelectorAll('button')[selected];
      if (!button || !control.clientWidth) return;
      const bounds = control.getBoundingClientRect();
      const active = button.getBoundingClientRect();
      // Rectangles include CSS zoom; scrolling and the 2px inset use layout pixels.
      const width = Number.parseFloat(getComputedStyle(control).width);
      const scale = bounds.width / width;
      const left = (active.left - bounds.left) / scale;
      const right = (active.right - bounds.left) / scale;
      // Scroll this track only; selecting a range must not move the surrounding page.
      const delta = left < 2 ? left - 2 : right > width - 2 ? right - width + 2 : 0;
      if (delta) control.scrollBy({ left: delta, behavior: 'instant' });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(control);
    observer.observe(track);
    return () => observer.disconnect();
  }, [selected, options.length]);
  return (
    <div
      ref={ref}
      className={`segmented ${className}`}
      role={role}
      aria-label={label}
      style={
        {
          '--segmented-count': Math.max(options.length, 1),
          '--segmented-index': Math.max(selected, 0),
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const enabled = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const current = enabled.indexOf(event.target as HTMLButtonElement);
        if (current < 0 || !enabled.length) return;
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const step =
          event.key === 'ArrowRight'
            ? rtl
              ? -1
              : 1
            : event.key === 'ArrowLeft'
              ? rtl
                ? 1
                : -1
              : event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowUp'
                  ? -1
                  : 0;
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? enabled.length - 1
              : step
                ? (current + step + enabled.length) % enabled.length
                : null;
        if (next === null) return;
        event.preventDefault();
        enabled[next].focus({ preventScroll: true });
        enabled[next].click();
      }}
    >
      <div className="segmented-track">
        {selected >= 0 && <span className="segmented-indicator" aria-hidden="true" />}
        {options.map((option, index) => (
          <button
            type="button"
            key={option.value}
            role={role === 'radiogroup' ? 'radio' : undefined}
            aria-checked={role === 'radiogroup' ? option.value === value : undefined}
            aria-pressed={role === 'group' ? option.value === value : undefined}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.icon && (
              <span className="segmented-icon" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
