import { useState, useSyncExternalStore } from 'react';
import type { DeviceShell } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';

export default function ShellSettings({ client }: { client: ProxyClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const device = state.devices.find((device) => device.id === state.device?.id);
  const available = device?.shells ?? [];
  const ready = state.status === 'connected' && !!state.deviceShells && !!device?.ready;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function choose(value: string) {
    setSaving(true);
    setError('');
    try {
      await client.request({ type: 'device.shell', shell: value ? (value as DeviceShell) : null });
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="page">
      <div className="page-body">
        <h1 className="page-title">Shell</h1>
        <p className="muted">
          设置这台电脑执行项目命令时的偏好；其他可用 Shell 仍可使用。SSH 目标使用它自己的 Bash。
        </p>
        <h2 className="page-heading">这台电脑</h2>
        <div className="card">
          <div className="setting-row">
            <span>
              <strong>首选 Shell</strong>
              <small>默认使用 PowerShell 7；聊天在下一条消息生效，已打开的终端需重新打开</small>
            </span>
            <select
              aria-label="首选 Shell"
              value={device?.shell ?? ''}
              disabled={!ready || saving}
              onChange={(event) => void choose(event.target.value)}
            >
              <option value="">默认</option>
              <option value="pwsh">PowerShell 7</option>
              <option value="bash" disabled={!available.includes('bash')}>
                Git Bash{!available.includes('bash') ? '（未检测到）' : ''}
              </option>
            </select>
          </div>
          <div className="setting-row">
            <span>
              <strong>Git Bash</strong>
              <small>
                {!ready
                  ? '连接支持多 Shell 的服务端并等待本机执行通道就绪后读取'
                  : available.includes('bash')
                    ? '已检测到，Claude 可按任务选择 Git Bash 或 PowerShell 7'
                    : '未检测到。安装 Git for Windows 后重新连接即可。'}
              </small>
            </span>
          </div>
        </div>
        {state.status === 'connected' && !state.deviceShells && (
          <p className="muted">此服务端尚不支持 Shell 设置，请通过现有更新入口获取配套新版。</p>
        )}
        {device?.shell === 'bash' && ready && !available.includes('bash') && (
          <p role="status">
            已保存 Git Bash 偏好，但当前不可用；现在使用 PowerShell 7。重新安装并连接后恢复。
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
