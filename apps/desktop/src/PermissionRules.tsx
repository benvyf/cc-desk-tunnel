import { useEffect, useState } from 'react';
import type { PermissionSource } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Button } from './ui.tsx';

const scopes: Record<PermissionSource['scope'], { name: string; note: string }> = {
  user: { name: '用户级', note: '云端 Claude Code 的用户设置' },
  project: {
    name: '项目级',
    note: '云端服务器上本会话的工作目录，不是 Windows 上的项目文件夹',
  },
  local: { name: '本地', note: '云端服务器上本会话工作目录里的本地设置' },
  flag: { name: '服务设置', note: '服务启动 Claude Code 时用 --settings 指定的文件' },
  managed: {
    name: '托管策略',
    note: '服务器管理员设置的托管策略（只读主文件，不含 managed-settings.d 与远程下发的策略）',
  },
};
const statuses: Record<Exclude<PermissionSource['status'], 'ok'>, string> = {
  missing: '文件不存在',
  invalid_json: '文件不是有效的 JSON，Claude Code 会忽略它',
  too_large: '文件过大，未读取',
  unreadable: '文件无法读取',
  not_file: '不是普通文件，未读取',
};
const lists = [
  ['allow', '允许'],
  ['ask', '询问'],
  ['deny', '拒绝'],
] as const;

// The permission rules of the Claude Code settings files on the server, by where they come from. Read only: what
// the files say, not what is in force, and nothing else of them (the service sends only these fields).
export default function PermissionRules({ client }: { client: ProxyClient }) {
  const available = !!client.state.permissionRules;
  const sessions = client.state.sessions;
  const [sessionId, setSessionId] = useState<string>(client.state.selectedId ?? '');
  const [sources, setSources] = useState<PermissionSource[] | null>(null);
  const [failure, setFailure] = useState('');
  const [turn, setTurn] = useState(0);
  const [loading, setLoading] = useState(false);
  // A session chosen and since deleted is chosen no more.
  const chosen = sessions.some((session) => session.id === sessionId) ? sessionId : '';
  useEffect(() => {
    if (!available) return;
    let current = true;
    setFailure('');
    setLoading(true);
    client
      .fetch({ type: 'permissions.get', ...(chosen ? { sessionId: chosen } : {}) })
      .then(
        (reply) => current && setSources(reply.sources),
        (error: Error) => {
          if (!current) return;
          setSources(null);
          setFailure(error.message);
        },
      )
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [client, available, chosen, turn]);
  if (!available) return null;
  return (
    <div className="permission-rules" aria-busy={loading}>
      <h2 className="page-heading">权限规则</h2>
      <p className="muted">
        只读。这里列出云端 Claude Code
        各配置文件里写的规则，不是最终生效结果：拒绝优先于询问和允许；
        会话的审批模式以会话里选的为准，这里的默认模式仅供参考。
      </p>
      <div className="permission-rules-bar">
        <label>
          <span>会话</span>
          <select
            aria-label="查看哪个会话的项目级规则"
            value={chosen}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">不选会话（只看用户级与服务级）</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => setTurn((value) => value + 1)}>刷新</Button>
      </div>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {!chosen && <p className="muted">选择会话后可以看到它的项目级与本地规则。</p>}
      {sources?.map((source) => (
        <section
          key={`${source.scope}:${source.path}`}
          className="permission-source card"
          aria-label={scopes[source.scope].name}
        >
          <header>
            <strong>{scopes[source.scope].name}</strong>
            <small>{scopes[source.scope].note}</small>
            <code title={source.path}>{source.path}</code>
            {source.symlink && <small>（符号链接）</small>}
          </header>
          {source.status !== 'ok' ? (
            <p className="muted">{statuses[source.status]}</p>
          ) : (
            <>
              {source.defaultMode && (
                <p>
                  默认模式 <code>{source.defaultMode}</code>
                </p>
              )}
              {lists.map(([key, name]) => (
                <div key={key} className={`permission-list ${key}`}>
                  <span>
                    {name}（{source[key].length}）
                  </span>
                  {source[key].length ? (
                    <ul>
                      {source[key].map((rule, index) => (
                        <li key={index}>
                          <code>{rule}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <small>无</small>
                  )}
                </div>
              ))}
              {source.additionalDirectories && (
                <div className="permission-list directories">
                  <span>额外目录（{source.additionalDirectories.length}）</span>
                  <ul>
                    {source.additionalDirectories.map((directory, index) => (
                      <li key={index}>
                        <code>{directory}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {source.truncated && <p className="muted">规则过多或过长，只显示了一部分。</p>}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
