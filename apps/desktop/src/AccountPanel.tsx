import { useEffect, useState } from 'react';
import { UserRound, RefreshCw, Activity, ShieldCheck, ListOrdered } from './icons.tsx';
import type { NativeMetrics, UsageSummary } from '@cc-desk-tunnel/protocol';
import type {
  AccountState,
  NativeCapabilities,
} from '../../../packages/protocol/src/account-display.ts';
import UsagePanel, { dollars, quotaName, tokens } from './UsagePanel.tsx';
import type { ProxyClient } from './client.ts';
import { Button, IconButton } from './ui.tsx';

export default function AccountPanel({
  client,
  account: state,
  capabilities,
  metrics,
  refreshing,
  disabled,
  error,
  refresh,
}: {
  client: ProxyClient;
  account: AccountState | null;
  capabilities: NativeCapabilities | null;
  metrics: NativeMetrics | null;
  refreshing: boolean;
  disabled: boolean;
  error: string | null;
  refresh: () => void;
}) {
  const account = capabilities?.account;
  const signedOut = state?.loggedIn === false;
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client.fetch({ type: 'usage.summary' }).then(
      (result) => {
        if (current) setSummary(result);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, metrics?.rateLimits?.measuredAt, log]);
  if (log)
    return <UsagePanel client={client} summary={summary} initial={log} back={() => setLog(null)} />;
  return (
    <section className="account-page" aria-label="账号信息">
      <header className="account-heading">
        <h1>
          <UserRound />
          账号
        </h1>
        <IconButton title="刷新账号信息" disabled={disabled} onClick={refresh}>
          <RefreshCw className={refreshing ? 'spinning' : ''} />
        </IconButton>
      </header>
      <div className="account-body">
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="account-identity">
          <div className="account-avatar">
            <UserRound />
          </div>
          <div>
            <h2>
              {signedOut
                ? '尚未登录'
                : (state?.accountNumber ?? account?.accountNumber ?? '账号编号尚未读取')}
            </h2>
            <p>
              {signedOut
                ? '请在 Ubuntu 服务端登录 Claude Code'
                : (state?.subscriptionType ?? account?.subscriptionType ?? '套餐尚未读取')}
            </p>
          </div>
        </div>
        <dl className="account-details">
          <div>
            <dt>模型服务</dt>
            <dd>
              {account?.apiProvider === 'firstParty'
                ? 'Anthropic'
                : (account?.apiProvider ?? '未读取')}
            </dd>
          </div>
          <div>
            <dt>认证来源</dt>
            <dd>{account?.tokenSource ?? account?.apiKeySource ?? '未提供'}</dd>
          </div>
        </dl>
        <h2 className="account-section-title">
          <Activity />
          订阅用量
          <Button size="sm" onClick={() => setLog('today')}>
            <ListOrdered />
            调用日志
          </Button>
        </h2>
        {metrics?.rateLimits?.available ? (
          <div className="quota-list">
            {metrics.rateLimits.windows.map((window, index) => (
              <div className="quota-row" key={`${window.name}:${index}`}>
                <div>
                  <strong>{quotaName(window.name) ?? window.name}</strong>
                  <span>
                    {window.utilization == null
                      ? '使用量未提供'
                      : `${window.utilization}% 已用 · ${Math.max(0, 100 - window.utilization)}% 剩余`}
                  </span>
                </div>
                {window.utilization != null && (
                  <progress max={100} value={Math.min(100, window.utilization)} />
                )}
                <small>
                  {window.resetsAt
                    ? `重置：${new Date(window.resetsAt).toLocaleString('zh-CN')}`
                    : '重置时间未提供'}
                </small>
                {(() => {
                  const period = summary?.windows.find((item) => item.name === window.name);
                  return (
                    period && (
                      <button
                        type="button"
                        className="quota-period"
                        title="查看本周期的调用日志"
                        onClick={() => setLog(window.name)}
                      >
                        本周期 {period.requests.toLocaleString('zh-CN')} 次请求 ·{' '}
                        {tokens(
                          period.inputTokens +
                            period.outputTokens +
                            period.cacheReadTokens +
                            period.cacheCreationTokens,
                        )}{' '}
                        tokens · 等价 {dollars(period.costUsd)}
                      </button>
                    )
                  );
                })()}
              </div>
            ))}
            {!metrics.rateLimits.windows.length && (
              <p className="muted">原生接口未返回额度窗口。</p>
            )}
            <p className="account-updated">
              {metrics.rateLimits.measuredAt &&
                `更新于 ${new Date(metrics.rateLimits.measuredAt).toLocaleTimeString('zh-CN')}`}
            </p>
          </div>
        ) : (
          <p className="muted">
            {metrics?.errors?.usage ??
              (metrics?.rateLimits ? '当前账号未提供订阅额度' : '等待读取原生额度')}
          </p>
        )}
        <h2 className="account-section-title">
          <ShieldCheck />
          当前会话
        </h2>
        <dl className="account-details">
          <div>
            <dt>输入 / 输出</dt>
            <dd>
              {metrics?.usage
                ? `${metrics.usage.inputTokens.toLocaleString()} / ${metrics.usage.outputTokens.toLocaleString()} tokens`
                : '等待读取'}
            </dd>
          </div>
          <div>
            <dt>缓存读取 / 写入</dt>
            <dd>
              {metrics?.usage
                ? `${metrics.usage.cacheReadTokens.toLocaleString()} / ${metrics.usage.cacheWriteTokens.toLocaleString()} tokens`
                : '等待读取'}
            </dd>
          </div>
          <div>
            <dt>原生费用估算</dt>
            <dd>
              {metrics?.usage?.costUsd != null
                ? `$${metrics.usage.costUsd.toFixed(4)}（非订阅账单）`
                : '未提供'}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
