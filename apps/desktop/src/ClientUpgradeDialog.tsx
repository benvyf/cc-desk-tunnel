import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui.tsx';
import { useManagedUpdate } from './managed-update.ts';

// The workspace server was upgraded and refused this client as too old. Where this build updates itself, the
// client the server requires is fetched and installed here, in place, with every check a same-protocol update
// has (managed-controller.cjs requireProtocol); elsewhere the signed full installer is opened for download.
export default function ClientUpgradeDialog({
  requiredProtocol,
  blocked = false,
  onClose,
}: {
  requiredProtocol: number;
  // Something still running here holds the install back (App.tsx updateBlocked).
  blocked?: boolean;
  onClose: () => void;
}) {
  const api = window.desktop?.managedUpdate;
  const inPlace = !!api?.requireProtocol;
  const state = useManagedUpdate();
  const [asked, setAsked] = useState<'asking' | 'asked' | 'failed'>(inPlace ? 'asking' : 'failed');
  // This window cannot take the requirement (no workspace connection to vouch for it): the full installer, as
  // before, rather than a dead end.
  const [manual, setManual] = useState(!inPlace);
  const stateRef = useRef(state);
  stateRef.current = state;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const attempt = useRef(0);
  const ask = async () => {
    const turn = ++attempt.current;
    setAsked('asking');
    setError(null);
    try {
      // Already held (asked a moment ago, or by the main process for the management center): checked again only.
      // Read afresh: the state this window has seen may not yet include what the main process holds.
      const current = await api!.state().catch(() => stateRef.current);
      if (current.crossProtocol !== requiredProtocol)
        try {
          await api!.requireProtocol!(requiredProtocol);
        } catch {
          if (turn === attempt.current) setManual(true);
          return;
        }
      await api!.check().catch((cause: unknown) => {
        // A check made moments ago is throttled; the state it left still answers.
        if (!(cause instanceof Error && /30 秒/.test(cause.message))) throw cause;
      });
      if (turn === attempt.current) setAsked('asked');
    } catch (cause) {
      if (turn !== attempt.current) return;
      setAsked('failed');
      setError(cause instanceof Error ? cause.message : '无法检查配套客户端。');
    }
  };
  // Not let go when this dialog goes away: it goes as the update starts, and the install still needs it. It is
  // let go when the user puts the update off, and lapses by itself on reconnecting, signing out or in half an hour.
  useEffect(() => {
    if (inPlace) void ask();
  }, [requiredProtocol]);
  const putOff = () => {
    void api?.releaseRequirement?.().catch(() => {});
    onClose();
  };
  const release = state.release?.protocol === requiredProtocol ? state.release : null;
  const allowed = state.crossProtocol === requiredProtocol;
  const phase = state.phase;
  const busy = working || ['checking', 'downloading', 'preparing', 'installing'].includes(phase);
  const progress = release?.size
    ? Math.min(100, Math.max(0, Math.round(((state.received ?? 0) / release.size) * 100)))
    : 0;
  // Download if need be, then install: the connection is let go first, as an install requires.
  async function update() {
    setWorking(true);
    setError(null);
    try {
      await window.desktop!.disconnectProxy();
      if (phase !== 'ready') await api!.download();
      // As things stand now, not as they stood when the download began.
      if (blockedRef.current) throw new Error('请先结束正在运行的任务、终端和登录流程，再更新。');
      await api!.activity({ blocked: blockedRef.current });
      await api!.install();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新失败，请重试。');
    } finally {
      setWorking(false);
    }
  }
  if (manual || (asked === 'failed' && state.phase === 'disabled'))
    return <ManualUpgrade requiredProtocol={requiredProtocol} onClose={onClose} />;
  return (
    <Modal title="需要更新客户端" onClose={() => !busy && putOff()}>
      <p>工作空间已升级，需要更新 CC Space 客户端后才能继续使用。你的账号和聊天记录会保留。</p>
      {asked === 'asking' && <p role="status">正在检查配套客户端…</p>}
      {asked === 'asked' && !release && phase !== 'checking' && (
        <p role="status">更新通道里还没有配套的客户端，请联系管理员发布后重新检查。</p>
      )}
      {release && (
        <>
          <p>
            配套版本：{release.appVersion} · Build {release.build}
          </p>
          {release.notes && <p className="muted managed-update-notes">{release.notes}</p>}
          {phase === 'downloading' && <p role="status">正在下载… {progress}%</p>}
          {phase === 'preparing' && <p role="status">正在准备安装，请稍候…</p>}
          {phase === 'installing' && <p role="status">安装器即将启动，客户端会自动关闭。</p>}
          {asked === 'asked' && !allowed && (
            <p className="muted" role="status">
              更新授权已过期，请重新连接工作空间后再更新，或改用完整安装包。
            </p>
          )}
          {blocked && <p className="muted">请先结束正在运行的任务、终端和登录流程，再更新。</p>}
        </>
      )}
      {(error || (phase === 'error' && state.message)) && (
        <p className="error-text" role="alert">
          {error ?? state.message}
        </p>
      )}
      <div className="setting-actions">
        {(asked === 'failed' || (asked === 'asked' && !release)) && (
          <button className="button" disabled={busy} onClick={() => void ask()}>
            重新检查
          </button>
        )}
        <button className="button" disabled={busy} onClick={putOff}>
          稍后更新
        </button>
        {release && asked === 'asked' && !allowed && (
          <button className="button" disabled={busy} onClick={() => setManual(true)}>
            改用完整安装包
          </button>
        )}
        {release && (
          <button
            className="button primary"
            disabled={busy || blocked || !allowed}
            onClick={() => void update()}
          >
            {working ? '正在更新…' : '立即更新'}
          </button>
        )}
      </div>
    </Modal>
  );
}

// Where this build cannot update itself (a development build, another platform): the signed full installer,
// opened for download, as before.
function ManualUpgrade({
  requiredProtocol,
  onClose,
}: {
  requiredProtocol: number;
  onClose: () => void;
}) {
  const [release, setRelease] = useState<{ build: number; appVersion: string } | null>();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setRelease(undefined);
    setError(null);
    void window.desktop!.access.upgradeInfo(requiredProtocol).then(
      (value) => {
        if (active) setRelease(value);
      },
      (cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : '无法检查配套客户端，请联系管理员。');
      },
    );
    return () => {
      active = false;
    };
  }, [requiredProtocol, lookupAttempt]);
  async function download() {
    setOpening(true);
    setError(null);
    try {
      await window.desktop!.access.openUpgrade(requiredProtocol);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开下载，请联系管理员。');
    } finally {
      setOpening(false);
    }
  }
  return (
    <Modal title="需要升级客户端" onClose={onClose}>
      <p>此工作空间已更新，请升级 CC Space 客户端后重新登录。你的账号和聊天记录会保留。</p>
      {!error && release === undefined && <p role="status">正在检查配套客户端…</p>}
      {release === null && <p role="status">配套客户端尚未发布，请联系管理员。</p>}
      {release && (
        <>
          <p>
            配套版本：{release.appVersion} · Build {release.build}
          </p>
          <p className="muted">下载后请结束任务并关闭所有 CC Space 窗口，再安装新版。</p>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="setting-actions">
        {(error || release === null) && (
          <button
            className="button"
            disabled={opening}
            onClick={() => setLookupAttempt((value) => value + 1)}
          >
            重新检查
          </button>
        )}
        <button className="button" disabled={opening} onClick={onClose}>
          稍后升级
        </button>
        {release && (
          <button className="button primary" disabled={opening} onClick={() => void download()}>
            {opening ? '正在打开下载…' : '下载新版客户端'}
          </button>
        )}
      </div>
    </Modal>
  );
}
