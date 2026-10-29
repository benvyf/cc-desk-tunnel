import { useEffect, useState } from 'react';
import type { ServerMessage, Session } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Button, Modal } from './ui.tsx';

export default function TerminalHistory({
  client,
  source,
  onClose,
  onContinue,
}: {
  client: ProxyClient;
  source: Session;
  onClose: () => void;
  onContinue: (sessionId: string) => void;
}) {
  const [items, setItems] = useState<
    Extract<ServerMessage, { type: 'terminal.histories' }>['items']
  >([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    const generation = client.state.connectionId;
    setLoading(true);
    setError('');
    void Promise.resolve().then(async () => {
      if (disposed) return;
      try {
        const result = await client.fetch({ type: 'terminal.history.list', sessionId: source.id });
        if (!disposed && client.state.connectionId === generation) setItems(result.items);
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : '历史读取失败。');
      } finally {
        if (!disposed) setLoading(false);
      }
    });
    return () => {
      disposed = true;
    };
  }, [client, source.id, refresh]);
  return (
    <Modal title="继续官方历史会话" onClose={onClose}>
      <p className="terminal-file-path">
        {source.device?.name} · {source.projectPath}
      </p>
      <p>只列出 CC 启动时建立准确关联的历史。旧终端请使用官方 CLI 的历史选择器。</p>
      <p>会新开终端继续，不恢复原进程、不重放输入。外部 CLI 占用以官方提示为准，不会强制接管。</p>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        我已确认当前 CLI 环境和账号适合继续此历史
      </label>
      {loading && <p role="status">正在读取历史元数据…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !items.length && <p>暂无关联的官方历史。</p>}
      <div className="terminal-history-list">
        {items.map((item) => (
          <div key={item.nativeId}>
            <span title={item.nativeId}>{item.title}</span>
            <small>{item.updatedAt}</small>
            {item.reason && <small>{item.reason}</small>}
            <Button
              size="sm"
              disabled={
                loading || !confirmed || !item.available || client.state.status !== 'connected'
              }
              onClick={() => onContinue(item.sessionId)}
            >
              新开终端继续
            </Button>
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        <Button disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          刷新列表
        </Button>
      </div>
    </Modal>
  );
}
