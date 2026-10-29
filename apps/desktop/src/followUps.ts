import type { ClientState, ProxyClient } from './client.ts';
import type { Scenario } from './Composer.tsx';

export type FollowUp = { id: string; text: string; scenario: Scenario; attempted?: boolean };
type Snapshot = {
  items: Record<string, FollowUp[]>;
  paused: Record<string, string>;
  sending: Record<string, string | undefined>;
};
type Transport = Pick<ProxyClient, 'request' | 'getSnapshot' | 'subscribe'>;
const storageKey = 'cc-follow-ups';

// Unsent messages belong to this window. Restored queues always require confirmation before sending.
export class FollowUps {
  private state: Snapshot = { items: {}, paused: {}, sending: {} };
  private listeners = new Set<() => void>();
  private waiting = new Map<string, string>();
  constructor(privateClient: Transport) {
    this.client = privateClient;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
      for (const [id, value] of Object.entries(saved)) {
        if (!Array.isArray(value)) continue;
        const items = value.filter(
          (item): item is FollowUp =>
            item &&
            typeof item.id === 'string' &&
            typeof item.text === 'string' &&
            ['chat', 'tool', 'question', 'error'].includes(item.scenario),
        );
        if (items.length) {
          this.state.items[id] = items;
          this.state.paused[id] = '待发送，请确认后继续排队';
        }
      }
    } catch {
      /* An unavailable window store does not prevent sending. */
    }
  }
  private client: Transport;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    this.state = { ...this.state };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(this.state.items));
    } catch {
      /* See constructor. */
    }
    for (const listener of this.listeners) listener();
  }
  start = () => this.client.subscribe(() => this.pump());
  enqueue(sessionId: string, text: string, scenario: Scenario) {
    const items = this.state.items[sessionId] ?? [];
    if (items.length >= 32) throw new Error('排队消息已达 32 条，请先处理现有消息。');
    if (!items.length) {
      this.state.paused = { ...this.state.paused, [sessionId]: '' };
      this.waiting.delete(sessionId);
    }
    this.state.items = {
      ...this.state.items,
      [sessionId]: [...items, { id: crypto.randomUUID(), text, scenario }],
    };
    const run = this.client.getSnapshot().sessions.find((s) => s.id === sessionId)?.activeRun;
    if (run) this.waiting.set(sessionId, run.id);
    this.publish();
    this.pump();
  }
  remove(sessionId: string, id: string) {
    if (this.state.sending[sessionId] === id) return;
    this.state.items = {
      ...this.state.items,
      [sessionId]: (this.state.items[sessionId] ?? []).filter((item) => item.id !== id),
    };
    this.publish();
  }
  edit(sessionId: string, id: string, text: string) {
    if (this.state.sending[sessionId] === id) return;
    this.state.items = {
      ...this.state.items,
      [sessionId]: (this.state.items[sessionId] ?? []).map((item) =>
        item.id === id && !item.attempted ? { ...item, text } : item,
      ),
    };
    this.publish();
  }
  pause(sessionId: string, reason = '排队已暂停') {
    if (!this.state.items[sessionId]?.length || this.state.paused[sessionId] === reason) return;
    this.state.paused = { ...this.state.paused, [sessionId]: reason };
    this.publish();
  }
  resume(sessionId: string) {
    this.state.paused = { ...this.state.paused, [sessionId]: '' };
    const run = this.client.getSnapshot().sessions.find((s) => s.id === sessionId)?.activeRun;
    if (run) this.waiting.set(sessionId, run.id);
    else this.waiting.delete(sessionId);
    this.publish();
    this.pump();
  }
  private pump() {
    const current = this.client.getSnapshot();
    for (const [sessionId, items] of Object.entries(this.state.items)) {
      if (!items.length || this.state.sending[sessionId]) continue;
      if (current.status !== 'connected') {
        this.pause(sessionId, '连接中断，确认连接恢复后继续排队');
        continue;
      }
      if (this.state.paused[sessionId]) continue;
      const session = current.sessions.find((s) => s.id === sessionId);
      if (!session || current.history[sessionId]?.loading) continue;
      if (session.activeRun) {
        this.waiting.set(sessionId, session.activeRun.id);
        continue;
      }
      const runId = this.waiting.get(sessionId);
      if (runId) {
        const status = current.events[sessionId]?.findLast(
          (event) => event.runId === runId && event.payload.type === 'run.status',
        )?.payload;
        if (
          status?.type !== 'run.status' ||
          status.status === 'running' ||
          status.status === 'awaiting_approval'
        )
          continue;
        if (status.status !== 'completed') {
          this.pause(sessionId, '本轮已停止或失败，请确认后继续排队');
          continue;
        }
      }
      void this.send(sessionId, items[0]);
    }
  }
  async sendNow(sessionId: string, id: string) {
    const item = this.state.items[sessionId]?.find((item) => item.id === id);
    if (item && !this.state.sending[sessionId]) await this.send(sessionId, item);
  }
  private async send(sessionId: string, item: FollowUp) {
    this.state.sending = { ...this.state.sending, [sessionId]: item.id };
    this.state.items = {
      ...this.state.items,
      [sessionId]: this.state.items[sessionId].map((value) =>
        value.id === item.id ? { ...value, attempted: true } : value,
      ),
    };
    this.publish();
    try {
      // A retry uses the same ID: a lost response can never create a second user message.
      await this.client.request(
        { type: 'message.send', sessionId, text: item.text, scenario: item.scenario },
        item.id,
      );
      const current: ClientState = this.client.getSnapshot();
      const runId =
        current.events[sessionId]?.findLast(
          (event) => event.payload.type === 'message.user' && event.payload.messageId === item.id,
        )?.runId ?? current.sessions.find((s) => s.id === sessionId)?.activeRun?.id;
      if (runId) this.waiting.set(sessionId, runId);
      else this.pause(sessionId, '消息已提交，确认会话状态后继续排队');
      this.state.items = {
        ...this.state.items,
        [sessionId]: (this.state.items[sessionId] ?? []).filter((value) => value.id !== item.id),
      };
    } catch (error) {
      this.pause(
        sessionId,
        error instanceof Error ? error.message : '发送未确认，请查看会话后继续排队',
      );
    } finally {
      this.state.sending = { ...this.state.sending, [sessionId]: undefined };
      this.publish();
      this.pump();
    }
  }
}
