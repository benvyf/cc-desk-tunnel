// Dependency-free wire contract shared with the VPS runtime. No login credentials or content.
export type MonitorReport = {
  schema: 1;
  nodeId: string;
  observedAt: string;
  account: { id: string; subscriptionType: string | null } | null;
  rateLimits: {
    available: boolean;
    measuredAt: string;
    windows: { name: string; utilization: number | null; resetsAt: string | null }[];
  } | null;
  usage: {
    sessionId: string;
    measuredAt: string;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
};
export type MonitorSnapshot = MonitorReport & { receivedAt: string };
export const monitorNodePattern = /^[A-Za-z0-9_-]{1,64}$/;

export function validateMonitorReport(input: unknown, now = Date.now()): MonitorReport {
  function require(value: unknown): asserts value {
    if (!value) throw new Error('Invalid account monitor report.');
  }
  function object(value: unknown, keys: string[]): Record<string, unknown> {
    require(value && typeof value === 'object' && !Array.isArray(value));
    const row = value as Record<string, unknown>;
    require(Object.keys(row).length === keys.length && keys.every((k) => Object.hasOwn(row, k)));
    return row;
  }
  function timestamp(value: unknown): number {
    require(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
    const n = Date.parse(value);
    require(Number.isFinite(n) && n >= 0 && new Date(n).toISOString() === value);
    return n;
  }
  const r = object(input, ['schema', 'nodeId', 'observedAt', 'account', 'rateLimits', 'usage']);
  require(r.schema === 1 && typeof r.nodeId === 'string' && monitorNodePattern.test(r.nodeId));
  const at = timestamp(r.observedAt);
  require(at <= now + 120000);
  if (r.account !== null) {
    const a = object(r.account, ['id', 'subscriptionType']);
    require(typeof a.id === 'string' && /^[a-f0-9]{64}$/.test(a.id));
    require(
      a.subscriptionType === null ||
        (typeof a.subscriptionType === 'string' &&
          /^[A-Za-z0-9_. -]{1,64}$/.test(a.subscriptionType)),
    );
  } else require(r.rateLimits === null && r.usage === null);
  if (r.rateLimits !== null) {
    const q = object(r.rateLimits, ['available', 'measuredAt', 'windows']);
    require(typeof q.available === 'boolean' && timestamp(q.measuredAt) <= at);
    require(Array.isArray(q.windows) && q.windows.length <= 32);
    require(q.available || q.windows.length === 0);
    const names = new Set();
    for (const value of q.windows) {
      const w = object(value, ['name', 'utilization', 'resetsAt']);
      require(
        typeof w.name === 'string' &&
          w.name.length <= 96 &&
          /^[A-Za-z0-9_: .-]+$/.test(w.name) &&
          !names.has(w.name),
      );
      names.add(w.name);
      require(
        w.utilization === null ||
          (typeof w.utilization === 'number' &&
            Number.isFinite(w.utilization) &&
            w.utilization >= 0 &&
            w.utilization <= 100),
      );
      if (w.resetsAt !== null) timestamp(w.resetsAt);
    }
  }
  if (r.usage !== null) {
    const u = object(r.usage, [
      'sessionId',
      'measuredAt',
      'costUsd',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ]);
    require(typeof u.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u.sessionId));
    require(timestamp(u.measuredAt) <= at);
    require(
      u.costUsd === null ||
        (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0),
    );
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
      require(Number.isSafeInteger(u[key]) && Number(u[key]) >= 0);
  }
  return structuredClone(input) as MonitorReport;
}
