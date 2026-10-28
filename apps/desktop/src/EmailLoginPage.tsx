import { useState } from 'react';
import Brand from './Brand.tsx';
import { ArrowRight, ShieldCheck } from './icons.tsx';
import { Button } from './ui.tsx';
import type { ConnectionForm } from './LoginPage.tsx';

export default function EmailLoginPage({
  form,
  change,
  submit,
  connecting,
  error,
  workspaces,
  choose,
  back,
}: {
  form: ConnectionForm;
  change: (input: Partial<ConnectionForm>) => void;
  submit: () => void;
  connecting: boolean;
  error: string | null;
  workspaces: { id: string; name: string }[] | null;
  choose: (id: string) => void;
  back: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const alert = error && (
    <p className="error-text email-login-error" role="alert">
      {error}
    </p>
  );
  return (
    <main className="login-page email-login-page">
      <div className="window-drag" />
      <div className="login-content">
        <Brand />
        <section
          className="login-card email-login-card"
          aria-labelledby="email-login-heading"
          aria-busy={connecting}
        >
          <p className="email-login-eyebrow">你的专属工作空间</p>
          <div className="login-title">
            <h1 id="email-login-heading">{workspaces ? '选择工作空间' : '登录 CC SPACE'}</h1>
          </div>
          <p className="login-subtitle">
            {workspaces ? form.email : '使用邮箱登录，继续你的创作与开发。'}
          </p>
          {workspaces ? (
            <div className="connection-form email-workspaces">
              {!workspaces.length && <p role="status">暂未分配工作空间，请联系管理员。</p>}
              {workspaces.map((space) => (
                <Button
                  className="email-workspace"
                  key={space.id}
                  disabled={connecting}
                  onClick={() => choose(space.id)}
                >
                  <span>{space.name}</span>
                  <ArrowRight />
                </Button>
              ))}
              {alert}
              <Button
                variant="ghost"
                disabled={connecting}
                onClick={() => {
                  setShowPassword(false);
                  back();
                }}
              >
                返回邮箱登录
              </Button>
            </div>
          ) : (
            <form
              className="connection-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!connecting) submit();
              }}
            >
              <label>
                邮箱
                <input
                  autoFocus
                  type="email"
                  value={form.email ?? ''}
                  required
                  disabled={connecting}
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(e) => change({ email: e.target.value })}
                  placeholder="输入你的邮箱"
                />
              </label>
              <label htmlFor="email-login-password">密码</label>
              <div className="email-password-field">
                <input
                  id="email-login-password"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password ?? ''}
                  disabled={connecting}
                  autoComplete="current-password"
                  onChange={(e) => change({ password: e.target.value })}
                  placeholder={form.remember ? '输入密码，或使用已记住的登录' : '输入登录密码'}
                />
                <button
                  type="button"
                  className="email-password-toggle"
                  disabled={connecting}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
              <div className="login-options">
                <label>
                  <input
                    type="checkbox"
                    checked={form.remember}
                    disabled={connecting}
                    onChange={(e) =>
                      change({
                        remember: e.target.checked,
                        autoLogin: e.target.checked && form.autoLogin,
                      })
                    }
                  />
                  记住登录
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.autoLogin}
                    disabled={connecting}
                    onChange={(e) =>
                      change({
                        autoLogin: e.target.checked,
                        remember: e.target.checked || form.remember,
                      })
                    }
                  />
                  自动登录
                </label>
              </div>
              {alert}
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="login-submit"
                disabled={connecting}
              >
                {connecting ? '正在登录…' : '登录'}
                {!connecting && <ArrowRight />}
              </Button>
              <p className="email-login-help">忘记密码？请联系管理员重置。</p>
            </form>
          )}
          <div className="email-login-policy">
            <ShieldCheck />
            <p>同一账号仅限一台电脑在线，新电脑登录后，旧电脑会自动退出。</p>
          </div>
        </section>
        <p className="email-login-footer">账号与工作空间由 CC 管理中心统一管理</p>
      </div>
    </main>
  );
}
