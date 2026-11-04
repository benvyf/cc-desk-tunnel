import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SshDirectoryList, SshTarget, SshTargetInput } from './desktop.d.ts';
import type { ProxyClient } from './client.ts';
import { ArrowUp, Ellipsis, Folder, FolderOpen, Laptop, Plus, Server } from './icons.tsx';
import { Button, IconButton, Menu, Modal, Switch } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';

const statusText = {
  disconnected: '已断开',
  connecting: '连接中…',
  'ssh-connected': 'SSH 已连接 · 开发通道未就绪',
  connected: '已连接',
  failed: '连接失败',
};
const initial: SshTargetInput = {
  name: '',
  host: '',
  username: '',
  port: 22,
  auth: 'key',
  identityFile: '',
};
const stageText = {
  ssh: '正在验证 SSH 身份…',
  capabilities: '正在检查 Linux 与 Bash…',
  sftp: '正在检查 SFTP…',
  authorization: '正在验证 Ubuntu 工作空间…',
  tunnel: '正在建立 Ubuntu 开发通道…',
  ready: '已连接',
};
const on = (entry: SshTarget) =>
  ['connecting', 'ssh-connected', 'connected'].includes(entry.status);
// The colour of a row's dot: ready, on its way (breathing), failed, or idle.
function tone(entry: SshTarget) {
  if (entry.status === 'connected') return 'ok';
  if (entry.status === 'failed') return 'error';
  if (entry.status === 'connecting' || entry.status === 'ssh-connected') return 'busy';
  return 'off';
}
function status(entry: SshTarget) {
  if (!entry.available && entry.status === 'disconnected') return '不在当前 Ubuntu 工作空间';
  return entry.status !== 'failed' && entry.status !== 'disconnected' && entry.stage
    ? stageText[entry.stage]
    : statusText[entry.status];
}
// user@host, with the port only when it is not SSH's own.
const address = (entry: Pick<SshTarget, 'username' | 'host' | 'port'>) =>
  `${entry.username}@${entry.host}${Number(entry.port) === 22 ? '' : `:${entry.port}`}`;
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

// The device a dialog acts on: its name, address and how it signs in.
function TargetSummary({ entry }: { entry: SshTarget }) {
  return (
    <div className="ssh-target">
      <Server />
      <span>
        <strong>{entry.name}</strong>
        <small>
          {address(entry)} ·{' '}
          {entry.auth === 'key'
            ? `身份文件 ${entry.identityFile ? fileName(entry.identityFile) : ''}`.trim()
            : '密码登录'}
        </small>
      </span>
    </div>
  );
}

export default function SshConnectionsSettings({
  client,
  openSession,
}: {
  client: ProxyClient;
  openSession?: (id: string, created: boolean) => Promise<void>;
}) {
  const api = window.desktop?.ssh;
  const [entries, setEntries] = useState<SshTarget[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(initial);
  const [secret, setSecret] = useState('');
  const [login, setLogin] = useState<SshTarget | null>(null);
  const [project, setProject] = useState<SshTarget | null>(null);
  const [directory, setDirectory] = useState('');
  const [listing, setListing] = useState<SshDirectoryList | null>(null);
  const [listingBusy, setListingBusy] = useState(false);
  const browseTurn = useRef(0);
  const [rename, setRename] = useState<SshTarget | null>(null);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState<(MenuPosition & { entry: SshTarget }) | null>(null);
  useEffect(() => {
    if (!api) return;
    const off = api.onChanged(setEntries);
    let current = true;
    void api.list().then(
      (value) => current && setEntries(value),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
      browseTurn.current++;
      off();
    };
  }, [api]);
  async function act(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (busy) {
      if (login) void api?.disconnect(login.id);
      else return;
    }
    setAdding(false);
    setLogin(null);
    setProject(null);
    browseTurn.current++;
    setListing(null);
    setListingBusy(false);
    setRename(null);
    setSecret('');
    setError('');
  }
  function credentials(entry: SshTarget) {
    setSecret('');
    setError('');
    setLogin(entry);
  }
  function startAdding() {
    setForm({ ...initial });
    setSecret('');
    setError('');
    setAdding(true);
  }
  async function disconnect(entry: SshTarget, remove = false) {
    const running = client.state.sessions.some((s) => s.device?.id === entry.id && s.activeRun);
    if (
      (running || remove) &&
      !window.confirm(
        remove
          ? `删除连接“${entry.name}”？将断开其执行通道；远程文件和已有会话会保留。`
          : `断开“${entry.name}”会中断当前开发，在途命令可能继续执行。是否断开？`,
      )
    )
      return;
    await act(() => (remove ? api!.remove(entry.id) : api!.disconnect(entry.id)));
  }
  const dialog = adding || login || project || rename;
  async function openProject(entry: SshTarget, path: string, forceNew = false) {
    await act(async () => {
      const result = await api!.openProject(entry.id, path, forceNew);
      setProject(null);
      browseTurn.current++;
      setListing(null);
      await openSession?.(result.sessionId, result.created);
    });
  }
  // Lists a folder on the target. Opening the dialog lists its first folder quietly: if that fails, the
  // field stays as it was and 浏览 still says why.
  async function browse(entry: SshTarget, path?: string, quiet = false) {
    if (!api) return;
    const turn = ++browseTurn.current;
    setListingBusy(true);
    setError('');
    try {
      const result = await api.directories(entry.id, path);
      if (turn !== browseTurn.current) return;
      setListing(result);
      setDirectory(result.path);
    } catch {
      if (turn === browseTurn.current && !quiet)
        setError('无法浏览目录，请检查 SSH 连接、目录路径及访问权限。');
    } finally {
      if (turn === browseTurn.current) setListingBusy(false);
    }
  }
  function chooseProject(entry: SshTarget) {
    const recent = entry.projects[0] ?? '';
    setDirectory(recent);
    setListing(null);
    setProject(entry);
    setError('');
    void browse(entry, recent || undefined, true);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !api) return;
    if (project) {
      if (!listingBusy) void openProject(project, directory);
      return;
    }
    void act(async () => {
      if (adding) {
        const id = await api.save(form);
        setAdding(false);
        const saved = (await api.list()).find((entry) => entry.id === id)!;
        setLogin(saved);
        await api.connect(id, secret);
        setLogin(null);
        setSecret('');
      } else if (login) {
        await api.connect(login.id, secret);
        setLogin(null);
        setSecret('');
      } else if (rename) {
        await api.save({ ...rename, identityFile: rename.identityFile ?? '', name });
        setRename(null);
      }
    });
  }
  // A pasted “user@host” fills both fields: the host field itself only takes a name or an address.
  function changeHost(value: string) {
    const split = /^([^@\s]+)@([^@\s]+)$/.exec(value.trim());
    if (split && !form.username.trim()) setForm({ ...form, username: split[1], host: split[2] });
    else setForm({ ...form, host: value });
  }
  return (
    <section className="page ssh-settings" aria-label="SSH 连接设置">
      <div className="page-body">
        <h1 className="page-title">连接</h1>
        <p className="muted">通过 SSH 连接其他设备，在远程项目中开发。</p>
        <div className="ssh-heading">
          <h2 className="page-heading">来自此电脑的 SSH 连接</h2>
          {entries.length > 0 && (
            <Button size="sm" disabled={!api || busy} onClick={startAdding}>
              <Plus />
              添加
            </Button>
          )}
        </div>
        {!entries.length ? (
          <div className="ssh-empty">
            <span className="ssh-empty-art" aria-hidden="true">
              <Laptop />
              <i />
              <Server />
            </span>
            <strong>尚未添加 SSH 连接</strong>
            <p className="muted">
              添加一台 Linux 设备，即可在它的项目里开发；Claude 仍运行在 Ubuntu 工作空间。
            </p>
            <Button size="sm" disabled={!api || busy} onClick={startAdding}>
              <Plus />
              添加连接
            </Button>
          </div>
        ) : (
          <div className="card ssh-list">
            {entries.map((entry) => (
              <div className="setting-row ssh-row" key={entry.id} data-tone={tone(entry)}>
                <Switch
                  small
                  label={`连接 ${entry.name}`}
                  checked={on(entry)}
                  disabled={busy || !api || (!entry.available && entry.status === 'disconnected')}
                  onChange={(value) => (value ? credentials(entry) : void disconnect(entry))}
                />
                <span className="ssh-detail">
                  <strong title={entry.name}>{entry.name}</strong>
                  <small className="ssh-status">
                    <i className="ssh-dot" aria-hidden="true" />
                    <span>{status(entry)}</span>
                    <span className="ssh-address">{address(entry)}</span>
                  </small>
                  {!entry.available && (
                    <small className="ssh-note">请连接此配置所属的 Ubuntu 工作空间</small>
                  )}
                  {entry.projects[0] && (
                    <small className="ssh-recent" title={entry.projects[0]}>
                      最近项目：<code>{entry.projects[0]}</code>
                    </small>
                  )}
                  {entry.error && <small className="error-text">{entry.error}</small>}
                </span>
                <div className="setting-actions">
                  {entry.status === 'connected' && openSession && (
                    <>
                      {entry.projects.length > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void openProject(entry, entry.projects[0])}
                        >
                          继续上次
                        </Button>
                      )}
                      <Button size="sm" disabled={busy} onClick={() => chooseProject(entry)}>
                        <FolderOpen />
                        打开项目
                      </Button>
                    </>
                  )}
                  <IconButton
                    title={`${entry.name} 的更多操作`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ entry, x: rect.right - 160, y: rect.bottom + 4 });
                    }}
                  >
                    <Ellipsis />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
        {!dialog && error && (
          <p className="error-text ssh-page-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {menu && (
        <Menu
          {...menu}
          label="SSH 连接操作"
          onClose={() => setMenu(null)}
          items={[
            {
              label: '重命名',
              run: () => {
                setName(menu.entry.name);
                setRename(menu.entry);
                setError('');
              },
            },
            {
              label: '重新连接',
              disabled: busy || !menu.entry.available,
              run: () => credentials(menu.entry),
            },
            { label: '删除连接', danger: true, run: () => void disconnect(menu.entry, true) },
          ]}
        />
      )}
      {dialog && (
        <Modal
          title={
            adding
              ? '添加 SSH 连接'
              : project
                ? '打开远程项目'
                : rename
                  ? '重命名连接'
                  : `连接 ${login!.name}`
          }
          onClose={close}
        >
          <form className="dialog-form ssh-form" onSubmit={submit}>
            <fieldset disabled={busy}>
              {adding && (
                <>
                  <label>
                    <span>
                      显示名称<span className="ssh-optional">（可选）</span>
                    </span>
                    <input
                      aria-label="显示名称"
                      value={form.name}
                      maxLength={120}
                      placeholder={
                        form.username && form.host
                          ? address({ ...form, port: 22 })
                          : '例如：实验室 Ubuntu'
                      }
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <label>
                    主机名
                    <input
                      required
                      value={form.host}
                      placeholder="host.com 或 10.0.0.20"
                      spellCheck={false}
                      onChange={(e) => changeHost(e.target.value)}
                    />
                  </label>
                  <div className="ssh-login-fields">
                    <label>
                      用户名
                      <input
                        required
                        value={form.username}
                        autoComplete="username"
                        spellCheck={false}
                        onChange={(e) => setForm({ ...form, username: e.target.value })}
                      />
                    </label>
                    <label>
                      SSH 端口
                      <input
                        type="number"
                        required
                        min={1}
                        max={65535}
                        value={form.port}
                        onChange={(e) => setForm({ ...form, port: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="ssh-auth">
                    <span className="ssh-field-label">身份验证</span>
                    <SegmentedControl
                      label="身份验证"
                      value={form.auth}
                      options={[
                        { value: 'key', label: '身份文件' },
                        { value: 'password', label: '密码' },
                      ]}
                      onChange={(auth) => {
                        setForm({ ...form, auth });
                        setSecret('');
                      }}
                    />
                  </div>
                  {form.auth === 'key' && (
                    <label>
                      身份文件路径
                      <div className="ssh-field-row">
                        <input
                          aria-label="身份文件路径"
                          required
                          value={form.identityFile}
                          placeholder="C:\Users\me\.ssh\id_ed25519"
                          spellCheck={false}
                          onChange={(e) => setForm({ ...form, identityFile: e.target.value })}
                        />
                        <Button
                          onClick={() =>
                            void api!
                              .chooseIdentity()
                              .then((value) => value && setForm({ ...form, identityFile: value }))
                          }
                        >
                          选择文件
                        </Button>
                      </div>
                    </label>
                  )}
                </>
              )}
              {login && !adding && <TargetSummary entry={login} />}
              {(adding || login) && (
                <label>
                  {(adding ? form.auth : login!.auth) === 'key' ? '私钥口令（如有）' : 'SSH 密码'}
                  <input
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                  <small className="ssh-hint">仅用于本次连接，不保存密码或口令。</small>
                </label>
              )}
              {project && (
                <div className="ssh-project-choice">
                  <TargetSummary entry={project} />
                  <label>
                    项目绝对路径
                    <div className="ssh-field-row">
                      <input
                        aria-label="项目绝对路径"
                        required
                        value={directory}
                        placeholder="/home/dev/project"
                        spellCheck={false}
                        onChange={(e) => {
                          setDirectory(e.target.value);
                          browseTurn.current++;
                          setListing(null);
                          setListingBusy(false);
                        }}
                      />
                      <Button
                        disabled={listingBusy}
                        onClick={() => void browse(project, directory.trim() || undefined)}
                      >
                        浏览
                      </Button>
                    </div>
                  </label>
                  {project.projects.length > 0 && (
                    <div className="ssh-recent-list" role="group" aria-label="最近项目">
                      <span className="ssh-field-label">最近项目</span>
                      {project.projects.slice(0, 5).map((path) => (
                        <button
                          type="button"
                          key={path}
                          className="ssh-folder"
                          aria-pressed={directory === path}
                          title={path}
                          onClick={() => {
                            setDirectory(path);
                            void browse(project, path, true);
                          }}
                        >
                          <FolderOpen />
                          <span>{path}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="ssh-directory-browser" aria-label="远程目录选择">
                    <div className="ssh-directory-heading">
                      <IconButton
                        title="上一级目录"
                        size="sm"
                        disabled={listingBusy || !listing || listing.parent === listing.path}
                        onClick={() => listing && void browse(project, listing.parent)}
                      >
                        <ArrowUp />
                      </IconButton>
                      <code title={listing?.path ?? directory}>
                        <bdi>{listing?.path ?? (directory || '~')}</bdi>
                      </code>
                    </div>
                    <div className="ssh-directories" role="group" aria-label="远程文件夹">
                      {listingBusy && (
                        <p className="ssh-directories-note" role="status">
                          正在读取目标设备的目录…
                        </p>
                      )}
                      {!listingBusy &&
                        listing?.directories.map((folder) => (
                          <button
                            type="button"
                            key={folder.path}
                            className="ssh-folder"
                            title={folder.path}
                            onClick={() => void browse(project, folder.path)}
                          >
                            <Folder />
                            <span>{folder.name}</span>
                          </button>
                        ))}
                      {!listingBusy && listing && !listing.directories.length && (
                        <p className="ssh-directories-note">
                          此目录下没有可浏览的文件夹，可直接打开当前目录。
                        </p>
                      )}
                      {!listingBusy && !listing && (
                        <p className="ssh-directories-note">
                          填写路径后选择“浏览”，查看目标设备上的文件夹。
                        </p>
                      )}
                    </div>
                  </div>
                  <small className="ssh-hint">
                    “打开项目”优先继续该目录最近的会话；需要独立对话时选择“新建会话”。
                  </small>
                </div>
              )}
              {rename && (
                <label>
                  显示名称
                  <input
                    required
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}
            </fieldset>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              {project && (
                <Button
                  variant="ghost"
                  className="ssh-new-session"
                  disabled={busy || listingBusy || !directory.trim()}
                  onClick={() => void openProject(project, directory, true)}
                >
                  新建会话
                </Button>
              )}
              <Button disabled={busy && !login} onClick={close}>
                取消
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={busy || (project !== null && listingBusy)}
              >
                {busy
                  ? '请稍候…'
                  : adding
                    ? '保存并连接'
                    : project
                      ? '打开项目'
                      : rename
                        ? '保存'
                        : '连接'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
