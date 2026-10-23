import { createHash } from 'node:crypto';
import type { AccountState, EventPayload } from '@cc-desk-tunnel/protocol';
import {
  validateMonitorReport,
  type MonitorReport,
} from '../../../packages/protocol/src/account-monitor.ts';

export type AccountMonitorOptions = { url: string; nodeId: string; token: string };
type Event = EventPayload | ({ type: 'account.state' } & AccountState);
type Source = { id: string | null; generation: number; errorAt?: string };

// Observes existing readings only. It has no CLI/SDK dependency and never refreshes Claude.
export class AccountMonitor {
  private options: AccountMonitorOptions;
  private timing: { intervalMs: number; retryMs: number; timeoutMs: number };
  private account: MonitorReport['account'] = null;
  private rateLimits: MonitorReport['rateLimits'] = null;
  private usage: MonitorReport['usage'] = null;
  private identity: NonNullable<MonitorReport['identity']> = {
    state: 'unknown',
    measuredAt: new Date().toISOString(),
  };
  private quotaStatus: NonNullable<MonitorReport['quotaStatus']> = {
    state: 'unknown',
    measuredAt: null,
  };
  private pending = new Map<string, MonitorReport>();
  private signature = '';
  private timer?: NodeJS.Timeout;
  private request?: AbortController;
  private closed = false;
  private nextAt = 0;
  private failures = 0;
  private observedAt = 0;
  private generation = 0;
  private sources = new Map<string, Source>();

  constructor(
    options: AccountMonitorOptions,
    timing = { intervalMs: 30000, retryMs: 30000, timeoutMs: 5000 },
  ) {
    this.options = options;
    this.timing = timing;
  }

  observe(event: Event, sessionId?: string, sourceId = sessionId): void {
    if (this.closed) return;
    const previous = {
      account: this.account,
      rateLimits: this.rateLimits,
      usage: this.usage,
      generation: this.generation,
      identity: this.identity,
      quotaStatus: this.quotaStatus,
    };
    let binding: Source | undefined;
    try {
      if (event.type === 'account.state' || event.type === 'native.capabilities') {
        const identity =
          event.type === 'account.state' ? (event.loggedIn ? event : null) : event.account;
        const email = identity?.email?.trim();
        const id = email ? createHash('sha256').update(email.toLowerCase()).digest('hex') : null;
        const before = id === this.account?.id ? this.account : null;
        const account = email
          ? {
              id: id!,
              email,
              subscriptionType: identity?.subscriptionType ?? before?.subscriptionType ?? null,
              organization: identity?.organization ?? before?.organization ?? null,
              authMethod:
                event.type === 'account.state'
                  ? (event.authMethod ?? before?.authMethod ?? null)
                  : (before?.authMethod ?? null),
              apiProvider:
                event.type === 'native.capabilities'
                  ? (event.account.apiProvider ?? before?.apiProvider ?? null)
                  : (before?.apiProvider ?? null),
            }
          : null;
        if (event.type === 'native.capabilities') {
          // Capability identity belongs to this CLI process, not merely its reusable session.
          if (!sourceId) return;
          const known = this.sources.get(sourceId);
          if (known && known.generation !== this.generation) {
            // Concurrent initial runs may learn the same account after another run identifies it.
            // An old bound process, different account, or missing/conflicting known context cannot rebind.
            const matches =
              account?.id === this.account?.id &&
              ['organization', 'apiProvider'].every((key) => {
                const current = this.account?.[key as 'organization' | 'apiProvider'];
                return !current || event.account[key as 'organization' | 'apiProvider'] === current;
              });
            if (known.id !== null || !account || !matches) return;
          }
        }
        if (
          account?.id !== this.account?.id ||
          (account?.organization &&
            this.account?.organization &&
            account.organization !== this.account.organization) ||
          (account?.apiProvider &&
            this.account?.apiProvider &&
            account.apiProvider !== this.account.apiProvider)
        ) {
          this.generation++;
          this.rateLimits = null;
          this.usage = null;
          this.quotaStatus = { state: 'unknown', measuredAt: null };
        }
        this.account = account;
        const state = account
          ? 'identified'
          : event.type === 'account.state' && !event.loggedIn
            ? 'signed_out'
            : 'unknown';
        if (
          state !== this.identity.state ||
          account?.id !== previous.account?.id ||
          JSON.stringify(account) !== JSON.stringify(previous.account)
        )
          this.identity = { state, measuredAt: new Date().toISOString() };
        if (event.type === 'native.capabilities' && account)
          binding = { id: account.id, generation: this.generation };
      } else if (event.type === 'native.metrics') {
        if (!this.account) return;
        const source = sourceId ? this.sources.get(sourceId) : undefined;
        if (!source || source.id !== this.account.id || source.generation !== this.generation)
          return;
        const limits = event.rateLimits;
        if (
          limits?.measuredAt &&
          (!this.quotaStatus.measuredAt || limits.measuredAt > this.quotaStatus.measuredAt)
        ) {
          binding = { ...source, errorAt: undefined };
          this.quotaStatus = {
            state: limits.available ? 'ok' : 'unavailable',
            measuredAt: limits.measuredAt,
          };
          if (limits.available || !this.rateLimits?.available)
            this.rateLimits = {
              available: limits.available,
              measuredAt: limits.measuredAt,
              windows: limits.available
                ? limits.windows.map((w) => ({
                    name: w.name,
                    utilization: w.utilization,
                    resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString(),
                  }))
                : [],
            };
        }
        if (!limits && event.errors?.usage) {
          const errorAt = event.quotaAttemptAt ?? source.errorAt ?? new Date().toISOString();
          binding = { ...source, errorAt };
          if (!this.quotaStatus.measuredAt || errorAt > this.quotaStatus.measuredAt)
            this.quotaStatus = { state: 'error', measuredAt: errorAt };
        }
        if (
          event.usage &&
          sessionId &&
          (!this.usage || event.usage.measuredAt > this.usage.measuredAt)
        ) {
          const u = event.usage;
          this.usage = {
            sessionId,
            runId: sourceId!,
            measuredAt: u.measuredAt,
            costUsd: u.costUsd,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
          };
        }
      } else return;
      const signature = JSON.stringify([
        this.account,
        this.identity,
        this.rateLimits,
        this.quotaStatus,
        this.usage,
      ]);
      if (signature === this.signature) {
        if (binding && sourceId) this.sources.set(sourceId, binding);
        return;
      }
      const at = Math.max(Date.now(), this.observedAt + 1);
      const report = validateMonitorReport({
        schema: 2,
        nodeId: this.options.nodeId,
        observedAt: new Date(at).toISOString(),
        account: this.account,
        rateLimits: this.rateLimits,
        usage: this.usage,
        identity: this.identity,
        quotaStatus: this.quotaStatus,
      });
      this.observedAt = at;
      if (binding && sourceId) this.sources.set(sourceId, binding);
      this.signature = signature;
      this.pending.set(report.account?.id ?? `@${report.identity!.state}`, report);
      if (this.pending.size > 64) {
        const oldest = [...this.pending.entries()].sort((a, b) =>
          a[1].observedAt.localeCompare(b[1].observedAt),
        )[0]!;
        this.pending.delete(oldest[0]);
      }
      this.schedule();
    } catch {
      this.account = previous.account;
      this.rateLimits = previous.rateLimits;
      this.usage = previous.usage;
      this.generation = previous.generation;
      this.identity = previous.identity;
      this.quotaStatus = previous.quotaStatus;
      // Malformed/incompatible native data must never break a run or expose raw data in logs.
    }
  }

  forgetSource(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  beginSource(sourceId: string): void {
    this.sources.set(sourceId, { id: null, generation: this.generation });
  }

  private schedule(): void {
    if (this.closed || this.timer || this.request || !this.pending.size) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.send();
      },
      Math.max(0, this.nextAt - Date.now()),
    );
    this.timer.unref();
  }

  private async send(): Promise<void> {
    if (this.closed || !this.pending.size) return;
    const [key, report] = [...this.pending.entries()].sort((a, b) =>
      a[1].observedAt.localeCompare(b[1].observedAt),
    )[0]!;
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), this.timing.timeoutMs);
    timeout.unref();
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(report),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Report rejected');
      if (this.pending.get(key) === report) this.pending.delete(key);
      this.failures = 0;
      this.nextAt = Date.now() + this.timing.intervalMs;
    } catch {
      this.failures++;
      this.nextAt =
        Date.now() + Math.min(300000, this.timing.retryMs * 2 ** Math.min(this.failures - 1, 4));
    } finally {
      clearTimeout(timeout);
      this.request = undefined;
      this.schedule();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.request?.abort();
    this.pending.clear();
    this.sources.clear();
  }
}
