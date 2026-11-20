import { useId, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { UsagePage } from '@cc-desk-tunnel/protocol';

export type Bucket = UsagePage['series'][number];
type Kinds = Pick<
  Bucket,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
>;
type Row = UsagePage['byModel'][number];

// The share of the prompt that was read from the cache instead of being processed again; null when nothing
// was sent at all.
export function cacheHitRate(item: Kinds) {
  const prompt = item.inputTokens + item.cacheReadTokens + item.cacheCreationTokens;
  return prompt ? item.cacheReadTokens / prompt : null;
}
export const percent = (value: number | null) =>
  value == null ? '—' : `${(value * 100).toFixed(value > 0.995 || value < 0.005 ? 0 : 1)}%`;
export const tokenSum = (item: Kinds) =>
  item.inputTokens + item.outputTokens + item.cacheReadTokens + item.cacheCreationTokens;

// The top of an axis: a round number at or above the peak whose half is round too, so a count never reads 2.5.
export function niceTop(peak: number) {
  if (!(peak > 0)) return 1;
  const unit = 10 ** Math.floor(Math.log10(peak));
  return [2, 4, 6, 8, 10].map((step) => step * unit).find((step) => step >= peak * (1 - 1e-9))!;
}

// Five models have colours of their own, in the order given (the costliest first); the rest share a grey.
const colored = 5;
export function modelColors(order: string[]) {
  const slots = new Map(order.slice(0, colored).map((model, index) => [model, index + 1]));
  return {
    has: (model: string) => slots.has(model),
    of: (model: string) => {
      const slot = slots.get(model);
      return slot ? `var(--model-${slot})` : 'var(--model-other)';
    },
  };
}
export type Colors = ReturnType<typeof modelColors>;
const dot = (color: string) => ({ '--c': color }) as CSSProperties;

export type Series = { key: string; name: string; color: string; values: number[] };

// Stacked columns, one per bucket, with the first series at the bottom. The pointer or the arrow keys pick a
// column, whose figures show beside it.
export function UsageBars({
  title,
  buckets,
  series,
  format,
  label,
  axisLabel,
  tokens,
  dollars,
}: {
  title: string;
  // The totals of each bucket, for the tip: of the chosen model, or of every model.
  buckets: Bucket[];
  series: Series[];
  format: (value: number) => string;
  label: (at: string) => string;
  axisLabel: (at: string, previous: string | undefined) => string;
  tokens: (value: number) => string;
  dollars: (value: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = buckets.map((_, index) =>
    series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0),
  );
  const top = niceTop(Math.max(...totals, 0));
  const step = Math.max(1, Math.ceil(buckets.length / 6));
  const ticks = buckets.flatMap((bucket, index) => (index % step === 0 ? [index] : []));
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = buckets.length - 1;
    const at = hover ?? (event.key === 'ArrowLeft' ? last + 1 : -1);
    const next =
      event.key === 'ArrowLeft'
        ? at - 1
        : event.key === 'ArrowRight'
          ? at + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : undefined;
    if (event.key === 'Escape' && hover !== null) {
      event.stopPropagation();
      setHover(null);
      return;
    }
    if (next === undefined || last < 0) return;
    event.preventDefault();
    setHover(Math.min(Math.max(next, 0), last));
  };
  const shown = hover !== null ? buckets[hover] : undefined;
  const parts =
    hover !== null && series.length > 1
      ? series
          .map((item) => ({ ...item, value: item.values[hover] ?? 0 }))
          .filter((item) => item.value > 0)
          .reverse()
      : [];
  const describe = (bucket: Bucket) =>
    `${label(bucket.at)}：${bucket.requests.toLocaleString('zh-CN')} 次请求，${format(
      totals[buckets.indexOf(bucket)] ?? 0,
    )}`;
  return (
    <>
      <div className="usage-plot" onMouseLeave={() => setHover(null)}>
        <div className="usage-scale" aria-hidden="true">
          <span>{format(top)}</span>
          <span>{format(top / 2)}</span>
          <span>0</span>
        </div>
        <div
          className="usage-bars"
          tabIndex={0}
          role="group"
          aria-label={`${title}，左右方向键逐个查看`}
          onKeyDown={key}
          onBlur={() => setHover(null)}
        >
          {buckets.map((bucket, index) => (
            <div
              key={bucket.at}
              className={hover === index ? 'hovered' : ''}
              onMouseEnter={() => setHover(index)}
            >
              <span
                className="usage-stack"
                style={
                  totals[index] > 0
                    ? { height: `${(totals[index] / top) * 100}%`, minHeight: 2 }
                    : { height: 0 }
                }
              >
                {series.map((item) =>
                  (item.values[index] ?? 0) > 0 ? (
                    <i
                      key={item.key}
                      style={{ flex: `${item.values[index]} 0 0`, ...dot(item.color) }}
                    />
                  ) : null,
                )}
              </span>
            </div>
          ))}
          {shown && hover !== null && (
            <div
              className="usage-tip"
              role="tooltip"
              style={
                // Beside the column, not over it.
                hover < buckets.length / 2
                  ? { left: `calc(${((hover + 1) / buckets.length) * 100}% + 4px)` }
                  : { right: `calc(${(1 - hover / buckets.length) * 100}% + 4px)` }
              }
            >
              <strong>{label(shown.at)}</strong>
              {parts.map((item) => (
                <span key={item.key}>
                  <i style={dot(item.color)} />
                  {item.name} {format(item.value)}
                </span>
              ))}
              <span>{shown.requests.toLocaleString('zh-CN')} 次请求</span>
              <span>
                {dollars(shown.costUsd)} · {tokens(shown.tokens)} tokens
              </span>
              <span>
                输入 {tokens(shown.inputTokens)} · 输出 {tokens(shown.outputTokens)}
              </span>
              <span>
                缓存读取 {tokens(shown.cacheReadTokens)} · 缓存写入{' '}
                {tokens(shown.cacheCreationTokens)}
              </span>
              <span>缓存命中率 {percent(cacheHitRate(shown))}</span>
            </div>
          )}
        </div>
        <span className="usage-sr" aria-live="polite">
          {shown ? describe(shown) : ''}
        </span>
      </div>
      <div className="usage-axis" aria-hidden="true">
        {buckets.map((bucket, index) => (
          <span key={bucket.at}>
            {ticks.includes(index)
              ? axisLabel(bucket.at, index >= step ? buckets[index - step].at : undefined)
              : ''}
          </span>
        ))}
      </div>
    </>
  );
}

// A row's own small columns of the measure over the range, at most 48 of them: neighbours are summed in pairs.
function Spark({ values, color }: { values: number[]; color: string }) {
  let shown = values;
  while (shown.length > 48)
    shown = shown.flatMap((value, index) => (index % 2 ? [] : [value + (shown[index + 1] ?? 0)]));
  const peak = Math.max(...shown, 0);
  return (
    <span className="usage-spark" aria-hidden="true" style={dot(color)}>
      {shown.map((value, index) => (
        <i
          key={index}
          style={{ height: peak && value ? `max(1px, ${(value / peak) * 100}%)` : 0 }}
        />
      ))}
    </span>
  );
}

// What each model accounts for in the range, under the chart. The share is of the cost, or of the tokens when
// the range cost nothing.
export function ModelBreakdown({
  models,
  totals,
  colors,
  sparks,
  selected,
  tokens,
  dollars,
}: {
  models: Row[];
  totals: Omit<Row, 'model'>;
  colors: Colors;
  // Each model's buckets of the measure, where they were read.
  sparks: Record<string, number[] | undefined>;
  selected: string;
  tokens: (value: number) => string;
  dollars: (value: number) => string;
}) {
  const byCost = models.some((item) => item.costUsd > 0);
  const weight = (item: Omit<Row, 'model'>) => (byCost ? item.costUsd : tokenSum(item));
  const whole = models.reduce((sum, item) => sum + weight(item), 0);
  return (
    <div className="usage-table usage-models">
      <table>
        <thead>
          <tr>
            <th>模型</th>
            <th>分布</th>
            <th>请求数</th>
            <th>Token</th>
            <th>缓存命中率</th>
            <th>等价费用</th>
            <th>{byCost ? '费用占比' : 'Token 占比'}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((item) => {
            const share = whole ? weight(item) / whole : 0;
            const color = colors.of(item.model);
            const spark = sparks[item.model];
            return (
              <tr key={item.model} aria-current={item.model === selected ? 'true' : undefined}>
                <td title={item.model}>
                  <i className="usage-dot" style={dot(color)} />
                  {item.model}
                </td>
                <td>{spark ? <Spark values={spark} color={color} /> : '—'}</td>
                <td>{item.requests.toLocaleString('zh-CN')}</td>
                <td>{tokens(tokenSum(item))}</td>
                <td>{percent(cacheHitRate(item))}</td>
                <td>{dollars(item.costUsd)}</td>
                <td>
                  <span className="usage-share" style={dot(color)}>
                    <i style={{ width: `${share * 100}%` }} />
                  </span>
                  {percent(share)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>合计</td>
            <td />
            <td>{totals.requests.toLocaleString('zh-CN')}</td>
            <td>{tokens(tokenSum(totals))}</td>
            <td>{percent(cacheHitRate(totals))}</td>
            <td>{dollars(totals.costUsd)}</td>
            <td>{whole ? '100%' : '—'}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const dayMs = 86400_000;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
export type Day = { index: number; bucket: Bucket | undefined };

// The days kept, as a calendar of weeks (Monday on top), coloured by how much each day used; beside it, what
// the days add up to. Day indexes count local days since 1970-01-01, a Thursday, as the service buckets them.
export function ActivityCard({
  days,
  firstRecord,
  loading,
  failed,
  tokens,
  dollars,
}: {
  days: Day[];
  // The first local day with any record; earlier days were never recorded, which is not the same as unused.
  firstRecord: number | null;
  loading: boolean;
  failed: boolean;
  tokens: (value: number) => string;
  dollars: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();
  const count = days.length;
  const byCost = days.some((day) => (day.bucket?.costUsd ?? 0) > 0);
  const value = (day: Day) => (byCost ? (day.bucket?.costUsd ?? 0) : (day.bucket?.tokens ?? 0));
  const max = Math.max(...days.map(value), 0);
  const level = (day: Day) =>
    value(day) <= 0 || !max ? 0 : Math.min(4, Math.ceil(4 * Math.sqrt(value(day) / max)));
  const unrecorded = (day: Day) => firstRecord === null || day.index < firstRecord;
  const first = days[0]?.index ?? 0;
  const week = (index: number) => Math.floor((index + 3) / 7) - Math.floor((first + 3) / 7);
  const weeks = count ? week(days[count - 1].index) + 1 : 0;
  const row = (index: number) => (((index + 3) % 7) + 7) % 7;
  const date = (index: number) => new Date(index * dayMs);
  const name = (index: number) => {
    const at = date(index);
    return `${at.getUTCMonth() + 1}月${at.getUTCDate()}日 周${weekdays[row(index)]}`;
  };
  const describe = (day: Day) =>
    loading
      ? `${name(day.index)}：读取中`
      : unrecorded(day) && !day.bucket?.requests
        ? `${name(day.index)}：无记录`
        : !day.bucket?.requests
          ? `${name(day.index)}：没有调用`
          : `${name(day.index)}：${dollars(day.bucket.costUsd)}，${day.bucket.requests.toLocaleString('zh-CN')} 次请求，${tokens(day.bucket.tokens)} tokens`;
  // Month names over the week a month begins in, and over the first week unless a name follows right after.
  const months = new Map<number, string>();
  for (const day of days)
    if (date(day.index).getUTCDate() === 1)
      months.set(week(day.index), `${date(day.index).getUTCMonth() + 1}月`);
  if (count && ![...months.keys()].some((column) => column < 3))
    months.set(0, `${date(first).getUTCMonth() + 1}月`);
  // Streaks: the current one counts back from today, or from yesterday while today has nothing yet.
  const used = days.map((day) => (day.bucket?.requests ?? 0) > 0);
  let longest = 0,
    longestStart = -1,
    run = 0;
  used.forEach((on, index) => {
    run = on ? run + 1 : 0;
    if (run > longest) {
      longest = run;
      longestStart = index - run + 1;
    }
  });
  let end = count - 1;
  if (end >= 0 && !used[end]) end--;
  let current = 0;
  while (end - current >= 0 && used[end - current]) current++;
  const earliest = Math.max(0, firstRecord === null ? 0 : firstRecord - first);
  const atEdge = (start: number, length: number) => length > 0 && start <= earliest;
  const sums = days.reduce(
    (sum, day) => ({
      costUsd: sum.costUsd + (day.bucket?.costUsd ?? 0),
      requests: sum.requests + (day.bucket?.requests ?? 0),
      tokens: sum.tokens + (day.bucket?.tokens ?? 0),
    }),
    { costUsd: 0, requests: 0, tokens: 0 },
  );
  const bound = `只统计保留的 ${count} 天记录`;
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    if (event.key === 'Escape' && active !== null) {
      event.stopPropagation();
      setActive(null);
      return;
    }
    const move = moves[event.key];
    if (move === undefined || !count) return;
    event.preventDefault();
    // The first key shows today; the next ones move from the day shown.
    // A move past the first or the last day stays on the day shown.
    if (active === null) setActive(count - 1);
    else if (active + move >= 0 && active + move < count) setActive(active + move);
  };
  const shown = active !== null ? days[active] : undefined;
  const fact = (label: string, value: string, note?: string, title?: string) => (
    <div title={title}>
      <span>{label}</span>
      <strong>{loading ? <span className="skeleton" style={{ width: 56 }} /> : value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
  return (
    <section className="usage-card usage-activity" aria-label="活动" aria-busy={loading}>
      <header>
        <strong>活动</strong>
        <span>近 {count} 天 · 每天的用量 · 全部模型</span>
      </header>
      {failed ? (
        <p className="muted">活动读取失败，点右上角刷新重试。</p>
      ) : (
        <div className="usage-activity-body">
          <div className="usage-heat-wrap">
            <div
              className="usage-heat"
              tabIndex={0}
              role="group"
              aria-label="每天的用量，方向键逐日查看"
              aria-describedby={shown ? tipId : undefined}
              onKeyDown={key}
              onBlur={() => setActive(null)}
              onMouseLeave={() => setActive(null)}
            >
              {[...months].map(([column, text]) => (
                <span
                  key={`m${column}`}
                  className="usage-heat-month"
                  aria-hidden="true"
                  style={{ gridColumn: column + 2, gridRow: 1 }}
                >
                  {text}
                </span>
              ))}
              {[0, 2, 4].map((line) => (
                <span
                  key={`d${line}`}
                  className="usage-heat-day"
                  aria-hidden="true"
                  style={{ gridColumn: 1, gridRow: line + 2 }}
                >
                  {weekdays[line]}
                </span>
              ))}
              {days.map((day, index) => (
                <i
                  key={day.index}
                  role="img"
                  aria-label={describe(day)}
                  data-level={loading ? 0 : level(day)}
                  className={[
                    !loading && unrecorded(day) && !day.bucket?.requests ? 'none' : '',
                    active === index ? 'active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ gridColumn: week(day.index) + 2, gridRow: row(day.index) + 2 }}
                  onMouseEnter={() => setActive(index)}
                />
              ))}
              {shown && !loading && (
                <div
                  id={tipId}
                  className="usage-tip"
                  role="tooltip"
                  // Under the day's square: the grid's first row (month names) is 16px, every other track 18px, 4px apart.
                  // In the right half it opens leftwards from the day's right edge, staying over the calendar.
                  style={{
                    top: `${20 + (row(shown.index) + 1) * 22 + 2}px`,
                    ...(week(shown.index) * 2 < weeks
                      ? { left: `${22 + week(shown.index) * 22}px` }
                      : { right: `${(weeks - 1 - week(shown.index)) * 22}px` }),
                  }}
                >
                  {describe(shown)}
                </div>
              )}
            </div>
            <span className="usage-sr" aria-live="polite">
              {shown ? describe(shown) : ''}
            </span>
            <div className="usage-heat-legend" aria-hidden="true">
              少
              {[0, 1, 2, 3, 4].map((step) => (
                <i key={step} data-level={step} />
              ))}
              多<small>{byCost ? '按等价费用' : '按 Token'}</small>
            </div>
          </div>
          <div className="usage-facts">
            {fact(`近 ${count} 天等价费用`, dollars(sums.costUsd))}
            {fact('请求数', sums.requests.toLocaleString('zh-CN'))}
            {fact('Token', tokens(sums.tokens))}
            {fact('活跃', `${used.filter(Boolean).length} 天`, `共 ${count} 天`)}
            {fact(
              '连续使用',
              `${atEdge(end - current + 1, current) ? '≥' : ''}${current} 天`,
              `最长 ${atEdge(longestStart, longest) ? '≥' : ''}${longest} 天`,
              atEdge(end - current + 1, current) || atEdge(longestStart, longest)
                ? bound
                : undefined,
            )}
          </div>
        </div>
      )}
    </section>
  );
}
