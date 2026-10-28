import { ChevronRight, Download, Globe, Laptop, Unplug } from './icons.tsx';
import Brand from './Brand.tsx';
import { useEffect, useState } from 'react';
import { thisDevice } from './device.ts';
import { useConnectionName } from './shared.ts';
import { Button } from './ui.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';

export type ConnectionForm = {
  authMethod?: 'email' | 'manual';
  email?: string;
  password?: string;
  url: string;
  token: string;
  fingerprint: string;
  mode: 'local' | 'remote';
  // Desktop only: keep the token (encrypted for this Windows account) and connect on the next launch.
  remember: boolean;
  autoLogin: boolean;
};

export default function LoginPage({
  form,
  change,
  connecting,
  error,
  upgrade,
  direct,
  downloaded,
  install,
  older,
  newer,
  showNotes,
  recover,
  submit,
}: {
  form: ConnectionForm;
  change: (values: Partial<ConnectionForm>) => void;
  connecting: boolean;
  error: string | null;
  // The version of the installer a service of another version offers this client.
  upgrade: string | null;
  // The service's version, when this client is the older one: its installer can be fetched from the release
  // page instead, and `downloaded` is how far that is, from 0 to 1.
  direct: string | null;
  downloaded: number | null;
  // Fetches and runs the installer the service holds, or the given version's from the release page.
  install: (version?: string) => void;
  // The service's version, when it refused this client as the newer one: it can be asked to upgrade itself.
  older: string | null;
  // The version the service is at or offers, when it is newer than this client: its notes can be read.
  newer: string | null;
  // Shows what a version changed.
  showNotes: (version: string) => void;
  recover?: () => void;
  submit: () => void;
}) {
  const connectionName = useConnectionName();
  const hasFingerprint = !!form.fingerprint;
  const [advancedOpen, setAdvancedOpen] = useState(hasFingerprint);
  useEffect(() => {
    if (hasFingerprint) setAdvancedOpen(true);
  }, [hasFingerprint]);
  const [serviceUpgrade, setServiceUpgrade] = useState<{
    phase: 'running' | 'done' | 'failed';
    text: string;
  } | null>(null);
  function upgradeService(service: string) {
    if (!window.confirm(`服务端 ${service} 将升级到最新的正式版并重启，需要几分钟。继续？`)) return;
    setServiceUpgrade({ phase: 'running', text: '正在升级服务端' });
    const stop = window.desktop!.onServiceUpgrade(
      (update) =>
        update.detail &&
        setServiceUpgrade({ phase: 'running', text: `正在升级服务端：${update.detail}` }),
    );
    void thisDevice()
      .then((device) =>
        window.desktop!.upgradeService({
          url: form.url,
          fingerprint: form.fingerprint,
          token: form.token.trim(),
          deviceName: device.name,
          service,
        }),
      )
      .then(({ version, error }) =>
        setServiceUpgrade(
          version
            ? { phase: 'done', text: `服务端已升级到 ${version}，正在重启；稍候再连接。` }
            : { phase: 'failed', text: error ?? '服务端升级失败。' },
        ),
      )
      .finally(stop);
  }
  const shownError =
    serviceUpgrade && serviceUpgrade.phase !== 'running' ? serviceUpgrade.text : error;
  return (
    <main className="login-page">
      <div className="window-drag" />
      <div className="login-content">
        <Brand connectionName={connectionName} />
        <section className="login-card" aria-labelledby="login-heading">
          <div className="login-title">
            <h1 id="login-heading">连接代理服务</h1>
            {form.mode === 'local' && <span className="badge simulation">离线模拟</span>}
          </div>
          <p className="login-subtitle">连接你的工作空间，继续创作与开发。</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setServiceUpgrade(null);
              submit();
            }}
            className="connection-form"
          >
            {window.desktop?.dev && (
              <SegmentedControl
                className="connection-modes"
                label="连接方式"
                value={form.mode}
                options={[
                  { value: 'local', label: '本地模拟', icon: <Laptop /> },
                  { value: 'remote', label: '远程代理', icon: <Globe /> },
                ]}
                onChange={(mode) => change({ mode })}
              />
            )}
            <label>
              服务地址
              <input
                autoFocus
                type="url"
                value={form.url}
                onChange={(event) => change({ url: event.target.value })}
                required
                spellCheck={false}
                placeholder="wss://your-server:8443/ws"
              />
            </label>
            <label>
              服务凭据
              <input
                type="password"
                value={form.token}
                onChange={(event) => change({ token: event.target.value })}
                required
                autoComplete="off"
                placeholder="输入服务凭据"
              />
            </label>
            {form.mode === 'remote' && (
              <details
                className="login-advanced"
                open={advancedOpen}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              >
                <summary
                  onClick={(event) => {
                    // Native toggle is deferred; update visibility and keyboard access together.
                    event.preventDefault();
                    setAdvancedOpen((value) => !value);
                  }}
                >
                  <ChevronRight />
                  高级连接选项
                </summary>
                <div
                  className="login-advanced-grid"
                  inert={!advancedOpen}
                  aria-hidden={!advancedOpen}
                >
                  <div className="login-advanced-content">
                    <label>
                      服务证书指纹（可选）
                      <input
                        aria-label="服务证书指纹"
                        aria-describedby="login-certificate-hint"
                        value={form.fingerprint}
                        onChange={(event) => change({ fingerprint: event.target.value })}
                        placeholder="留空使用 CA 验证"
                        spellCheck={false}
                      />
                    </label>
                    <p id="login-certificate-hint" className="login-hint">
                      使用自签名证书时，填写服务端提供的指纹。
                    </p>
                  </div>
                </div>
              </details>
            )}
            {window.desktop && (
              <div className="login-options">
                <label>
                  <input
                    type="checkbox"
                    checked={form.remember}
                    onChange={(event) =>
                      change({
                        remember: event.target.checked,
                        autoLogin: event.target.checked && form.autoLogin,
                      })
                    }
                  />
                  记住凭据
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.autoLogin}
                    onChange={(event) =>
                      change({
                        autoLogin: event.target.checked,
                        remember: event.target.checked || form.remember,
                      })
                    }
                  />
                  自动登录
                </label>
              </div>
            )}
            {shownError && (
              <p className="error-text" role="alert">
                {shownError}
              </p>
            )}
            {recover && (
              <Button
                size="lg"
                className="login-submit"
                type="button"
                disabled={connecting}
                onClick={recover}
              >
                处理连接版本不匹配
              </Button>
            )}
            {upgrade && (
              <Button
                size="lg"
                className="login-submit"
                type="button"
                disabled={connecting}
                onClick={() => install()}
              >
                <Download />
                升级客户端到 {upgrade}
              </Button>
            )}
            {older && serviceUpgrade?.phase !== 'done' && (
              <Button
                size="lg"
                className="login-submit"
                type="button"
                disabled={connecting || serviceUpgrade?.phase === 'running'}
                onClick={() => upgradeService(older)}
              >
                <Download />
                {serviceUpgrade?.phase === 'running' ? serviceUpgrade.text : '升级服务端'}
              </Button>
            )}
            {newer && (
              <Button size="lg" className="login-submit" onClick={() => showNotes(newer)}>
                查看 {newer} 的更新内容
              </Button>
            )}
            {direct && (
              <Button
                size="lg"
                className="login-submit"
                type="button"
                disabled={connecting}
                onClick={() => install(direct)}
              >
                <Download />
                {downloaded !== null
                  ? `正在从 GitHub 下载 ${Math.floor(downloaded * 100)}%`
                  : upgrade
                    ? `改从 GitHub 发布页下载 ${direct}`
                    : `从 GitHub 发布页下载并升级到 ${direct}`}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="login-submit"
              disabled={connecting}
            >
              <Unplug />
              {connecting ? '连接中…' : '连接'}
            </Button>
          </form>
        </section>
      </div>
    </main>
  );
}
