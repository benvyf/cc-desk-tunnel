import { useEffect, useState } from 'react';
import { RefreshCw, Activity, ShieldCheck, ListOrdered } from './icons.tsx';
import { BrandMark } from './Brand.tsx';
import type { NativeMetrics, UsageSummary } from '@cc-desk-tunnel/protocol';
import type {
  AccountState,
  NativeCapabilities,
} from '../../../packages/protocol/src/account-display.ts';
import UsagePanel, { dollars, quotaName, tokens } from './UsagePanel.tsx';
import type { ProxyClient } from './client.ts';
import { Button, IconButton, Switch } from './ui.tsx';
import { setPrefs, usePrefs } from './prefs.ts';

// A grey bar standing in for a value still being read, as wide as such a value usually is.
function Pending({ width }: { width: string }) {
  return <span className="skeleton" style={{ width }} aria-hidden="true" />;
}
const none = <span className="account-none">—</span>;

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
  const { quotaReads } = usePrefs();
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
  // Until the service has answered, the values are grey bars rather than words about waiting; once it has, a value it
  // does not give is a dash.
  const reading = !signedOut && !account && !state?.accountNumber && !error;
  const usageReading = !metrics && !error;
  const identity = signedOut
    ? { name: '尚未登录', plan: '请在 Ubuntu 服务端登录 Claude Code' }
    : {
        name: state?.accountNumber ?? account?.accountNumber,
        plan: state?.subscriptionType ?? account?.subscriptionType,
      };
  return (
    <section className="page account-page" aria-label="账号信息" aria-busy={reading || undefined}>
      <div className="page-body">
        <header className="page-title-row">
          <h1 className="page-title">账号</h1>
          <IconButton title="刷新账号信息" disabled={disabled} onClick={refresh}>
            <RefreshCw className={refreshing ? 'spinning' : ''} />
          </IconButton>
        </header>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="account-identity">
          {/* The avatar of the account at the column's foot (SidebarShell). */}
          <span className="side-avatar account-avatar">
            <BrandMark className="account-mark" />
          </span>
          <div>
            <h2>{identity.name ?? (reading ? <Pending width="9em" /> : '账号')}</h2>
            <p>{identity.plan ?? (reading ? <Pending width="4em" /> : '套餐未知')}</p>
          </div>
        </div>
        <dl className="account-details">
          <div>
            <dt>模型服务</dt>
            <dd>
              {account?.apiProvider === 'firstParty'
                ? 'Anthropic'
                : (account?.apiProvider ?? (reading ? <Pending width="6em" /> : none))}
            </dd>
          </div>
          <div>
            <dt>登录方式</dt>
            <dd>
              {account?.tokenSource ??
                account?.apiKeySource ??
                (reading ? <Pending width="5em" /> : none)}
            </dd>
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
                      ? '用量未知'
                      : `${window.utilization}% 已用 · ${Math.max(0, 100 - window.utilization)}% 剩余`}
                  </span>
                </div>
                {window.utilization != null && (
                  <progress max={100} value={Math.min(100, window.utilization)} />
                )}
                <small>
                  {window.resetsAt
                    ? `重置：${new Date(window.resetsAt).toLocaleString('zh-CN')}`
                    : '重置时间未知'}
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
            {!metrics.rateLimits.windows.length && <p className="muted">没有读到额度周期。</p>}
            <p className="account-updated">
              {metrics.rateLimits.measuredAt &&
                `更新于 ${new Date(metrics.rateLimits.measuredAt).toLocaleTimeString('zh-CN')}`}
            </p>
          </div>
        ) : usageReading ? (
          <div className="quota-list" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div className="quota-row quota-pending" key={index}>
                <div>
                  <Pending width="5em" />
                  <Pending width="7em" />
                </div>
                <span className="skeleton skeleton-bar" />
                <Pending width="11em" />
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            {metrics?.errors?.usage ??
              (metrics?.rateLimits ? '这个账号没有订阅额度。' : '还没有读到订阅额度。')}
          </p>
        )}
        <div className="setting-row quota-live">
          <span>
            <strong>运行中每分钟读取一次额度</strong>
            <small>关闭后只记录回复自带的额度，手动刷新仍会读取；与“常规”里是同一个设置。</small>
          </span>
          <Switch
            label="运行中每分钟读取一次额度"
            checked={quotaReads}
            onChange={(quotaReads) => setPrefs((prefs) => ({ ...prefs, quotaReads }))}
          />
        </div>
        <h2 className="account-section-title">
          <ShieldCheck />
          当前会话
        </h2>
        <dl className="account-details">
          <div>
            <dt>输入 / 输出</dt>
            <dd>
              {metrics?.usage ? (
                `${metrics.usage.inputTokens.toLocaleString()} / ${metrics.usage.outputTokens.toLocaleString()} tokens`
              ) : usageReading ? (
                <Pending width="10em" />
              ) : (
                none
              )}
            </dd>
          </div>
          <div>
            <dt>缓存读取 / 写入</dt>
            <dd>
              {metrics?.usage ? (
                `${metrics.usage.cacheReadTokens.toLocaleString()} / ${metrics.usage.cacheWriteTokens.toLocaleString()} tokens`
              ) : usageReading ? (
                <Pending width="10em" />
              ) : (
                none
              )}
            </dd>
          </div>
          <div>
            <dt title="Claude Code 按 API 价格算出的本会话费用；订阅账号不按它收费">
              按 API 价格估算
            </dt>
            <dd>
              {metrics?.usage?.costUsd != null ? (
                `$${metrics.usage.costUsd.toFixed(4)}（不是订阅账单）`
              ) : usageReading ? (
                <Pending width="5em" />
              ) : (
                none
              )}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
