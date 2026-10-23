import { createHash } from 'node:crypto';
import type { AccountState, EventPayload } from '@cc-desk-tunnel/protocol';
import {
  validateMonitorReport,
  type MonitorReport,
} from '../../../packages/protocol/src/account-monitor.ts';

export type AccountMonitorOptions = { url: string; nodeId: string; token: string };
type Event = EventPayload | ({ type: 'account.state' } & AccountState);

// Observes existing readings only. It has no CLI/SDK dependency and never refreshes Claude.
export class AccountMonitor {
  private options: AccountMonitorOptions;
  private timing: { intervalMs: number; retryMs: number; timeoutMs: number };
  private account: MonitorReport['account'] = null;
  private rateLimits: MonitorReport['rateLimits'] = null;
  private usage: MonitorReport['usage'] = null;
  private latest?: MonitorReport;
  private signature = '';
  private sentSignature = '';
  private timer?: NodeJS.Timeout;
  private request?: AbortController;
  private closed = false;
  private nextAt = 0;
  private failures = 0;
  private observedAt = 0;
  private generation = 0;
  private sources = new Map<string, { id: string | null; generation: number }>();

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
    };
    let binding: { id: string; generation: number } | undefined;
    try {
      if (event.type === 'account.state' || event.type === 'native.capabilities') {
        const identity =
          event.type === 'account.state' ? (event.loggedIn ? event : null) : event.account;
        const account = identity?.email
          ? {
              id: createHash('sha256').update(identity.email.trim().toLowerCase()).digest('hex'),
              subscriptionType: identity.subscriptionType ?? null,
            }
          : null;
        if (event.type === 'native.capabilities') {
          // Capability identity belongs to this CLI process, not merely its reusable session.
          if (!sourceId) return;
          const known = this.sources.get(sourceId);
          if (
            known &&
            known.generation !== this.generation &&
            (!account || known.id !== null || account.id !== this.account?.id)
          )
            return;
        }
        if (account?.id !== this.account?.id) {
          this.generation++;
          this.rateLimits = null;
          this.usage = null;
        }
        this.account = account;
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
          (!this.rateLimits || limits.measuredAt > this.rateLimits.measuredAt)
        )
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
        if (
          event.usage &&
          sessionId &&
          (!this.usage || event.usage.measuredAt > this.usage.measuredAt)
        ) {
          const u = event.usage;
          this.usage = {
            sessionId,
            measuredAt: u.measuredAt,
            costUsd: u.costUsd,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
          };
        }
      } else return;
      const signature = JSON.stringify([this.account, this.rateLimits, this.usage]);
      if (signature === this.signature) {
        if (binding && sourceId) this.sources.set(sourceId, binding);
        return;
      }
      const at = Math.max(Date.now(), this.observedAt + 1);
      const report = validateMonitorReport({
        schema: 1,
        nodeId: this.options.nodeId,
        observedAt: new Date(at).toISOString(),
        account: this.account,
        rateLimits: this.rateLimits,
        usage: this.usage,
      });
      this.observedAt = at;
      if (binding && sourceId) this.sources.set(sourceId, binding);
      this.signature = signature;
      this.latest = report;
      this.schedule();
    } catch {
      this.account = previous.account;
      this.rateLimits = previous.rateLimits;
      this.usage = previous.usage;
      this.generation = previous.generation;
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
    if (
      this.closed ||
      this.timer ||
      this.request ||
      !this.latest ||
      this.signature === this.sentSignature
    )
      return;
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
    if (this.closed || !this.latest) return;
    const signature = this.signature;
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
        body: JSON.stringify(this.latest),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Report rejected');
      this.sentSignature = signature;
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
    this.latest = undefined;
    this.sources.clear();
  }
}
