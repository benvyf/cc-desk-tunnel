import { useEffect, useState } from 'react';
import { Modal } from './ui.tsx';

export default function ClientUpgradeDialog({
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
