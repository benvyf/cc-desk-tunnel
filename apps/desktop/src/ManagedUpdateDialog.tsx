import { useEffect, useState } from 'react';
import type { ManagedUpdateState } from './managed-update.ts';
import RichText from './RichText.tsx';
import { Modal } from './ui.tsx';

export default function ManagedUpdateDialog({
  state,
  blocked,
  connected,
  canDisconnect,
  disconnect,
  onClose,
  server,
}: {
  state: ManagedUpdateState;
  blocked: boolean;
  connected: boolean;
  canDisconnect: boolean;
  disconnect: () => void;
  onClose: () => void;
  server?: { version: string | null; disabled: boolean; open: () => void };
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { phase, identity, release } = state;
  useEffect(() => setError(null), [phase, state.message, release?.build]);
  const incompatible = !!release && !!identity && release.protocol !== identity.protocol;
  const working = pending || ['checking', 'downloading', 'preparing', 'installing'].includes(phase);
  const progress = release?.size
    ? Math.min(100, Math.max(0, Math.round(((state.received ?? 0) / release.size) * 100)))
    : 0;

  async function run(action: 'check' | 'download' | 'install' | 'cancel') {
    setPending(true);
    setError(null);
    try {
      const api = window.desktop!.managedUpdate;
      if (action === 'install') await api.activity({ blocked });
      await api[action]();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新失败，请重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title="更新" onClose={onClose}>
      <h3>客户端</h3>
      <div className="managed-update-summary">
        {identity && (
          <p className="muted">
            当前版本：{identity.appVersion} · Build {identity.build}
          </p>
        )}
        {release && (
          <p>
            目标版本：{release.appVersion} · Build {release.build}
          </p>
        )}
        {incompatible ? (
          <p role="status">此版本涉及协议变更，请在 CC 管理中心安排客户端与服务端配套升级。</p>
        ) : phase !== 'error' ? (
          <p role="status">
            {phase === 'ready'
              ? '下载完成。请先断开所有 CC 连接并结束任务，再安装并重启。'
              : phase === 'downloading'
                ? `正在下载更新：${progress}%`
                : phase === 'checking'
                  ? '正在检查更新…'
                  : phase === 'available'
                    ? '有新的客户端版本可以下载。'
                    : phase === 'idle'
                      ? '当前没有可用更新。'
                      : state.message}
          </p>
        ) : null}
        {phase === 'downloading' && (
          <progress aria-label="更新下载进度" max={100} value={progress} />
        )}
        {(error || phase === 'error') && (
          <p className="error-text" role="alert">
            {(phase === 'error' ? state.message : error) || error || '更新失败，请重试。'}
          </p>
        )}
      </div>
      {release?.notes && (
        <div className="release-notes">
          <RichText text={release.notes} />
        </div>
      )}
      <div className="setting-actions">
        {phase === 'available' && !incompatible && (
          <button
            className="button primary"
            disabled={working}
            onClick={() => void run('download')}
          >
            下载更新
          </button>
        )}
        {phase === 'downloading' && (
          <button className="button" onClick={() => void run('cancel')}>
            取消下载
          </button>
        )}
        {phase === 'ready' && !incompatible && (
          <>
            {connected && (
              <button className="button" disabled={!canDisconnect || working} onClick={disconnect}>
                断开当前连接
              </button>
            )}
            <button
              className="button primary"
              disabled={blocked || working}
              onClick={() => void run('install')}
            >
              安装并重启
            </button>
          </>
        )}
        {['idle', 'error'].includes(phase) && (
          <button className="button" disabled={working} onClick={() => void run('check')}>
            重新检查
          </button>
        )}
      </div>
      {server && (
        <section className="managed-update-server" aria-label="服务端更新">
          <h3>服务端</h3>
          <p className="muted">当前版本：{server.version ?? '未连接'}</p>
          <p>检查后显示可升级版本。升级前会断开连接，完成后可重新连接。</p>
          <button
            type="button"
            className="button"
            disabled={server.disabled || working}
            onClick={server.open}
          >
            检查服务端更新
          </button>
        </section>
      )}
      <div className="setting-actions">
        <button className="button" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
