import { useState } from 'react';
import { useManagedUpdate } from './managed-update.ts';

export default function ManagedUpdatePanel() {
  const state = useManagedUpdate();
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const api = window.desktop?.managedUpdate;
  const active = ['checking', 'downloading', 'preparing', 'installing'].includes(state.phase);
  async function act(action: 'check' | 'download' | 'install' | 'cancel') {
    if (!api) return;
    if (
      action === 'install' &&
      !window.confirm(
        '安装将退出此安装的所有连接窗口。请先断开远端连接，结束任务、原生终端和登录流程。继续？',
      )
    )
      return;
    setError('');
    setWorking(true);
    try {
      await api[action]();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="card" aria-label="定制客户端更新">
      <div className="page-body">
        <p>
          {state.identity
            ? `定制构建 ${state.identity.build} · ${state.identity.channel} · 协议 ${state.identity.protocol}`
            : '定制客户端更新'}
        </p>
        <p role="status">
          {state.message ??
            (state.phase === 'disabled'
              ? '此构建未启用定制在线更新。'
              : state.phase === 'checking'
                ? '正在检查更新…'
                : state.phase === 'installing'
                  ? '正在退出窗口并启动安装器…'
                  : '从管理员发布通道获取同协议更新。')}
        </p>
        {state.release && (
          <p>
            目标版本 {state.release.appVersion} · 构建 {state.release.build}
          </p>
        )}
        {state.release?.notes && <p style={{ whiteSpace: 'pre-wrap' }}>{state.release.notes}</p>}
        {state.phase === 'downloading' && state.release && (
          <progress
            aria-label="更新下载进度"
            max={state.release.size}
            value={state.received ?? 0}
          />
        )}
        {state.pending && (
          <p className="muted">
            构建 {state.pending.targetBuild} 的安装尚未确认；新版启动后确认完成。
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="setting-actions">
          <button
            className="button"
            disabled={!api || state.phase === 'disabled' || active || working}
            onClick={() => void act('check')}
          >
            检查定制更新
          </button>
          {state.phase === 'available' && (
            <button className="button" disabled={working} onClick={() => void act('download')}>
              下载更新
            </button>
          )}
          {state.phase === 'ready' && (
            <button className="button" disabled={working} onClick={() => void act('install')}>
              安装更新
            </button>
          )}
          {['checking', 'downloading', 'preparing'].includes(state.phase) && (
            <button className="button" onClick={() => void act('cancel')}>
              取消更新
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
