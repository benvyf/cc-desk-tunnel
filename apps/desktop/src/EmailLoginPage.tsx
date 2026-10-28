import Brand from './Brand.tsx';
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
  manual,
}: {
  form: ConnectionForm;
  change: (input: Partial<ConnectionForm>) => void;
  submit: () => void;
  connecting: boolean;
  error: string | null;
  workspaces: { id: string; name: string }[] | null;
  choose: (id: string) => void;
  manual: () => void;
}) {
  return (
    <main className="login-page">
      <div className="window-drag" />
      <div className="login-content">
        <Brand />
        <section className="login-card" aria-labelledby="email-login-heading">
          <div className="login-title">
            <h1 id="email-login-heading">{workspaces ? '选择工作空间' : '登录 CC SPACE'}</h1>
          </div>
          <p className="login-subtitle">
            {workspaces ? form.email : '连接你的工作空间，继续创作与开发。'}
          </p>
          {workspaces ? (
            <div className="connection-form">
              {!workspaces.length && <p role="status">暂未分配工作空间，请联系管理员。</p>}
              {workspaces.map((space) => (
                <Button key={space.id} disabled={connecting} onClick={() => choose(space.id)}>
                  {space.name}
                </Button>
              ))}
            </div>
          ) : (
            <form
              className="connection-form"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label>
                邮箱
                <input
                  autoFocus
                  type="email"
                  value={form.email ?? ''}
                  required
                  autoComplete="username"
                  onChange={(e) => change({ email: e.target.value })}
                  placeholder="输入邮箱"
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={form.password ?? ''}
                  autoComplete="current-password"
                  onChange={(e) => change({ password: e.target.value })}
                  placeholder={form.remember ? '输入密码，或使用已记住的登录' : '输入登录密码'}
                />
              </label>
              <div className="login-options">
                <label>
                  <input
                    type="checkbox"
                    checked={form.remember}
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
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="login-submit"
                disabled={connecting}
              >
                {connecting ? '正在登录…' : '登录'}
              </Button>
              <p className="login-hint">忘记密码？请联系管理员重置。</p>
            </form>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <Button disabled={connecting} onClick={manual}>
            使用服务地址连接
          </Button>
        </section>
      </div>
    </main>
  );
}
