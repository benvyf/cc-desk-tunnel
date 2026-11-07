import { eventSchema, sessionSchema } from '@cc-desk-tunnel/protocol';
import type { HistoryPage, Session, SessionEvent } from '@cc-desk-tunnel/protocol';

export type HistoryScope = { owner: string; server: string; label: string };
export type LocalRecord = {
  key: string;
  head: string;
  owner: string;
  server: string;
  label: string;
  session: Session;
  savedAt: string;
  count: number;
  first: number;
  last: number;
  through: number;
  complete: boolean;
  assetsThrough: number;
};
type StoredEvent = { archive: string; sequence: number; event: SessionEvent };
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法读取本地聊天记录。'));
  });
const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error('本地聊天记录未能保存，可能空间不足。'));
  });
const bounds = (key: string, first = 0, last = Number.MAX_SAFE_INTEGER) =>
  IDBKeyRange.bound([key, first], [key, last]);
export async function historyServer(node: string, url: string, fingerprint: string) {
  const address = new URL(url);
  address.username = '';
  address.password = '';
  address.search = '';
  address.hash = '';
  const bytes = new TextEncoder().encode(
    JSON.stringify([node, address.href, fingerprint.toLowerCase().replace(/[^a-f0-9]/g, '')]),
  );
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Display/backup data only. No credentials, CLI state, outgoing commands or network access.
export class LocalHistory {
  private opening?: Promise<IDBDatabase>;
  private protection?: Promise<boolean>;
  private name: string;
  constructor(name = 'cc-space-chat-history-v1') {
    this.name = name;
  }
  private db() {
    return (this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('heads', { keyPath: 'key' });
        db.createObjectStore('records', { keyPath: 'key' }).createIndex('owner', 'owner');
        db.createObjectStore('events', { keyPath: ['archive', 'sequence'] });
        db.createObjectStore('attachments', { keyPath: ['archive', 'path'] });
      };
      request.onerror = () => {
        this.opening = undefined;
        reject(request.error);
      };
      request.onblocked = () =>
        reject(new Error('本地记录数据库被另一窗口占用，请关闭旧窗口后重试。'));
      request.onsuccess = () => {
        this.protection = navigator.storage?.persist
          ? navigator.storage.persist().catch(() => false)
          : Promise.resolve(false);
        request.result.onversionchange = () => {
          request.result.close();
          this.opening = undefined;
        };
        resolve(request.result);
      };
    }));
  }
  async durable() {
    await this.db();
    return (await this.protection) ?? false;
  }
  async list(owner: string) {
    const db = await this.db();
    return (
      (await result(
        db.transaction('records').objectStore('records').index('owner').getAll(owner),
      )) as LocalRecord[]
    ).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async current(scope: HistoryScope, sessionId: string) {
    const db = await this.db();
    const tx = db.transaction(['heads', 'records']);
    const head = await result(
      tx.objectStore('heads').get(JSON.stringify([scope.owner, scope.server, sessionId])),
    );
    return head
      ? ((await result(tx.objectStore('records').get(head.archive))) as LocalRecord)
      : undefined;
  }
  async page(owner: string, key: string, before = Number.MAX_SAFE_INTEGER, limit = 300) {
    const db = await this.db();
    const tx = db.transaction(['records', 'events']);
    const record = (await result(tx.objectStore('records').get(key))) as LocalRecord | undefined;
    if (!record || record.owner !== owner) throw new Error('当前账号无法读取此本地记录。');
    const events: SessionEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore('events').openCursor(bounds(key, 0, before - 1), 'prev');
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item || events.length >= limit) {
          resolve();
          return;
        }
        events.push(eventSchema.parse((item.value as StoredEvent).event));
        item.continue();
      };
    });
    events.reverse();
    return { record, events, hasEarlier: !!events.length && events[0].sequence > record.first };
  }
  async save(scope: HistoryScope, page: HistoryPage, expectedKey?: string, forceNew = false) {
    const session = { ...sessionSchema.parse(page.session), activeRun: null };
    const incoming = page.events.map((e) => eventSchema.parse(e));
    if (incoming.some((e) => e.sessionId !== session.id))
      throw new Error('聊天记录会话标识不一致。');
    const db = await this.db();
    const tx = db.transaction(['heads', 'records', 'events'], 'readwrite');
    const done = finished(tx);
    void done.catch(() => {});
    try {
      const headKey = JSON.stringify([scope.owner, scope.server, session.id]);
      const head = await result(tx.objectStore('heads').get(headKey));
      if (expectedKey && head?.archive !== expectedKey)
        throw new Error('归档版本已变化，请重新同步。');
      let record = head
        ? ((await result(tx.objectStore('records').get(head.archive))) as LocalRecord)
        : undefined;
      const first = incoming.reduce((n, e) => Math.min(n, e.sequence), Number.MAX_SAFE_INTEGER);
      const last = incoming.reduce((n, e) => Math.max(n, e.sequence), 0);
      const old =
        record && incoming.length
          ? ((await result(
              tx.objectStore('events').getAll(bounds(record.key, first, last)),
            )) as StoredEvent[])
          : [];
      const existing = new Map(old.map((e) => [e.sequence, e.event]));
      const diverged =
        record &&
        (record.session.createdAt !== session.createdAt ||
          (page.mode === 'replace' && page.lastSequence < record.through) ||
          incoming.some(
            (e) =>
              existing.has(e.sequence) &&
              JSON.stringify(existing.get(e.sequence)) !== JSON.stringify(e),
          ));
      if (!record || diverged || forceNew) {
        record = {
          ...scope,
          key: crypto.randomUUID(),
          head: headKey,
          session,
          savedAt: '',
          count: 0,
          first: 0,
          last: 0,
          through: 0,
          complete: false,
          assetsThrough: 0,
        };
        tx.objectStore('heads').put({ key: headKey, archive: record.key });
        existing.clear();
      }
      for (const event of incoming) {
        if (!existing.has(event.sequence)) record.count++;
        tx.objectStore('events').put({ archive: record.key, sequence: event.sequence, event });
        record.first = record.first ? Math.min(record.first, event.sequence) : event.sequence;
        record.last = Math.max(record.last, event.sequence);
      }
      record.session = session;
      record.savedAt = new Date().toISOString();
      tx.objectStore('records').put(record);
      await done;
      return record;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      throw error;
    }
  }
  async complete(owner: string, key: string, through: number) {
    const db = await this.db();
    const tx = db.transaction('records', 'readwrite');
    const done = finished(tx);
    void done.catch(() => {});
    const record = (await result(tx.objectStore('records').get(key))) as LocalRecord;
    if (!record || record.owner !== owner) {
      tx.abort();
      throw new Error('本地记录不属于当前账号。');
    }
    tx.objectStore('records').put({
      ...record,
      complete: true,
      through,
      savedAt: new Date().toISOString(),
    });
    await done;
  }
  async checkedAttachments(owner: string, key: string, through: number) {
    const db = await this.db();
    const tx = db.transaction('records', 'readwrite');
    const done = finished(tx);
    void done.catch(() => {});
    const record = (await result(tx.objectStore('records').get(key))) as LocalRecord;
    if (!record || record.owner !== owner) {
      tx.abort();
      throw new Error('本地记录不属于当前账号。');
    }
    tx.objectStore('records').put({ ...record, assetsThrough: through });
    await done;
  }
  async attachment(owner: string, key: string, path: string, data?: string) {
    const db = await this.db();
    const tx = db.transaction(
      ['records', 'attachments'],
      data === undefined ? 'readonly' : 'readwrite',
    );
    const done = finished(tx);
    void done.catch(() => {});
    const record = (await result(tx.objectStore('records').get(key))) as LocalRecord;
    if (!record || record.owner !== owner) {
      tx.abort();
      throw new Error('本地记录不属于当前账号。');
    }
    const store = tx.objectStore('attachments');
    if (data !== undefined) store.put({ archive: key, path, data });
    const found = data === undefined ? await result(store.get([key, path])) : null;
    await done;
    return found?.data as string | undefined;
  }
  async remove(owner: string, key: string) {
    const db = await this.db();
    const tx = db.transaction(['heads', 'records', 'events', 'attachments'], 'readwrite');
    const done = finished(tx);
    void done.catch(() => {});
    const record = (await result(tx.objectStore('records').get(key))) as LocalRecord;
    if (!record || record.owner !== owner) {
      tx.abort();
      throw new Error('本地记录不属于当前账号。');
    }
    const head = await result(tx.objectStore('heads').get(record.head));
    if (head?.archive === key) tx.objectStore('heads').delete(record.head);
    tx.objectStore('records').delete(key);
    tx.objectStore('events').delete(bounds(key));
    tx.objectStore('attachments').delete(IDBKeyRange.bound([key, ''], [key, '\uffff']));
    await done;
  }
  async attachments(owner: string, key: string) {
    const db = await this.db();
    const tx = db.transaction(['records', 'attachments']);
    const record = (await result(tx.objectStore('records').get(key))) as LocalRecord;
    if (!record || record.owner !== owner) throw new Error('本地记录不属于当前账号。');
    return (await result(
      tx.objectStore('attachments').getAll(IDBKeyRange.bound([key, ''], [key, '\uffff'])),
    )) as { path: string; data: string }[];
  }
  async export(owner: string, key: string) {
    let page = await this.page(owner, key);
    const record = page.record;
    let count = 0;
    const chunks: string[] = [];
    for (;;) {
      count += page.events.length;
      chunks.unshift(
        page.events.map((event) => JSON.stringify({ type: 'event', event }) + '\n').join(''),
      );
      if (!page.hasEarlier) break;
      page = await this.page(owner, key, page.events[0].sequence);
    }
    const attachments = await this.attachments(owner, key);
    return new Blob(
      [
        JSON.stringify({ type: 'header', format: 'cc-space-chat-history', version: 1, record }) +
          '\n',
        ...chunks,
        ...attachments.map(
          ({ path, data }) => JSON.stringify({ type: 'attachment', path, data }) + '\n',
        ),
        JSON.stringify({ type: 'end', count, attachments: attachments.length, last: record.last }) +
          '\n',
      ],
      { type: 'application/x-ndjson' },
    );
  }
  async import(owner: string, file: Blob) {
    const scope: HistoryScope = {
      owner,
      server: 'import-' + crypto.randomUUID(),
      label: '导入记录',
    };
    let record: LocalRecord | undefined;
    let header: LocalRecord | undefined;
    let count = 0,
      attachments = 0,
      last = 0,
      ended = false;
    let buffer: SessionEvent[] = [];
    const flush = async () => {
      if (!header) throw new Error('归档缺少文件头。');
      record = await this.save(
        scope,
        {
          session: header.session,
          requestId: crypto.randomUUID(),
          events: buffer,
          mode: 'append',
          firstSequence: buffer[0]?.sequence ?? 0,
          lastSequence: last,
          hasEarlier: false,
        },
        record?.key,
      );
      buffer = [];
    };
    const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    try {
      const line = async (raw: string) => {
        if (raw.length > 64 * 1024 * 1024) throw new Error('归档单条记录过大。');
        if (!raw.trim()) return;
        if (ended) throw new Error('归档结束标记后仍有数据。');
        const value = JSON.parse(raw);
        if (!header) {
          if (
            value.type !== 'header' ||
            value.format !== 'cc-space-chat-history' ||
            value.version !== 1
          )
            throw new Error('不支持的聊天归档格式。');
          header = {
            ...value.record,
            session: { ...sessionSchema.parse(value.record?.session), activeRun: null },
          };
          scope.label = `导入 · ${typeof value.record?.label === 'string' ? value.record.label.slice(0, 160) : '聊天记录'}`;
        } else if (value.type === 'event') {
          const event = eventSchema.parse(value.event);
          if (event.sessionId !== header.session.id || event.sequence <= last)
            throw new Error('归档事件顺序或会话不一致。');
          last = event.sequence;
          buffer.push(event);
          count++;
          if (buffer.length >= 100) await flush();
        } else if (value.type === 'attachment') {
          if (buffer.length || !record) await flush();
          if (
            typeof value.path !== 'string' ||
            value.path.length > 4096 ||
            typeof value.data !== 'string' ||
            !/^(?:missing:[\s\S]{0,4096}|data:(?:image\/(?:png|jpeg|gif|webp)|application\/octet-stream);base64,[A-Za-z0-9+/]*={0,2})$/.test(
              value.data,
            )
          )
            throw new Error('归档附件格式无效。');
          await this.attachment(owner, record!.key, value.path, value.data);
          attachments++;
        } else if (value.type === 'end') {
          if (
            value.count !== count ||
            header.count !== count ||
            value.attachments !== attachments ||
            value.last !== last ||
            header.last !== last
          )
            throw new Error('归档条数不匹配或文件不完整。');
          if (buffer.length || !record) await flush();
          if (header.complete && header.through === last)
            await this.complete(owner, record!.key, last);
          if (header.assetsThrough >= last) await this.checkedAttachments(owner, record!.key, last);
          ended = true;
        } else throw new Error('归档包含未知内容。');
      };
      for (;;) {
        const next = await reader.read();
        text += next.value ?? '';
        let end: number;
        while ((end = text.indexOf('\n')) >= 0) {
          await line(text.slice(0, end));
          text = text.slice(end + 1);
        }
        if (text.length > 64 * 1024 * 1024) throw new Error('归档单条记录过大。');
        if (next.done) break;
      }
      if (text.trim()) await line(text);
      if (!ended || !record) throw new Error('归档缺少结束标记，文件不完整。');
      return record;
    } catch (error) {
      if (record) await this.remove(owner, record.key).catch(() => {});
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
export const localHistory = new LocalHistory();
