import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, Info, RefreshCw } from './icons.tsx';
import type { UsagePage, UsageSummary } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton } from './ui.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import {
  ActivityCard,
  ModelBreakdown,
  UsageBars,
  cacheHitRate,
  modelColors,
  percent,
  tokenSum,
} from './UsageCharts.tsx';
import type { Bucket, Day, Series } from './UsageCharts.tsx';

const quotaNames: Record<string, string | undefined> = {
  five_hour: '5 小时额度',
  seven_day: '每周额度',
  seven_day_opus: 'Opus 每周额度',
  seven_day_sonnet: 'Sonnet 每周额度',
  seven_day_oauth_apps: '应用每周额度',
  // Read from a long-lived token's replies, which do not name the models it counts.
  seven_day_overage_included: '按模型计的每周额度',
};
// The service names a per-model weekly window `seven_day:<model>`, as the account's plan reports it.
export const quotaName = (name: string) =>
  quotaNames[name] ?? (name.startsWith('seven_day:') ? `${name.slice(10)} 每周额度` : undefined);
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
export const tokens = (value: number) =>
  value < 10000 ? value.toLocaleString('zh-CN') : compact.format(value);
export const dollars = (value: number) =>
  `$${value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(value >= 0.01 || value === 0 ? 2 : 4)}`;
export const seconds = (ms: number | null) =>
  ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const hour = 3600_000;
const dayMs = 24 * hour;
const presets = [
  ['today', '今日'],
  ['24h', '24 小时'],
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['custom', '自定义'],
] as const;
const presetTitles: Record<string, string> = {
  today: '今日',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
  '30d': '最近 30 天',
};
const measures = { costUsd: '等价费用', tokens: 'Token', requests: '请求数' } as const;
type Measure = keyof typeof measures;
const localInput = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const two = (value: number) => String(value).padStart(2, '0');
const shortDate = (at: Date) =>
  `${at.getMonth() + 1}/${at.getDate()} ${two(at.getHours())}:${two(at.getMinutes())}`;
const emptyBucket = (at: number): Bucket => ({
  at: new Date(at).toISOString(),
  requests: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
});
// Only the figures are wanted; the protocol asks for at least one record, which is ignored.
const figuresOnly = { limit: 1 } as const;

type Range = { from: number; to: number; bucketMinutes: number; key: string };
// A range's figures with the range they cover and its name, so that what is shown always describes itself while
// another range is being read.
type Read = { key: string; page: UsagePage; range: Range; name: string };

export default function UsagePanel({
  client,
  summary,
  initial,
  back,
}: {
  client: ProxyClient;
  summary: UsageSummary | null;
  initial: string;
  back: () => void;
}) {
  const [preset, setPreset] = useState(initial);
  const [customFrom, setCustomFrom] = useState(() => localInput(new Date(Date.now() - 24 * hour)));
  const [customTo, setCustomTo] = useState(() => localInput(new Date()));
  // The custom range is read once its fields have been still for a moment, not at every digit typed.
  const [custom, setCustom] = useState({ from: customFrom, to: customTo });
  useEffect(() => {
    const timer = setTimeout(() => setCustom({ from: customFrom, to: customTo }), 400);
    return () => clearTimeout(timer);
  }, [customFrom, customTo]);
  const [model, setModel] = useState('');
  const [measure, setMeasure] = useState<Measure>('costUsd');
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  // Counts the refresh button's presses: the activity is read again only then.
  const [refreshes, setRefreshes] = useState(0);
  const [base, setBase] = useState<Read | null>(null);
  const [baseLoading, setBaseLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each model's own figures for the range, read once per range: changing the model filter reads nothing.
  const [perModel, setPerModel] = useState<{ key: string; pages: Record<string, UsagePage> }>({
    key: '',
    pages: {},
  });
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitFailed, setSplitFailed] = useState(false);
  const [activity, setActivity] = useState<UsagePage | null>(null);
  const [activityState, setActivityState] = useState<'loading' | 'done' | 'failed'>('loading');
  const offsetMinutes = -new Date().getTimezoneOffset();
  const offsetMs = offsetMinutes * 60_000;
  // Local days counted since 1970-01-01, the way the service buckets a day.
  const dayIndex = (time: number) => Math.floor((time + offsetMs) / dayMs);
  // The calendar shows a year where the service keeps its sums for good, else the days it keeps requests.
  const retention = summary?.keepsHistory ? 365 : (summary?.retentionDays ?? 35);
  // Only the chosen period's start, not the whole summary, which the account page reads again on its own.
  const windowStart = summary?.windows.find((item) => item.name === preset)?.startedAt;
  const range = useMemo((): Range => {
    const now = loadedAt;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const from = windowStart
      ? Date.parse(windowStart)
      : preset === 'today'
        ? midnight.getTime()
        : preset === '24h'
          ? now - 24 * hour
          : preset === '7d'
            ? now - 7 * 24 * hour
            : preset === '30d'
              ? now - 30 * 24 * hour
              : new Date(custom.from).getTime() || now - 24 * hour;
    const to = preset === 'custom' ? new Date(custom.to).getTime() || now : now;
    const span = Math.max(to - from, hour);
    const bucketMinutes = span <= 6 * hour ? 30 : span <= 48 * hour ? 60 : 1440;
    return { from, to, bucketMinutes, key: `${from}|${to}|${bucketMinutes}` };
  }, [preset, custom, windowStart, loadedAt]);
  const query = (extra: { model?: string } = {}) =>
    client.fetch({
      type: 'usage.query',
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      ...extra,
      ...figuresOnly,
      bucketMinutes: range.bucketMinutes,
      offsetMinutes,
    });

  // The range's figures for every model together.
  useEffect(() => {
    let current = true;
    setBaseLoading(true);
    setError(null);
    setSplitFailed(false);
    const quota = quotaName(preset);
    const name =
      presetTitles[preset] ??
      (quota
        ? `本期${quota}`
        : `${shortDate(new Date(range.from))} – ${shortDate(new Date(range.to))}`);
    query().then(
      (page) => {
        if (!current) return;
        setBase({ key: range.key, page, range, name });
        setBaseLoading(false);
      },
      (reason: unknown) => {
        if (!current) return;
        setError(reason instanceof Error ? reason.message : '读取失败。');
        setBaseLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [client, range.key]);

  // The days kept, for the activity calendar; read on opening and on refresh, whatever the range.
  const firstDay = dayIndex(loadedAt) - retention + 1;
  useEffect(() => {
    let current = true;
    setActivityState('loading');
    void client
      .fetch({
        type: 'usage.query',
        from: new Date(firstDay * dayMs - offsetMs).toISOString(),
        to: new Date(Date.now()).toISOString(),
        ...figuresOnly,
        bucketMinutes: 1440,
        offsetMinutes,
      })
      .then(
        (page) => {
          if (!current) return;
          setActivity(page);
          setActivityState('done');
        },
        () => {
          if (current) setActivityState('failed');
        },
      );
    return () => {
      current = false;
    };
  }, [client, refreshes, retention]);

  // Colours by the costliest models of the days kept, so a model keeps its colour from range to range.
  const colors = useMemo(() => {
    const order = [
      ...(activity?.byModel ?? []).map((row) => row.model),
      ...(base?.page.byModel ?? []).map((row) => row.model),
    ];
    return modelColors([...new Set(order)]);
  }, [activity, base]);

  // While another range is read, the last one stays in view.
  const page = base?.page;
  const view = base?.range ?? range;
  const only = page && page.byModel.length === 1 ? page.byModel[0].model : null;
  const pageOf = (name: string) =>
    name === only ? page : base && perModel.key === base.key ? perModel.pages[name] : undefined;
  // Each coloured model is read on its own, and the chosen model if it is not one of them; with one model in the
  // range, the range's figures are its own.
  const wanted = useMemo(() => {
    if (!base || base.key !== range.key || activityState === 'loading') return [];
    const models = base.page.byModel.map((row) => row.model);
    if (models.length < 2) return model && !models.includes(model) ? [model] : [];
    return [...new Set([...models.filter((name) => colors.has(name)), ...(model ? [model] : [])])];
  }, [base, range.key, activityState, colors, model]);
  useEffect(() => {
    const missing = wanted.filter((name) => !(perModel.key === range.key && perModel.pages[name]));
    if (!missing.length) {
      setSplitLoading(false);
      return;
    }
    let current = true;
    const key = range.key;
    setSplitLoading(true);
    // What arrived is kept even when another model's read failed.
    void Promise.allSettled(missing.map((name) => query({ model: name }))).then((results) => {
      if (!current) return;
      const pages = Object.fromEntries(
        results.flatMap((result, index) =>
          result.status === 'fulfilled' ? [[missing[index], result.value] as const] : [],
        ),
      );
      setPerModel((previous) => ({
        key,
        pages: { ...(previous.key === key ? previous.pages : {}), ...pages },
      }));
      setSplitFailed(results.some((result) => result.status === 'rejected'));
      setSplitLoading(false);
    });
    return () => {
      current = false;
      setSplitLoading(false);
    };
  }, [wanted]);

  // Every bucket of the range, empty ones too, so the time axis stays even.
  const slots = useMemo(() => {
    const step = view.bucketMinutes * 60_000;
    const align = (time: number) => Math.floor((time + offsetMs) / step) * step - offsetMs;
    const result: number[] = [];
    for (let at = align(view.from); at <= view.to && result.length < 400; at += step)
      result.push(at);
    return result;
  }, [view, offsetMs]);
  const fill = (series: Bucket[] | undefined) => {
    const values = new Map((series ?? []).map((item) => [Date.parse(item.at), item]));
    return slots.map((at) => values.get(at) ?? emptyBucket(at));
  };
  const measured = (bucket: Bucket) => (measure === 'tokens' ? bucket.tokens : bucket[measure]);

  const chosen = model ? pageOf(model) : page;
  const totals = chosen?.totals;
  const buckets = fill(chosen?.series);
  const split =
    !model && page && page.byModel.length > 1
      ? page.byModel.filter((row) => colors.has(row.model))
      : [];
  const splitReady = split.length > 0 && split.every((row) => pageOf(row.model));
  let series: Series[];
  if (model)
    series = [{ key: model, name: model, color: colors.of(model), values: buckets.map(measured) }];
  else if (only)
    series = [{ key: only, name: only, color: colors.of(only), values: buckets.map(measured) }];
  else if (splitReady) {
    series = split.map((row) => ({
      key: row.model,
      name: row.model,
      color: colors.of(row.model),
      values: fill(pageOf(row.model)!.series).map(measured),
    }));
    const rest = page!.byModel.length - split.length;
    if (rest > 0) {
      const values = buckets.map((bucket, index) => {
        const left = measured(bucket) - series.reduce((sum, item) => sum + item.values[index], 0);
        return left > 1e-9 ? left : 0;
      });
      series.push({
        key: '其他',
        name: `其他（${rest} 个模型）`,
        color: 'var(--model-other)',
        values,
      });
    }
  } else
    series = [
      {
        key: '全部模型',
        name: '全部模型',
        color: 'var(--model-other)',
        values: buckets.map(measured),
      },
    ];
  const sparks: Record<string, number[] | undefined> = {};
  for (const row of page?.byModel ?? []) {
    const own = pageOf(row.model);
    if (own && colors.has(row.model)) sparks[row.model] = fill(own.series).map(measured);
  }

  const format = (value: number) =>
    measure === 'costUsd'
      ? dollars(value)
      : measure === 'tokens'
        ? tokens(value)
        : value.toLocaleString('zh-CN');
  const daily = view.bucketMinutes >= 1440;
  const bucketLabel = (at: string) =>
    new Date(at).toLocaleString(
      'zh-CN',
      daily
        ? { month: 'numeric', day: 'numeric' }
        : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    );
  const axisLabel = (at: string, previous: string | undefined) => {
    const date = new Date(at);
    const day = `${two(date.getMonth() + 1)}-${two(date.getDate())}`;
    if (daily) return day;
    const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
    return !previous || new Date(previous).getDate() !== date.getDate() ? `${day} ${time}` : time;
  };
  const chartTitle = daily
    ? '每日用量'
    : view.bucketMinutes === 60
      ? '每小时用量'
      : '每 30 分钟用量';
  const subtitle = (base?.name ?? '') + (model ? ` · ${model}` : '');

  const days: Day[] = useMemo(() => {
    const byDay = new Map(
      (activity?.series ?? []).map((item) => [dayIndex(Date.parse(item.at)), item]),
    );
    return Array.from({ length: retention }, (_, offset) => ({
      index: firstDay + offset,
      bucket: byDay.get(firstDay + offset),
    }));
  }, [activity, firstDay, retention]);
  const firstRecord = summary?.firstRecordAt ? dayIndex(Date.parse(summary.firstRecordAt)) : null;

  const loading = baseLoading || splitLoading || activityState === 'loading';
  const quotaWindows = summary?.windows.filter((window) => quotaName(window.name)) ?? [];
  const perRequest = (value: number) =>
    totals && totals.requests ? value / totals.requests : null;
  return (
    <section className="account-page usage-page" aria-label="调用日志">
      <header className="account-heading">
        <IconButton title="返回账号" onClick={back}>
          <ArrowLeft />
        </IconButton>
        <h1>调用日志</h1>
        <IconButton
          title="刷新调用日志"
          disabled={loading}
          onClick={() => {
            setLoadedAt(Date.now());
            setRefreshes((count) => count + 1);
          }}
        >
          <RefreshCw className={loading ? 'spinning' : ''} />
        </IconButton>
      </header>
      <div className="account-body usage-body">
        {/* The time range in five steps, and the quota's current periods apart in a list (spec §5.3: a segmented
            control holds at most five choices). Choosing in one leaves the other unset. */}
        <div className="usage-filters">
          <SegmentedControl
            label="时间范围"
            value={preset}
            options={presets.map(([value, label]) => ({ value, label }))}
            onChange={(value) => {
              setPreset(value);
              setLoadedAt(Date.now());
            }}
          />
          {quotaWindows.length > 0 && (
            <select
              aria-label="额度周期"
              className={quotaWindows.some((window) => window.name === preset) ? 'chosen' : ''}
              value={quotaWindows.some((window) => window.name === preset) ? preset : ''}
              onChange={(event) => {
                setPreset(event.target.value);
                setLoadedAt(Date.now());
              }}
            >
              <option value="" disabled>
                额度周期
              </option>
              {quotaWindows.map((window) => (
                <option key={window.name} value={window.name}>
                  本期{quotaName(window.name)}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="模型"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">全部模型</option>
            {[...new Set([...(page?.models ?? []), ...(model ? [model] : [])])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {preset === 'custom' && (
            <div className="usage-custom">
              <input
                type="datetime-local"
                aria-label="开始时间"
                value={customFrom}
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
              <span>至</span>
              <input
                type="datetime-local"
                aria-label="结束时间"
                value={customTo}
                min={customFrom}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </div>
          )}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="usage-tiles">
          <div>
            <span>
              等价费用
              <span
                className="usage-info"
                tabIndex={0}
                role="img"
                title="官方 CLI 按 API 价格估算，非订阅账单"
                aria-label="官方 CLI 按 API 价格估算，非订阅账单"
              >
                <Info aria-hidden="true" />
              </span>
              <em className="usage-tag">不是扣费</em>
            </span>
            <strong>{totals ? dollars(totals.costUsd) : '—'}</strong>
            <small>
              {perRequest(totals?.costUsd ?? 0) != null
                ? `平均每次请求 ${dollars(perRequest(totals!.costUsd)!)}`
                : ''}
            </small>
          </div>
          <div>
            <span>请求数</span>
            <strong>{totals ? totals.requests.toLocaleString('zh-CN') : '—'}</strong>
            <small>
              {perRequest(totals?.durationMs ?? 0) != null
                ? `平均用时 ${seconds(perRequest(totals!.durationMs))}`
                : ''}
            </small>
          </div>
          <div
            title={
              totals
                ? `输入 ${totals.inputTokens.toLocaleString()} · 输出 ${totals.outputTokens.toLocaleString()} · 缓存读取 ${totals.cacheReadTokens.toLocaleString()} · 缓存写入 ${totals.cacheCreationTokens.toLocaleString()}`
                : undefined
            }
          >
            <span>Token</span>
            <strong>{totals ? tokens(tokenSum(totals)) : '—'}</strong>
            <small>
              {totals
                ? `输入 ${tokens(totals.inputTokens)} · 输出 ${tokens(totals.outputTokens)} · 缓存 ${tokens(totals.cacheReadTokens + totals.cacheCreationTokens)}`
                : ''}
            </small>
          </div>
          <div title="缓存读取 ÷（输入 + 缓存读取 + 缓存写入）">
            <span>缓存命中率</span>
            <strong>{percent(totals ? cacheHitRate(totals) : null)}</strong>
            <small>{totals ? `读取 ${tokens(totals.cacheReadTokens)}` : ''}</small>
          </div>
          <div>
            <span>输出速度</span>
            <strong>
              {totals?.outputPerSecond != null ? `${totals.outputPerSecond.toFixed(1)} tok/s` : '—'}
            </strong>
            <small>{totals ? `平均首字 ${seconds(totals.ttftMs)}` : ''}</small>
          </div>
        </div>
        <figure className="usage-card usage-chart" aria-busy={baseLoading || splitLoading}>
          <figcaption>
            <span className="usage-card-title">
              <strong>{chartTitle}</strong>
              <span>{subtitle}</span>
            </span>
            <SegmentedControl
              label="图表指标"
              value={measure}
              options={(Object.keys(measures) as Measure[]).map((value) => ({
                value,
                label: measures[value],
              }))}
              onChange={setMeasure}
            />
          </figcaption>
          {series.length > 1 && (
            <ul className="usage-legend" aria-label="图例">
              {series.map((item) => (
                <li key={item.key}>
                  <i style={{ '--c': item.color } as CSSProperties} />
                  {item.name}
                </li>
              ))}
            </ul>
          )}
          {splitFailed && !model && (
            <p className="muted usage-note">按模型拆分读取失败，已显示合计。</p>
          )}
          {splitFailed && model && !chosen ? (
            <p className="error-text usage-empty" role="alert">
              这个模型的用量读取失败，点右上角刷新重试。
            </p>
          ) : !page || (model && !chosen) ? (
            <span className="skeleton usage-chart-skeleton" />
          ) : !totals?.requests && chosen ? (
            <p className="muted usage-empty">这个范围内没有调用。</p>
          ) : (
            <UsageBars
              title={chartTitle}
              buckets={buckets}
              series={series}
              format={format}
              label={bucketLabel}
              axisLabel={axisLabel}
              tokens={tokens}
              dollars={dollars}
            />
          )}
          {page && page.byModel.length > 0 && (
            <ModelBreakdown
              models={page.byModel}
              totals={page.totals}
              colors={colors}
              sparks={sparks}
              selected={model}
              tokens={tokens}
              dollars={dollars}
            />
          )}
        </figure>
        <ActivityCard
          days={days}
          firstRecord={firstRecord}
          loading={activityState === 'loading' && !activity}
          failed={activityState === 'failed'}
          tokens={tokens}
          dollars={dollars}
        />
        {summary && (
          <p className="account-updated">
            {summary.keepsHistory
              ? `单次调用明细保留 ${summary.retentionDays} 天，按小时的用量统计长期保存`
              : `用量数据保留 ${summary.retentionDays} 天`}
            {summary.firstRecordAt
              ? `，最早一条：${new Date(summary.firstRecordAt).toLocaleString('zh-CN')}`
              : ''}
            。
          </p>
        )}
      </div>
    </section>
  );
}
