import type { HistoryPage, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { eventSchema } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestFailedError } from './client.ts';
import type { HistorySink } from './client.ts';
import { localHistory } from './local-history.ts';
import type { HistoryScope, LocalRecord } from './local-history.ts';
import { splitAttachmentMessage } from './attachments.ts';

type Status = HistoryScope & { syncing: boolean; error: string; supported: boolean };
const statuses = new Map<string, Status>();
const listeners = new Set<(owner: string) => void>();
export const historyStatuses = (owner: string) =>
  [...statuses.values()].filter((s) => s.owner === owner);
export function onHistoryChange(listener: (owner: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const notify = (owner: string) => {
  for (const listener of listeners) listener(owner);
};

export class LocalHistorySync implements HistorySink {
  private queue = new Map<string, Session>();
  private paused = true;
  private closed = false;
  private running = false;
  private epoch = 0;
  private supported = false;
  private writes = Promise.resolve();
  private pending = new Map<string, { session: Session; events: SessionEvent[] }>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastStatus?: Status;
  private verified = new Set<string>();
  private waiting = new Map<string, (() => Promise<unknown>)[]>();
  private client: ProxyClient;
  readonly scope: HistoryScope;
  constructor(client: ProxyClient, scope: HistoryScope) {
    this.client = client;
    this.scope = scope;
  }
  private status(error = '', syncing = this.running) {
    const key = JSON.stringify([this.scope.owner, this.scope.server]);
    if (this.closed && statuses.get(key) !== this.lastStatus) return;
    this.lastStatus = { ...this.scope, error, syncing, supported: this.supported };
    statuses.set(JSON.stringify([this.scope.owner, this.scope.server]), this.lastStatus);
    notify(this.scope.owner);
  }
  private write(action: () => Promise<unknown>) {
    this.writes = this.writes.then(action).then(
      () => {
        notify(this.scope.owner);
      },
      (error) => {
        void window.desktop?.localHistory
          ?.report?.({
            operation: 'write',
            server: this.scope.server,
            error: error instanceof Error ? error.name : 'Error',
          })
          .catch(() => {});
        this.status(`本地保存未完成：${error instanceof Error ? error.message : '存储失败'}`);
      },
    );
  }
  ready(sessions: Session[], completeSync: boolean) {
    this.paused = false;
    this.supported = completeSync;
    this.queue.clear();
    for (const session of [...sessions].sort(
      (a, b) =>
        Number(b.id === this.client.state.selectedId) -
        Number(a.id === this.client.state.selectedId),
    ))
      this.queue.set(session.id, session);
    this.status();
    void this.pump();
  }
  changed(session: Session) {
    this.queue.set(session.id, session);
    void this.pump();
  }
  deleted(id: string) {
    this.flush();
    this.queue.delete(id);
    this.waiting.delete(id);
    this.verified.delete(id);
  }
  page(page: HistoryPage) {
    const fresh = !this.supported && !this.verified.has(page.session.id);
    if (!this.supported) this.verified.add(page.session.id);
    const action = async () => {
      // Old services cannot prove cursor continuity; keep a separate partial generation per connection.
      return localHistory.save(this.scope, page, undefined, fresh);
    };
    if (this.supported && !this.verified.has(page.session.id)) {
      const waiting = this.waiting.get(page.session.id) ?? [];
      waiting.push(action);
      this.waiting.set(page.session.id, waiting);
    } else this.write(action);
  }
  event(session: Session, event: SessionEvent) {
    const pending = this.pending.get(session.id) ?? { session, events: [] };
    pending.session = session;
    pending.events.push(event);
    this.pending.set(session.id, pending);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 250);
  }
  private flush() {
    for (const { session, events } of this.pending.values()) {
      this.page({
        session,
        events,
        requestId: crypto.randomUUID(),
        mode: 'append',
        firstSequence: events[0]?.sequence ?? 0,
        lastSequence: events.at(-1)?.sequence ?? 0,
        hasEarlier: false,
      });
    }
    this.pending.clear();
  }
  async cached(id: string) {
    const record = await localHistory.current(this.scope, id);
    const session = this.client.state.sessions.find((s) => s.id === id);
    if (!record || record.session.createdAt !== session?.createdAt) return undefined;
    const page = await localHistory.page(this.scope.owner, record.key);
    return { events: page.events, first: page.events[0]?.sequence ?? 0 };
  }
  suspend() {
    this.paused = true;
    this.epoch++;
    this.flush();
    this.verified.clear();
    this.waiting.clear();
    if (
      this.lastStatus &&
      statuses.get(JSON.stringify([this.scope.owner, this.scope.server])) === this.lastStatus
    )
      this.status('连接已中断，已保存记录保留，恢复连接后继续同步。', false);
  }
  close() {
    this.closed = true;
    this.suspend();
    clearTimeout(this.timer);
    if (
      this.lastStatus &&
      statuses.get(JSON.stringify([this.scope.owner, this.scope.server])) === this.lastStatus
    )
      this.status('', false);
  }
  private async pump() {
    if (this.running || this.paused || this.closed || !this.supported) return;
    this.running = true;
    const epoch = this.epoch;
    this.status();
    let failed = false;
    let vanished = false;
    let currentId = '';
    const active = () =>
      !this.closed &&
      !this.paused &&
      epoch === this.epoch &&
      this.client.state.status === 'connected';
    try {
      while (active() && this.queue.size) {
        const [id] = this.queue.keys();
        currentId = id;
        this.queue.delete(id);
        this.flush();
        await this.writes;
        if (!active()) break;
        let previous = await localHistory.current(this.scope, id);
        if (!active()) break;
        if (!this.verified.has(id)) {
          let matches = false;
          if (previous?.complete && previous.through) {
            try {
              const anchor = await this.client.fetch({
                type: 'session.archive',
                sessionId: id,
                afterSequence: 0,
                beforeSequence: previous.through + 1,
              });
              const saved = await localHistory.page(
                this.scope.owner,
                previous.key,
                previous.through + 1,
                1,
              );
              const observed = anchor.events.find((e) => e.sequence === previous!.through);
              matches =
                !!observed &&
                JSON.stringify(eventSchema.parse(observed)) === JSON.stringify(saved.events[0]);
            } catch (error) {
              if (!(error instanceof RequestFailedError) || error.code !== 'invalid_cursor')
                throw error;
            }
          }
          if (!active()) break;
          // Do not append unverified new tails to an older complete backup.
          if (previous && !matches) {
            const session = this.client.state.sessions.find((s) => s.id === id);
            if (!session) continue;
            previous = await localHistory.save(
              this.scope,
              {
                session,
                events: [],
                requestId: crypto.randomUUID(),
                mode: 'replace',
                firstSequence: 0,
                lastSequence: 0,
                hasEarlier: true,
              },
              undefined,
              true,
            );
          }
          this.verified.add(id);
          for (const action of this.waiting.get(id) ?? []) this.write(action);
          this.waiting.delete(id);
          await this.writes;
          previous = await localHistory.current(this.scope, id);
        }
        let page: HistoryPage;
        try {
          page = await this.client.fetch({
            type: 'session.archive',
            sessionId: id,
            afterSequence: previous?.complete ? previous.through : 0,
          });
        } catch (error) {
          if (!(error instanceof RequestFailedError) || error.code !== 'invalid_cursor')
            throw error;
          page = await this.client.fetch({
            type: 'session.archive',
            sessionId: id,
            afterSequence: 0,
          });
        }
        if (!active()) break;
        let record = await localHistory.save(this.scope, page);
        const through = page.lastSequence;
        while (active() && page.mode !== 'append' && page.hasEarlier) {
          const before = page.firstSequence;
          if (!before) throw new Error('服务端历史游标未前进。');
          page = await this.client.fetch({
            type: 'session.archive',
            sessionId: id,
            afterSequence: 0,
            beforeSequence: before,
          });
          if (!active()) break;
          if (page.hasEarlier && (!page.firstSequence || page.firstSequence >= before))
            throw new Error('服务端历史分页未前进。');
          record = await localHistory.save(this.scope, page, record.key);
        }
        if (!active()) break;
        await localHistory.complete(this.scope.owner, record.key, through);
        await this.attachments(record);
        this.status();
      }
    } catch (error) {
      vanished = error instanceof RequestFailedError && error.code === 'not_found';
      if (vanished) this.deleted(currentId);
      failed = !vanished;
      if (active() && !vanished)
        void window.desktop?.localHistory
          ?.report?.({
            operation: 'sync',
            server: this.scope.server,
            error: error instanceof Error ? error.name : 'Error',
          })
          .catch(() => {});
      if (active() && !vanished)
        this.status(
          `同步未完成，可在本地记录中重试：${error instanceof Error ? error.message : '读取失败'}`,
          false,
        );
    } finally {
      this.running = false;
    }
    if (active() && !failed) this.status('', false);
    // A reconnect may have queued a new generation while an old request was finishing.
    if (!this.closed && !this.paused && (epoch !== this.epoch || (vanished && this.queue.size)))
      void this.pump();
  }
  private async attachments(record: LocalRecord) {
    let before = Number.MAX_SAFE_INTEGER;
    while (!this.closed && !this.paused) {
      const page = await localHistory.page(this.scope.owner, record.key, before);
      for (const event of page.events) {
        if (event.payload.type !== 'message.user') continue;
        for (const item of splitAttachmentMessage(event.payload.text).files) {
          if (this.closed || this.paused) return;
          const path = item.path!;
          const saved = await localHistory.attachment(this.scope.owner, record.key, path);
          if (saved && !saved.startsWith('missing:')) continue;
          let value: string;
          if (
            record.session.device?.id !== this.client.state.device?.id ||
            record.session.device?.viaSsh
          ) {
            value = 'missing:附件来自其他执行设备，未自动复制。';
          } else {
            try {
              value = await window.desktop!.localHistory!.attachment(this.scope.owner, path);
            } catch (error) {
              value = 'missing:' + (error instanceof Error ? error.message : '附件无法读取');
            }
          }
          await localHistory.attachment(this.scope.owner, record.key, path, value);
        }
      }
      if (!page.hasEarlier) break;
      before = page.events[0].sequence;
    }
    if (!this.closed && !this.paused)
      await localHistory.checkedAttachments(this.scope.owner, record.key, record.last);
    notify(this.scope.owner);
  }
}
