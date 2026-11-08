import { BrandMark } from './Brand.tsx';
import { CalendarClock, Download, MessagesSquare, Plus, Search } from './icons.tsx';
import type { MenuPosition } from './ui.tsx';

export type Page = 'chat' | 'schedules' | 'settings';

// The side column folded to its narrow form: shown only while the column is closed, it keeps what the column
// offers at hand — a new session, search, the pages and the account. The update button is there only when there
// is something to install.
export default function Rail({
  page,
  schedules = true,
  go,
  newSession,
  canCreate,
  search,
  connected,
  update,
  updatePopup = 'menu',
  openUpdate,
  openAccount,
}: {
  page: Page;
  schedules?: boolean;
  go: (page: Page) => void;
  newSession: () => void;
  canCreate: boolean;
  search: () => void;
  connected: boolean;
  update: string | null;
  updatePopup?: 'menu' | 'dialog';
  openUpdate: (position: MenuPosition) => void;
  openAccount: (position: MenuPosition) => void;
}) {
  // A menu opens beside the rail, clear of its edge, and grows upward from the button's foot.
  const beside = (element: HTMLElement): MenuPosition => {
    const box = element.getBoundingClientRect();
    const rail = element.closest('.rail')!.getBoundingClientRect();
    return { x: rail.right + 6, y: box.bottom, above: true };
  };
  return (
    <nav className="rail" aria-label="页面">
      <button
        type="button"
        className="rail-new"
        title="新建会话"
        aria-label="新建会话"
        disabled={!canCreate}
        onClick={newSession}
      >
        <Plus />
      </button>
      <button type="button" title="搜索" aria-label="搜索" onClick={search}>
        <Search />
      </button>
      <button
        type="button"
        title="会话"
        aria-label="会话"
        aria-current={page === 'chat' ? 'page' : undefined}
        onClick={() => go('chat')}
      >
        <MessagesSquare weight={page === 'chat' ? 'bold' : 'regular'} />
      </button>
      {schedules && (
        <button
          type="button"
          title="定时任务"
          aria-label="定时任务"
          aria-current={page === 'schedules' ? 'page' : undefined}
          onClick={() => go('schedules')}
        >
          <CalendarClock weight={page === 'schedules' ? 'bold' : 'regular'} />
        </button>
      )}
      <span className="rail-space" />
      {update && (
        <button
          type="button"
          className="rail-update"
          title={update}
          aria-label="更新"
          aria-haspopup={updatePopup}
          onClick={(event) => openUpdate(beside(event.currentTarget))}
        >
          <Download />
        </button>
      )}
      <button
        type="button"
        className="rail-avatar"
        title={connected ? '设置与账号 · 已连接' : '设置与账号 · 重连中'}
        aria-label="设置与账号"
        aria-haspopup="menu"
        aria-current={page === 'settings' ? 'page' : undefined}
        onClick={(event) => openAccount(beside(event.currentTarget))}
      >
        <BrandMark className="account-mark" />
        <i className={`connection-dot${connected ? ' online' : ''}`} />
      </button>
    </nav>
  );
}
