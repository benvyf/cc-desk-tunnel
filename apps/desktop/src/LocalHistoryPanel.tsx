import { useEffect, useRef, useState } from 'react';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { localHistory } from './local-history.ts';
import type { LocalRecord } from './local-history.ts';
import { historyStatuses, onHistoryChange } from './local-history-sync.ts';
import { ArchivedAttachments } from './AttachmentTiles.tsx';
import Conversation from './Conversation.tsx';
import { Button, Modal } from './ui.tsx';

const clock = { now: () => Date.now(), activityAt: () => 0 };
export default function LocalHistoryPanel({
  client,
  close,
}: {
  client: ProxyClient;
  close: () => void;
}) {
  const [identity, setIdentity] = useState<{ owner: string; email: string } | null>(null);
  const [records, setRecords] = useState<LocalRecord[]>([]);
  const [selected, setSelected] = useState<LocalRecord | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [hasEarlier, setHasEarlier] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [durable, setDurable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [, repaint] = useState(0);
  const turn = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (owner: string) => {
      void localHistory
        .durable()
        .then((value) => {
          if (alive) setDurable(value);
        })
        .catch(() => {});
      void localHistory.list(owner).then(
        (value) => {
          if (alive) {
            setRecords(value);
            repaint((n) => n + 1);
          }
        },
        (reason) => {
          if (alive) setError(String(reason));
        },
      );
    };
    let currentOwner = '';
    void window
      .desktop!.localHistory!.identity()
      .then((value) => {
        if (!alive) return;
        setIdentity(value);
        currentOwner = value?.owner ?? '';
        if (value) refresh(value.owner);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    const off = onHistoryChange((owner) => {
      if (owner !== currentOwner) return;
      clearTimeout(timer);
      timer = setTimeout(() => refresh(owner), 250);
    });
    aliveRef.current = true;
    return () => {
      alive = false;
      aliveRef.current = false;
      turn.current++;
      clearTimeout(timer);
      off();
    };
  }, []);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      if (aliveRef.current)
        setError(reason instanceof Error ? reason.message : '本地记录操作失败。');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };
  async function select(record: LocalRecord) {
    if (!identity) return;
    const at = ++turn.current;
    const page = await localHistory.page(identity.owner, record.key);
    const attachments = await localHistory.attachments(identity.owner, record.key);
    if (at !== turn.current) return;
    setSelected(page.record);
    setEvents(page.events);
    setHasEarlier(page.hasEarlier);
    setAssets(Object.fromEntries(attachments.map((item) => [item.path, item.data])));
  }
  async function earlier() {
    if (!identity || !selected || !events.length) return;
    const at = turn.current;
    const page = await localHistory.page(identity.owner, selected.key, events[0].sequence);
    if (at !== turn.current) return;
    setEvents((current) => [...page.events, ...current]);
    setHasEarlier(page.hasEarlier);
  }
  async function exportFile() {
    if (!identity || !selected) return;
    const blob = await localHistory.export(identity.owner, selected.key);
    if ((await window.desktop!.localHistory!.identity())?.owner !== identity.owner)
      throw new Error('账号已变化，导出已取消。');
    const name =
      (selected.session.title.replace(/[\\/:*?"<>|\r\n]/g, ' ').trim() || '会话') +
      '.cc-history.jsonl';
    if (typeof window.desktop?.saveFile === 'function' && blob.size <= 32 * 1024 * 1024) {
      const text = await blob.text();
      if ((await window.desktop.localHistory!.identity())?.owner !== identity.owner)
        throw new Error('账号已变化，导出已取消。');
      const saved = await window.desktop.saveFile(name, text);
      if (aliveRef.current)
        setNotice(saved ? '归档已保存，请妥善保管；缺失附件仍会在文件中标明。' : '已取消导出。');
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    if (aliveRef.current) setNotice('已发起归档下载，请在默认下载目录核对文件保存结果。');
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  }
  const statuses = identity ? historyStatuses(identity.owner) : [];
  const missing = Object.values(assets).filter((data) => data.startsWith('missing:')).length;
  return (
    <Modal title="本地聊天记录" onClose={close}>
      <div className="local-history-panel">
        <p className="muted">
          {selected
            ? '只读本地副本，不会发送消息或恢复工具执行。'
            : '本机副本可离线查看、导出和导入；只用于阅读，不会发送消息或恢复工具执行。Claude 原生续聊仍由 Ubuntu 处理。记录可能包含代码和敏感聊天内容，请妥善保管导出文件。'}
        </p>
        {!identity ? (
          <p role="status">请先登录一次并记住登录。离线时可查看这台电脑已记住账号的归档。</p>
        ) : (
          <>
            <p>当前本机账号：{identity.email}</p>
            {durable === false && (
              <p className="muted">系统尚未授予本地记录的自动回收保护，请及时导出重要归档。</p>
            )}
            {!selected && (
              <>
                <div className="local-history-actions">
                  <Button
                    disabled={busy || client.state.status !== 'connected'}
                    onClick={() => client.retryHistoryArchive()}
                  >
                    同步完整历史
                  </Button>
                  <label className="button">
                    导入归档
                    <input
                      aria-label="导入聊天归档"
                      type="file"
                      accept=".jsonl"
                      disabled={busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file)
                          void act(async () => {
                            const imported = await localHistory.import(identity.owner, file);
                            setRecords(await localHistory.list(identity.owner));
                            await select(imported);
                          });
                      }}
                    />
                  </label>
                </div>
                {statuses.map((status) => (
                  <p role="status" key={status.server}>
                    {status.label}：
                    {status.error ||
                      (status.syncing
                        ? '正在同步…'
                        : status.supported
                          ? '后台同步已空闲'
                          : '服务端尚未支持完整归档同步；本机暂仅保存已读取的历史页。')}
                  </p>
                ))}
                <label>
                  查找本地会话
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="会话名称或工作空间"
                  />
                </label>
                <div className="local-history-list">
                  {records
                    .filter((record) =>
                      (record.session.title + record.label)
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((record) => (
                      <button
                        className="local-history-item"
                        key={record.key}
                        disabled={busy}
                        onClick={() => void act(() => select(record))}
                      >
                        <strong>{record.session.title}</strong>
                        <span>
                          {record.label} · {record.count} 条 ·{' '}
                          {record.complete && record.through >= record.last
                            ? '完整快照'
                            : '部分记录'}
                        </span>
                        <small>{new Date(record.savedAt).toLocaleString()}</small>
                      </button>
                    ))}
                  {!records.length && (
                    <p className="muted">
                      尚无本地记录。连接工作空间后会自动同步；服务端缺少会话时不会自动删除这里的归档。
                    </p>
                  )}
                </div>
              </>
            )}
            {selected && (
              <>
                <Button
                  onClick={() => {
                    turn.current++;
                    setSelected(null);
                    setEvents([]);
                    setAssets({});
                  }}
                >
                  返回本地会话列表
                </Button>
                <div className="local-history-actions">
                  <h3>{selected.session.title}</h3>
                  <Button disabled={busy} onClick={() => void act(exportFile)}>
                    导出归档
                  </Button>
                  <Button disabled={busy} onClick={() => void act(() => select(selected))}>
                    刷新本地视图
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          '只删除这份本地归档及其附件？服务端会话不受影响；之后在线同步可能重新保存。',
                        )
                      )
                        void act(async () => {
                          await localHistory.remove(identity.owner, selected.key);
                          setSelected(null);
                          setEvents([]);
                          setAssets({});
                          setRecords(await localHistory.list(identity.owner));
                        });
                    }}
                  >
                    删除本地副本
                  </Button>
                </div>
                <p className="muted">
                  只读归档 · 已保存 {selected.count} 条；最近保存{' '}
                  {new Date(selected.savedAt).toLocaleString()}。
                  {selected.complete && selected.through >= selected.last
                    ? '聊天历史已完整同步到最近确认游标。'
                    : '尚非完整备份。'}
                  附件需单独核对，流式输出在服务端正式记录后保存。
                </p>
                <details>
                  <summary>
                    附件副本：{Object.keys(assets).length - missing} 个已保存，{missing} 个未保存
                    {(selected.assetsThrough ?? 0) < selected.last ? ' · 检查尚未完成' : ''}
                  </summary>
                  {Object.entries(assets).map(([path, data]) => (
                    <p key={path}>
                      {data.startsWith('missing:') ? (
                        `${path}：${data.slice(8)}`
                      ) : (
                        <a href={data} download={path.split(/[/\\]/).pop()}>
                          {path.split(/[/\\]/).pop()} · 保存附件
                        </a>
                      )}
                    </p>
                  ))}
                </details>
                <div className="local-history-conversation">
                  <ArchivedAttachments.Provider value={assets}>
                    <Conversation
                      session={{ ...selected.session, activeRun: null }}
                      events={events}
                      history={{
                        loaded: true,
                        firstSequence: events[0]?.sequence ?? 0,
                        lastSequence: events.at(-1)?.sequence ?? 0,
                        hasEarlier,
                        loading: false,
                        loadingEarlier: busy,
                      }}
                      connected={false}
                      native={false}
                      ownsRun={false}
                      busy={busy}
                      fresh={false}
                      here={false}
                      findRequest={0}
                      clock={clock}
                      progress={undefined}
                      loadEarlier={earlier}
                      replyApproval={async () => false}
                      stopTask={() => {}}
                      backgroundTask={() => {}}
                      stop={() => {}}
                    />
                  </ArchivedAttachments.Provider>
                </div>
              </>
            )}
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Modal>
  );
}
