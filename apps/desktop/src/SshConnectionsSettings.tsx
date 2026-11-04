import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SshDirectoryList, SshTarget, SshTargetInput } from './desktop.d.ts';
import type { ProxyClient } from './client.ts';
import { FolderOpen, ArrowUp, Ellipsis, Plus, Laptop } from './icons.tsx';
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
  async function browse(path?: string) {
    if (!api || !project) return;
    const turn = ++browseTurn.current;
    setListingBusy(true);
    setError('');
    try {
      const result = await api.directories(project.id, path);
      if (turn !== browseTurn.current) return;
      setListing(result);
      setDirectory(result.path);
    } catch {
      if (turn === browseTurn.current)
        setError('无法浏览目录，请检查 SSH 连接、目录路径及访问权限。');
    } finally {
      if (turn === browseTurn.current) setListingBusy(false);
    }
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
  return (
    <section className="page ssh-settings" aria-label="SSH 连接设置">
      <div className="page-body">
        <h1 className="page-title">连接</h1>
        <p className="muted">通过 SSH 连接其他设备，在远程项目中开发。</p>
        <div className="ssh-heading">
          <h2 className="page-heading">来自此电脑的 SSH 连接</h2>
          <Button
            size="sm"
            disabled={!api || busy}
            onClick={() => {
              setForm({ ...initial });
              setSecret('');
              setError('');
              setAdding(true);
            }}
          >
            <Plus />
            添加
          </Button>
        </div>
        <div className="card">
          {!entries.length && <p className="muted ssh-empty">尚未添加 SSH 连接</p>}
          {entries.map((entry) => (
            <div className="setting-row ssh-row" key={entry.id}>
              <Switch
                small
                label={`连接 ${entry.name}`}
                checked={['connecting', 'ssh-connected', 'connected'].includes(entry.status)}
                disabled={busy || !api || (!entry.available && entry.status === 'disconnected')}
                onChange={(on) => (on ? credentials(entry) : void disconnect(entry))}
              />
              <Laptop />
              <span className="ssh-detail">
                <strong>{entry.name}</strong>
                <small className="ssh-address">
                  {entry.username}@{entry.host}:{entry.port}
                </small>
                <small className={entry.status === 'connected' ? 'ssh-ready' : ''}>
                  {entry.status !== 'failed' && entry.status !== 'disconnected' && entry.stage
                    ? stageText[entry.stage]
                    : statusText[entry.status]}
                </small>
                {!entry.available && <small>请连接此配置所属的 Ubuntu 工作空间</small>}
                {entry.projects[0] && (
                  <small className="ssh-address" title={entry.projects[0]}>
                    最近项目：{entry.projects[0]}
                  </small>
                )}
                {entry.error && <small className="error-text">{entry.error}</small>}
              </span>
              <div className="setting-actions">
                {entry.projects.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || entry.status !== 'connected' || !openSession}
                    onClick={() => void openProject(entry, entry.projects[0])}
                  >
                    继续上次
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy || entry.status !== 'connected' || !openSession}
                  onClick={() => {
                    setDirectory(entry.projects[0] ?? '');
                    browseTurn.current++;
                    setListing(null);
                    setListingBusy(false);
                    setProject(entry);
                    setError('');
                  }}
                >
                  <FolderOpen />
                  打开项目
                </Button>
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
        {!dialog && error && (
          <p className="error-text" role="alert">
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
          <form className="ssh-form" onSubmit={submit}>
            <fieldset disabled={busy}>
              {adding && (
                <>
                  <label>
                    显示名称
                    <input
                      value={form.name}
                      maxLength={120}
                      placeholder="例如：实验室 Ubuntu"
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <label>
                    主机名
                    <input
                      required
                      value={form.host}
                      placeholder="host.com 或 10.0.0.20"
                      onChange={(e) => setForm({ ...form, host: e.target.value })}
                    />
                  </label>
                  <div className="ssh-login-fields">
                    <label>
                      用户名
                      <input
                        required
                        value={form.username}
                        autoComplete="username"
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
                  {form.auth === 'key' && (
                    <label>
                      身份文件路径
                      <div className="ssh-identity">
                        <input
                          aria-label="身份文件路径"
                          required
                          value={form.identityFile}
                          onChange={(e) => setForm({ ...form, identityFile: e.target.value })}
                        />
                        <Button
                          size="sm"
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
              {(adding || login) && (
                <label>
                  {(adding ? form.auth : login!.auth) === 'key' ? '私钥口令（如有）' : 'SSH 密码'}
                  <input
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                  <small className="muted">仅用于本次连接，不保存密码或口令。</small>
                </label>
              )}
              {project && (
                <div className="ssh-project-choice">
                  <label>
                    项目绝对路径
                    <div className="ssh-identity">
                      <input
                        aria-label="项目绝对路径"
                        required
                        list="ssh-project-paths"
                        value={directory}
                        placeholder="/home/dev/project"
                        onChange={(e) => {
                          setDirectory(e.target.value);
                          browseTurn.current++;
                          setListing(null);
                          setListingBusy(false);
                        }}
                      />
                      <Button
                        size="sm"
                        disabled={listingBusy}
                        onClick={() => void browse(directory.trim() || undefined)}
                      >
                        浏览
                      </Button>
                    </div>
                    <datalist id="ssh-project-paths">
                      {project.projects.map((path) => (
                        <option key={path} value={path} />
                      ))}
                    </datalist>
                  </label>
                  <p className="muted">
                    优先继续该目录最近使用的会话；需要独立对话时选择“新建会话”。
                  </p>
                  {listingBusy && (
                    <p className="muted" role="status">
                      正在读取目标设备的目录…
                    </p>
                  )}
                  {listing && (
                    <div className="ssh-directory-browser" aria-label="远程目录选择">
                      <div className="ssh-directory-heading">
                        <small title={listing.path}>{listing.path}</small>
                        <IconButton
                          title="上一级目录"
                          disabled={listingBusy || listing.parent === listing.path}
                          onClick={() => void browse(listing.parent)}
                        >
                          <ArrowUp />
                        </IconButton>
                      </div>
                      <div className="ssh-directories" role="group" aria-label="远程文件夹">
                        {listing.directories.map((folder) => (
                          <Button
                            key={folder.path}
                            variant="ghost"
                            size="sm"
                            disabled={listingBusy}
                            title={folder.path}
                            onClick={() => void browse(folder.path)}
                          >
                            <FolderOpen />
                            <span>{folder.name}</span>
                          </Button>
                        ))}
                        {!listing.directories.length && (
                          <p className="muted">此目录下没有可浏览的文件夹，可直接打开当前目录。</p>
                        )}
                      </div>
                    </div>
                  )}
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
