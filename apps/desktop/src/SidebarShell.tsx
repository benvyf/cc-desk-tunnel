import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { BrandMark } from './Brand.tsx';
import { ArrowLeft, ChevronsUpDown, Download, Search, X } from './icons.tsx';
import SidebarResize from './SidebarResize.tsx';
import { IconButton } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';

// The side column every page shares: the way back to the conversations when the page is another one, a
// heading, the page's own list, and the account at the foot. Only the list scrolls.
export default function SidebarShell({
  open,
  resizable = true,
  back,
  header,
  footer,
  asideRef,
  children,
}: {
  open: boolean;
  // Off where the column is not inside the window's shell (this computer's settings before signing in).
  resizable?: boolean;
  back?: () => void;
  header: ReactNode;
  footer?: ReactNode;
  asideRef?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <aside className="sidebar" inert={!open} ref={asideRef}>
      {resizable && <SidebarResize open={open} />}
      {back && (
        <button type="button" className="sidebar-back" onClick={back}>
          <ArrowLeft />
          返回会话
        </button>
      )}
      <div className="sidebar-brand">{header}</div>
      {children}
      {footer}
    </aside>
  );
}

// One search field for the side column, the same wherever a list is searched.
export function SearchField({
  label,
  close,
  inputRef,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label'> & {
  label: string;
  // Given where the field stands in for a row and can be put away again.
  close?: () => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className={`session-search${close ? ' closable' : ''}`}>
      <Search />
      <input {...props} ref={inputRef} aria-label={label} />
      {close && (
        <IconButton
          title="关闭搜索"
          className="session-search-close"
          // Keeps the field from losing focus first, which would already put it away.
          onMouseDown={(event) => event.preventDefault()}
          onClick={close}
        >
          <X />
        </IconButton>
      )}
    </label>
  );
}

// A menu opened from the foot of the column grows upward from the control.
export const above = (element: HTMLElement): MenuPosition => {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top - 4, above: true };
};
// The account's menu grows upward from the account area, as wide as it and lined up with its edges (Claude's).
const spanning = (element: HTMLElement): MenuPosition => {
  const area = element.closest('.sidebar-account') ?? element;
  const box = area.getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(area).paddingLeft) || 0;
  return { x: box.left + inset, y: box.top - 4, above: true, width: box.width - 2 * inset };
};

// The account at the foot of the side column: who is signed in, on which plan, and whether the connection
// holds. It opens the menu of settings, help and disconnecting; an update waiting to be installed sits beside it.
export function AccountArea({
  name,
  plan,
  connected,
  adapter,
  current = false,
  openMenu,
  update,
  updatePopup = 'menu',
  openUpdate,
}: {
  name: string;
  plan?: string;
  connected: boolean;
  // What runs behind the connection, told on hover.
  adapter: string;
  current?: boolean;
  openMenu: (position: MenuPosition) => void;
  update: string | null;
  updatePopup?: 'menu' | 'dialog';
  openUpdate: (position: MenuPosition) => void;
}) {
  const who = useId();
  return (
    <div className="sidebar-account">
      <button
        type="button"
        className="side-account-button"
        aria-label="设置与账号"
        aria-describedby={who}
        aria-haspopup="menu"
        aria-current={current ? 'page' : undefined}
        title={adapter}
        onClick={(event) => openMenu(spanning(event.currentTarget))}
      >
        <span className="side-avatar">
          <BrandMark className="account-mark" />
        </span>
        <span className="side-account-who" id={who}>
          <strong>{name}</strong>
          <small className="connection-status">
            <i className={`connection-dot${connected ? ' online' : ''}`} />
            {plan ? `${plan} · ` : ''}
            {connected ? '已连接' : '重连中'}
          </small>
        </span>
        <ChevronsUpDown className="side-account-chevron" />
      </button>
      {update && (
        <button
          type="button"
          className="side-account-update"
          title={update}
          aria-label="更新"
          aria-haspopup={updatePopup}
          onClick={(event) => openUpdate(above(event.currentTarget))}
        >
          <Download />
        </button>
      )}
    </div>
  );
}
