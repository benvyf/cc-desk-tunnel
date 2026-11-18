import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui.tsx';
import { useManagedUpdate, type ManagedUpdateState } from './managed-update.ts';

type ManagedUpdateApi = NonNullable<NonNullable<Window['desktop']>['managedUpdate']>;

// An update of this client's own protocol the channel offers when the required one is not there (an older
// client meeting a newer workspace: the bridge build comes first). It installs as any same-protocol update.
function stepFor(state: ManagedUpdateState, requiredProtocol: number) {
  const { identity, release } = state;
  return identity &&
    release &&
    release.protocol !== requiredProtocol &&
    release.protocol === identity.protocol &&
    release.build > identity.build
    ? release
    : null;
}

// The interim update stays offered once seen: a failed download publishes an error without a release, and the
// way on is to retry it, not to be told to ask the administrator.
function useStep(state: ManagedUpdateState, requiredProtocol: number, looking: boolean) {
  const seen = looking ? stepFor(state, requiredProtocol) : null;
  const [kept, setKept] = useState<typeof seen>(null);
  useEffect(() => {
    if (seen) setKept(seen);
  }, [seen?.build]);
  if (!looking) return null;
  return seen ?? (state.phase === 'error' ? kept : null);
}

// Install that interim update: the connection is let go first, as an install requires.
async function installStep(
  api: ManagedUpdateApi,
  blocked: () => boolean,
  step: NonNullable<ReturnType<typeof stepFor>>,
) {
  // A requirement held (by this window, or the main process for the management center) has the controller choose
  // the other protocol's release; this one is the client's own. Letting go of none is a no-op.
  await api.releaseRequirement?.();
  await window.desktop!.disconnectProxy();
  const current = await api.state();
  const ready = current.phase === 'ready' ? current : await api.download();
  // Only the build the button names: the channel may have moved on since it was shown.
  if (ready.release?.build !== step.build || ready.release.protocol !== step.protocol)
    throw new Error('更新通道里的版本已变化，请重新检查。');
  if (blocked()) throw new Error('请先结束正在运行的任务、终端和登录流程，再更新。');
  await api.activity({ blocked: blocked() });
  await api.install();
}

function StepNotice({
  step,
  state,
}: {
  step: NonNullable<ReturnType<typeof stepFor>>;
  state: ManagedUpdateState;
}) {
  const progress = step.size
    ? Math.min(100, Math.max(0, Math.round(((state.received ?? 0) / step.size) * 100)))
    : 0;
  return (
    <>
      <p>
        需要先更新到 {step.appVersion} · Build {step.build}
        。安装后客户端会自动重启，重新登录时即可一键更新到配套版本。
      </p>
      {step.notes && <p className="muted managed-update-notes">{step.notes}</p>}
      {state.phase === 'downloading' && <p role="status">正在下载… {progress}%</p>}
      {state.phase === 'ready' && <p role="status">更新已下载，可以安装。</p>}
      {state.phase === 'preparing' && <p role="status">正在准备安装，请稍候…</p>}
      {state.phase === 'installing' && <p role="status">安装器即将启动，客户端会自动关闭。</p>}
    </>
  );
}
const stepLabel = (state: ManagedUpdateState, build: number) =>
  state.phase === 'ready' ? `安装 Build ${build}` : `先更新到 Build ${build}`;

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
  const step = useStep(state, requiredProtocol, asked === 'asked' && !release);
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
  async function updateStep() {
    setWorking(true);
    setError(null);
    try {
      await installStep(api!, () => blockedRef.current, step!);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新失败，请重试。');
    } finally {
      setWorking(false);
    }
  }
  if (manual || (asked === 'failed' && state.phase === 'disabled'))
    return (
      <ManualUpgrade requiredProtocol={requiredProtocol} blocked={blocked} onClose={onClose} />
    );
  return (
    <Modal title="需要更新客户端" onClose={() => !busy && putOff()}>
      <p>工作空间已升级，需要更新 CC Space 客户端后才能继续使用。你的账号和聊天记录会保留。</p>
      {asked === 'asking' && <p role="status">正在检查配套客户端…</p>}
      {asked === 'asked' && !release && !step && phase !== 'checking' && (
        <p role="status">更新通道里还没有配套的客户端，请联系管理员发布后重新检查。</p>
      )}
      {step && <StepNotice step={step} state={state} />}
      {step && blocked && <p className="muted">请先结束正在运行的任务、终端和登录流程，再更新。</p>}
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
          {/* The controller's own account of a failed update reads better than the IPC rejection. */}
          {phase === 'error' && state.message ? state.message : error}
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
        {step && (
          <button
            className="button primary"
            disabled={busy || blocked}
            onClick={() => void updateStep()}
          >
            {working ? '正在更新…' : stepLabel(state, step.build)}
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
  blocked = false,
  onClose,
}: {
  requiredProtocol: number;
  blocked?: boolean;
  onClose: () => void;
}) {
  const api = window.desktop?.managedUpdate;
  const state = useManagedUpdate();
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [release, setRelease] = useState<{ build: number; appVersion: string } | null>();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [working, setWorking] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setRelease(undefined);
    setError(null);
    void (async () => {
      // Checked now, not at the next scheduled check: an update of this client's own protocol may come first.
      // Its failure is the update notice's to show; the full installer below stays the way out. One after the
      // other: the controller runs one operation at a time and refuses a second.
      await api?.check().catch(() => {});
      if (!active) return;
      try {
        const value = await window.desktop!.access.upgradeInfo(requiredProtocol);
        if (active) setRelease(value);
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : '无法检查配套客户端，请联系管理员。');
      }
    })();
    return () => {
      active = false;
    };
  }, [requiredProtocol, lookupAttempt]);
  const step = useStep(state, requiredProtocol, release === null && !!api);
  // The interim update under way holds the dialog open; opening the browser download does not.
  const stepping =
    working || (!!step && ['downloading', 'preparing', 'installing'].includes(state.phase));
  // A background check holds nothing.
  const busy = opening || stepping;
  async function updateStep() {
    setWorking(true);
    setError(null);
    try {
      await installStep(api!, () => blockedRef.current, step!);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新失败，请重试。');
    } finally {
      setWorking(false);
    }
  }
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
    <Modal title="需要升级客户端" onClose={() => !stepping && onClose()}>
      <p>此工作空间已更新，请升级 CC Space 客户端后重新登录。你的账号和聊天记录会保留。</p>
      {!error && release === undefined && <p role="status">正在检查配套客户端…</p>}
      {release === null && !step && <p role="status">配套客户端尚未发布，请联系管理员。</p>}
      {step && <StepNotice step={step} state={state} />}
      {step && blocked && <p className="muted">请先结束正在运行的任务、终端和登录流程，再更新。</p>}
      {release && (
        <>
          <p>
            配套版本：{release.appVersion} · Build {release.build}
          </p>
          <p className="muted">下载后请结束任务并关闭所有 CC Space 窗口，再安装新版。</p>
        </>
      )}
      {(error || (step && state.phase === 'error' && state.message)) && (
        <p className="error-text" role="alert">
          {step && state.phase === 'error' && state.message ? state.message : error}
        </p>
      )}
      <div className="setting-actions">
        {(error || release === null) && (
          <button
            className="button"
            disabled={busy}
            onClick={() => setLookupAttempt((value) => value + 1)}
          >
            重新检查
          </button>
        )}
        <button className="button" disabled={opening || working} onClick={onClose}>
          稍后升级
        </button>
        {step && (
          <button
            className="button primary"
            disabled={busy || blocked}
            onClick={() => void updateStep()}
          >
            {working ? '正在更新…' : stepLabel(state, step.build)}
          </button>
        )}
        {release && (
          <button className="button primary" disabled={opening} onClick={() => void download()}>
            {opening ? '正在打开下载…' : '下载新版客户端'}
          </button>
        )}
      </div>
    </Modal>
  );
}
