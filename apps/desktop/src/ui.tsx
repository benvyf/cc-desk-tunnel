import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Check, X } from './icons.tsx';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: ButtonSize;
}) {
  return (
    <button {...props} type={type} className={`button ${variant} ${className}`} data-size={size} />
  );
}

export function IconButton({
  title,
  children,
  size,
  className = '',
  type = 'button',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'aria-label'> & {
  title: string;
  children: ReactNode;
  size?: ButtonSize;
}) {
  return (
    <button
      {...props}
      className={`icon-button ${className}`}
      type={type}
      data-size={size}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

export function Switch({
  label,
  checked,
  disabled = false,
  small = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  // The 28×16 switch of a list row (a scheduled task); the usual one is 36×20.
  small?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className={small ? 'switch small' : 'switch'}
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  initialFocus,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    if (initialFocus) dialog?.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <IconButton title="关闭" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}

export type MenuItem = {
  label: string;
  // What a screen reader calls the item, when the visible label alone would not say what it is.
  name?: string;
  icon?: ReactNode;
  // A line under the label saying what the choice does.
  detail?: string;
  // Shown at the right edge: a keyboard shortcut or a current value.
  hint?: string;
  // Present on a choice among alternatives; the chosen one carries the mark.
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  // A rule is drawn above this item.
  separated?: boolean;
  run: () => void;
};
// `width`, when given, makes the menu as wide as the control it opens from (the account at the column's foot).
export type MenuPosition = { x: number; y: number; above?: boolean; width?: number };
// One menu serves right-click (opens at the pointer) and every button that opens a list beside itself.
export function Menu({
  label,
  x,
  y,
  above = false,
  width,
  heading,
  items,
  onClose,
}: MenuPosition & {
  label: string;
  heading?: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Whatever had focus when the menu opened (its button, or the row right-clicked) gets it back when the menu is
  // put away from the keyboard or by choosing an item; a click elsewhere keeps the focus where it went.
  const opener = useRef<Element | null>(null);
  const settle = () => {
    const back = opener.current;
    const now = document.activeElement;
    if (!(back instanceof HTMLElement) || !back.isConnected || back.closest('[inert]')) return;
    if (now && now !== document.body && !ref.current?.contains(now)) return;
    back.focus({ preventScroll: true });
  };
  const dismiss = () => {
    settle();
    onClose();
  };
  useLayoutEffect(() => {
    if (!opener.current) opener.current = document.activeElement;
    const menu = ref.current!;
    const { width, height } = menu.getBoundingClientRect();
    const top = above || y + height > innerHeight - 8 ? y - height : y;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    // The menu grows out of the side it opens from (style.css, .menu[data-placement]).
    menu.dataset.placement = top < y ? 'above' : 'below';
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, above, width]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div
      className="menu"
      role="menu"
      aria-label={label}
      ref={ref}
      style={width ? { width, minWidth: 0 } : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          dismiss();
          return;
        }
        // Tab leaves the menu as it leaves any list: from the control that opened it, on to the next.
        if (event.key === 'Tab') {
          dismiss();
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [
          ...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        if (event.key === 'Home' || event.key === 'End') {
          buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
          return;
        }
        const next =
          buttons.indexOf(document.activeElement as HTMLButtonElement) +
          (event.key === 'ArrowDown' ? 1 : -1);
        buttons[(next + buttons.length) % buttons.length]?.focus();
      }}
    >
      {heading && <p className="menu-heading">{heading}</p>}
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separated && <hr />}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            aria-label={item.name ?? item.label}
            className={`${item.danger ? 'danger' : ''} ${item.detail ? 'detailed' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              dismiss();
              item.run();
            }}
          >
            {item.icon}
            <span className="menu-label">
              {item.label}
              {item.detail && <small>{item.detail}</small>}
            </span>
            {item.hint && <kbd>{item.hint}</kbd>}
            {item.checked && <Check className="menu-check" />}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
