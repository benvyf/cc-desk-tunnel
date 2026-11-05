import { useEffect, useState } from 'react';
import Presence from './Presence.tsx';
import { Modal } from './ui.tsx';

export type InstallerCleanupInfo = { name: string; path: string; size: number };

export default function InstallerCleanupDialog() {
  const [installer, setInstaller] = useState<InstallerCleanupInfo | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = window.desktop?.installerCleanup;
  useEffect(() => {
    let active = true;
    if (typeof api?.inspect === 'function')
      void api.inspect().then(
        (value) => {
          if (active) setInstaller(value);
        },
        () => {},
      );
    return () => {
      active = false;
    };
  }, []);
  async function keep() {
    try {
      await api!.keep();
    } finally {
      setInstaller(null);
    }
  }
  async function remove() {
    setWorking(true);
    setError(null);
    try {
      await api!.remove();
      setInstaller(null);
    } catch (cause) {
      const text =
        cause instanceof Error ? cause.message : '暂时无法移至回收站，请重试或保留安装包。';
      setError(
        text.replace(/^Error invoking remote method 'installer-cleanup:remove': (?:Error: )?/, ''),
      );
    } finally {
      setWorking(false);
    }
  }
  return (
    <Presence kind="dialog">
      {installer && (
        <Modal
          title="清理安装包"
          initialFocus="[data-keep-installer]"
          onClose={() => {
            void keep().catch(() => {});
          }}
        >
          <p>安装已完成，本次安装包已不再需要。是否移至回收站？</p>
          <p className="installer-cleanup-file">
            {installer.name} · {(installer.size / 1024 ** 2).toFixed(1)} MB
          </p>
          <p className="muted installer-cleanup-file">{installer.path}</p>
          <p className="muted">不会影响已安装的软件、账号或聊天记录。可从回收站恢复。</p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="setting-actions">
            <button
              className="button"
              data-keep-installer
              disabled={working}
              onClick={() => {
                void keep().catch(() => {});
              }}
            >
              保留安装包
            </button>
            <button
              className="button primary"
              disabled={working}
              onClick={() => {
                void remove();
              }}
            >
              {working ? '正在移至回收站…' : '移至回收站'}
            </button>
          </div>
        </Modal>
      )}
    </Presence>
  );
}
