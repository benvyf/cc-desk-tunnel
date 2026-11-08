// Dependency-free wire contract shared with the VPS runtime. No login credentials or content.
export type MonitorAccount = {
  id: string;
  subscriptionType: string | null;
  // Present on schema 2 only. Legacy schema 1 reports remain readable.
  email?: string;
  organization?: string | null;
  authMethod?: string | null;
  apiProvider?: string | null;
};
export type MonitorReport = {
  schema: 1 | 2;
  nodeId: string;
  observedAt: string;
  account: MonitorAccount | null;
  identity?: { state: 'identified' | 'signed_out' | 'unknown'; measuredAt: string };
  quotaStatus?: { state: 'ok' | 'unavailable' | 'error' | 'unknown'; measuredAt: string | null };
  rateLimits: {
    available: boolean;
    measuredAt: string;
    windows: { name: string; utilization: number | null; resetsAt: string | null }[];
  } | null;
  usage: {
    sessionId: string;
    runId?: string;
    measuredAt: string;
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  } | null;
};
export type MonitorSnapshot = MonitorReport & { receivedAt: string };
export type MonitorAccountRecord = {
  id: string;
  accountNumber: string;
  note: string;
  firstSeenAt: string;
  lastSeenAt: string;
  snapshots: MonitorSnapshot[];
};
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
  const version =
    input && typeof input === 'object' ? (input as Record<string, unknown>).schema : null;
  require(version === 1 || version === 2);
  const r = object(input, [
    'schema',
    'nodeId',
    'observedAt',
    'account',
    'rateLimits',
    'usage',
    ...(version === 2 ? ['identity', 'quotaStatus'] : []),
  ]);
  require(typeof r.nodeId === 'string' && monitorNodePattern.test(r.nodeId));
  const at = timestamp(r.observedAt);
  require(at <= now + 120000);
  function text(value: unknown, max: number): void {
    require(
      typeof value === 'string' &&
        value.length > 0 &&
        value.length <= max &&
        !/[\u0000-\u001f\u007f]/.test(value),
    );
  }
  if (version === 2) {
    const identity = object(r.identity, ['state', 'measuredAt']);
    require(
      ['identified', 'signed_out', 'unknown'].includes(String(identity.state)) &&
        timestamp(identity.measuredAt) <= at,
    );
    require((identity.state === 'identified') === (r.account !== null));
    const status = object(r.quotaStatus, ['state', 'measuredAt']);
    require(['ok', 'unavailable', 'error', 'unknown'].includes(String(status.state)));
    require(
      status.state === 'unknown' ? status.measuredAt === null : timestamp(status.measuredAt) <= at,
    );
    if (r.account === null) require(status.state === 'unknown');
  }
  if (r.account !== null) {
    const a = object(r.account, [
      'id',
      'subscriptionType',
      ...(version === 2 ? ['email', 'organization', 'authMethod', 'apiProvider'] : []),
    ]);
    require(typeof a.id === 'string' && /^[a-f0-9]{64}$/.test(a.id));
    require(
      a.subscriptionType === null ||
        (typeof a.subscriptionType === 'string' &&
          /^[A-Za-z0-9_. -]{1,64}$/.test(a.subscriptionType)),
    );
    if (version === 2) {
      text(a.email, 254);
      require(
        typeof a.email === 'string' &&
          /^[^\s@]+@[^\s@]+$/.test(a.email) &&
          a.email.trim() === a.email,
      );
      for (const key of ['organization', 'authMethod', 'apiProvider'])
        if (a[key] !== null) text(a[key], 256);
    }
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
      ...(version === 2 ? ['runId'] : []),
    ]);
    require(typeof u.sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u.sessionId));
    if (version === 2)
      require(typeof u.runId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u.runId));
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
