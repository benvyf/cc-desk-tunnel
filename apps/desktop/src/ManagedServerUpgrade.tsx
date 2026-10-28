import { useEffect, useRef, useState } from 'react';
import type { ConnectionForm } from './LoginPage.tsx';
import type { ServerCheck, ServerStatus } from '../../server/src/managed-server-http.ts';

export type ManagedServerConnection =
  Pick<ConnectionForm, 'url' | 'fingerprint' | 'token'> | { nodeId: string };
export type ManagedServerConfirmation = ManagedServerConnection & {
  confirmed: true;
  build: number;
  sha256: string;
};
const bootstrap =
  '旧服务端需首次接入：打开 CC管理中心的客户端更新页，在 Ubuntu 控制台运行一次接入命令；之后可从客户端升级。';
const explanations: Record<ServerCheck['reason'], string> = {
  available: '',
  current: '服务端已是当前可用构建，无需升级。若连接时仍提示协议不匹配，请安装匹配的最新客户端。',
  'protocol-unavailable':
    '没有更高且匹配本客户端协议的服务端构建。请从 CC管理中心获取最新客户端；不能降级服务端。',
  'manual-image-upgrade': '此版本涉及运行环境或数据兼容性变更，需要管理员在 Ubuntu 升级配套镜像。',
  disabled: bootstrap,
  busy: '服务端正在处理会话、终端或其他工作。请结束工作后重新检查。',
};
const progress: Record<ServerStatus['phase'], string> = {
  idle: '等待服务端开始升级…',
  staging: '正在下载并验证服务端…',
  stopping: '正在停止旧服务…',
  backup: '正在备份服务数据…',
  switching: '正在切换服务端程序…',
  probing: '正在验证新服务…',
  committed: '服务端升级已完成，请手动连接。',
  'rolled-back': '升级未通过验证，已回滚到原版本。请查看服务端日志后重试。',
  failed: '服务端升级失败，请查看服务端日志并联系管理员。',
};

export default function ManagedServerUpgrade({
  form,
  disabled,
  activity,
  autoCheck = false,
  checked,
  nodeId,
  reconnect,
}: {
  form: ConnectionForm;
  disabled: boolean;
  activity: (working: boolean) => void;
  autoCheck?: boolean;
  checked?: () => void;
  nodeId?: string;
  reconnect?: () => void;
}) {
  const [candidate, setCandidate] = useState<ServerCheck['candidate']>(null);
  const [working, setWorking] = useState(false);
  const [text, setText] = useState('');
  const [help, setHelp] = useState(false);
  const [canReconnect, setCanReconnect] = useState(true);
  const generation = useRef(0);
  const api = window.desktop!.managedServer;
  useEffect(() => {
    generation.current++;
    setCandidate(null);
    setText('');
    setHelp(false);
    setCanReconnect(true);
    setWorking(false);
    activity(false);
    return () => {
      generation.current++;
      activity(false);
      void api.cancel().catch(() => {});
    };
  }, [nodeId, form.url, form.fingerprint, form.token, api, activity]);
  const credentials = (): ManagedServerConnection =>
    nodeId
      ? { nodeId }
      : {
          url: form.url,
          fingerprint: form.fingerprint,
          token: form.token.trim(),
        };
  const message = (error: unknown) =>
    error instanceof Error ? error.message : '服务端升级失败，请重新检查。';
  async function check() {
    const own = ++generation.current;
    setCandidate(null);
    setWorking(true);
    activity(true);
    setHelp(false);
    setText('正在验证配套服务端发布签名…');
    try {
      const result = await api.check(credentials());
      if (own !== generation.current) return;
      setCandidate(result.reason === 'available' ? result.candidate : null);
      setText(
        `当前版本 ${result.current.appVersion} · Build ${result.current.build}。${explanations[result.reason]}`,
      );
      setHelp(
        result.reason === 'disabled' ||
          result.reason === 'manual-image-upgrade' ||
          result.reason === 'protocol-unavailable',
      );
    } catch (error) {
      if (own !== generation.current) return;
      setText(message(error));
      setHelp(true);
    } finally {
      if (own === generation.current) {
        setWorking(false);
        activity(false);
      }
    }
  }
  useEffect(() => {
    if (autoCheck && !disabled) {
      checked?.();
      void check();
    }
  }, [autoCheck, disabled]);
  async function install() {
    if (!candidate) return;
    const own = ++generation.current,
      target = candidate;
    const alive = () => own === generation.current;
    setCandidate(null);
    setWorking(true);
    setCanReconnect(false);
    activity(true);
    setText('正在准备升级；服务重启期间网络暂时中断是正常现象…');
    try {
      try {
        await api.install({
          ...credentials(),
          confirmed: true,
          build: target.build,
          sha256: target.sha256,
        });
      } catch (error) {
        if (!/网络请求失败/.test(message(error))) throw error;
      }
      const deadline = Date.now() + 5 * 60000;
      while (alive() && Date.now() < deadline) {
        try {
          const status = await api.status(credentials());
          if (!alive()) return;
          setText(progress[status.phase]);
          if (['committed', 'rolled-back', 'failed'].includes(status.phase)) {
            setCanReconnect(status.phase !== 'failed');
            return;
          }
        } catch (error) {
          if (!alive()) return;
          if (!/网络请求失败/.test(message(error))) throw error;
          setText('服务正在重启，暂时无法查询；正在等待管理接口恢复…');
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (alive()) setText('等待升级结果超时。请检查服务端状态后手动连接；不要重复安装。');
    } catch (error) {
      if (alive()) setText(message(error));
    } finally {
      if (alive()) {
        setWorking(false);
        activity(false);
        await api.cancel().catch(() => {});
      }
    }
  }
  return (
    <section className="managed-server-upgrade" aria-label="配套服务端升级">
      <button
        className="button login-submit"
        type="button"
        disabled={disabled || working}
        onClick={() => void check()}
      >
        检查服务端更新
      </button>
      <p className="muted">
        按构建号检查配套服务端；协议相同也可升级。先结束任务并关闭其他 CC 连接，确认目标后才安装。
      </p>
      {text && <p role="status">{text}</p>}
      {candidate && (
        <>
          <p>
            目标版本 {candidate.appVersion} · Build {candidate.build} · 协议 {candidate.protocol}
          </p>
          <p>升级需要重启服务。确认后才会安装，完成后请手动连接。</p>
          <button
            className="button login-submit"
            type="button"
            disabled={disabled || working}
            onClick={() => void install()}
          >
            确认升级到 Build {candidate.build}
          </button>
        </>
      )}
      {canReconnect && reconnect && (
        <button
          type="button"
          className="button primary"
          disabled={disabled || working}
          onClick={reconnect}
        >
          重新连接
        </button>
      )}
      {(working || candidate) && (
        <button
          className="button"
          type="button"
          onClick={() => {
            generation.current++;
            setCandidate(null);
            setWorking(false);
            activity(false);
            setText('已取消等待。如已提交升级，服务端会继续，请检查服务端状态后手动连接。');
            void api.cancel().catch(() => {});
          }}
        >
          取消等待
        </button>
      )}
      {help && (
        <button
          className="button"
          type="button"
          onClick={() => {
            void api
              .openManager()
              .catch(() =>
                setText(
                  '无法打开 CC管理中心，请访问 https://api.ghostapi.org/cc-updates/admin/updates',
                ),
              );
          }}
        >
          打开 CC管理中心
        </button>
      )}
    </section>
  );
}
