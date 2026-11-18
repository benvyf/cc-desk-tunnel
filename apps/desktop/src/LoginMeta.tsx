import { ChevronRight, Download } from './icons.tsx';

// Above the sign-in card, so it is in view however short the window: an update this client can take, as a
// full-width notice rather than a corner icon (there is no settings page before signing in).
export function LoginUpdateNotice({ notice, open }: { notice: string | null; open: () => void }) {
  if (!notice) return null;
  return (
    <button type="button" className="login-update-banner" aria-haspopup="dialog" onClick={open}>
      <Download />
      <span className="login-update-text">{notice}</span>
      <span className="login-update-action">
        查看
        <ChevronRight />
      </span>
    </button>
  );
}

// Below the sign-in card: the client's own version, so a user can say which one they run.
export function LoginVersion({ version, build }: { version: string; build?: number }) {
  if (!version) return null;
  return (
    <p className="login-version">
      CC Space 客户端 {version}
      {build ? ` · Build ${build}` : ''}
    </p>
  );
}
