import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ProxyClient } from './client.ts';
import type { SshDirectoryList, SshTargetInput } from './desktop.d.ts';
import { ArrowUp, Folder, FolderOpen, Plus } from './icons.tsx';
import { Button, IconButton, Modal } from './ui.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { useSshTargets } from './useSshTargets.ts';

const emptyTarget: SshTargetInput = {
  name: '',
  host: '',
  username: '',
  port: 22,
  auth: 'key',
  identityFile: '',
};

export default function OpenProjectDialog({
  client,
  initial,
  forceNew = false,
  onLocal,
  onRemote,
  onClose,
}: {
  client: ProxyClient;
  initial?: { deviceId?: string; path?: string; creationId?: string };
  forceNew?: boolean;
  onLocal: (path: string, creationId: string) => Promise<void>;
  onRemote: (sessionId: string, created: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const api = window.desktop?.ssh;
  const targets = useSshTargets();
  const [deviceId, setDeviceId] = useState(initial?.deviceId ?? '');
  const [path, setPath] = useState(initial?.path ?? '');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyTarget);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listing, setListing] = useState<SshDirectoryList | null>(null);
  const [listingBusy, setListingBusy] = useState(false);
  const alive = useRef(true);
  const turn = useRef(0);
  const connection = useRef<string | null>(null);
  const browsingDevice = useRef('');
  const opened = useRef<{ sessionId: string; created: boolean } | null>(null);
  const creation = useRef<{ key: string; id: string } | null>(
    initial?.creationId
      ? {
          key: JSON.stringify([initial.deviceId ?? '', initial.path?.trim() ?? '', forceNew]),
          id: initial.creationId,
        }
      : null,
  );
  const target = targets.find((entry) => entry.id === deviceId);
  const ready = target?.status === 'connected';
  const connectionId = useRef(client.state.connectionId);
  const current = () => alive.current && client.state.connectionId === connectionId.current;
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const cancelConnection = () => {
    const id = connection.current;
    connection.current = null;
    if (id) void api?.disconnect(id).catch(() => {});
  };
  useEffect(() => {
    alive.current = true;
    const off = client.subscribe?.(() => {
      if (client.state.connectionId !== connectionId.current && alive.current) {
        alive.current = false;
        turn.current++;
        cancelConnection();
        closeCallback.current();
      }
    });
    return () => {
      alive.current = false;
      turn.current++;
      cancelConnection();
      off?.();
    };
  }, [client]);

  async function browse(directory?: string) {
    if (!api || !deviceId || !ready) return;
    const generation = ++turn.current;
    setListingBusy(true);
    setError('');
    try {
      const value = await api.directories(deviceId, directory);
      if (!current() || generation !== turn.current) return;
      if (value.path !== path) opened.current = null;
      setPath(value.path);
      setListing(value);
    } catch (e) {
      if (current() && generation === turn.current)
        setError(e instanceof Error ? e.message : '无法浏览远程目录，请检查连接与权限。');
    } finally {
      if (current() && generation === turn.current) setListingBusy(false);
    }
  }
  useEffect(() => {
    if (ready && browsingDevice.current !== deviceId) {
      browsingDevice.current = deviceId;
      void browse(path || target?.projects[0] || undefined);
    }
  }, [deviceId, ready]);
  function changePath(value: string) {
    turn.current++;
    opened.current = null;
    setListing(null);
    setListingBusy(false);
    setPath(value);
  }
  function chooseDevice(value: string) {
    browsingDevice.current = '';
    changePath('');
    setDeviceId(value);
    setSecret('');
    setError('');
  }
  function close() {
    if (busy && !connection.current) return;
    alive.current = false;
    turn.current++;
    cancelConnection();
    setSecret('');
    onClose();
  }
  async function act(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : '操作失败，请重试。');
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function connect() {
    if (!api) return;
    let id = deviceId;
    if (adding) {
      id = await api.save(form);
      if (!current()) return;
      setDeviceId(id);
      setAdding(false);
    }
    connection.current = id;
    try {
      await api.connect(id, secret);
      if (current()) setSecret('');
    } finally {
      connection.current = null;
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (adding || (deviceId && !ready)) {
      void act(connect);
      return;
    }
    const directory = path.trim();
    if (!directory) return;
    void act(async () => {
      const key = JSON.stringify([deviceId, directory, forceNew]);
      if (creation.current?.key !== key) creation.current = { key, id: crypto.randomUUID() };
      if (deviceId) {
        if (!api || !ready) throw new Error('SSH 开发通道尚未就绪。');
        const result =
          opened.current ??
          (await api.openProject(deviceId, directory, forceNew, creation.current.id));
        opened.current = result;
        if (!current()) return;
        await onRemote(result.sessionId, result.created);
      } else await onLocal(directory, creation.current.id);
      if (current()) onClose();
    });
  }
  const needsConnection = !!deviceId && !ready;
  const available = !deviceId || !!target?.available;
  return (
    <Modal title={adding ? '添加 SSH 设备' : '打开项目'} onClose={close}>
      <form className="dialog-form ssh-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          {!adding && (
            <label>
              开发设备
              <select
                aria-label="开发设备"
                value={deviceId}
                onChange={(event) => chooseDevice(event.target.value)}
              >
                <option value="">本机</option>
                {targets.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ·{' '}
                    {entry.status === 'connected'
                      ? '已连接'
                      : entry.available
                        ? '未连接'
                        : '不在当前工作空间'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {adding ? (
            <>
              <label>
                显示名称
                <input
                  aria-label="显示名称"
                  value={form.name}
                  maxLength={120}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label>
                主机名
                <input
                  required
                  value={form.host}
                  spellCheck={false}
                  onChange={(event) => {
                    const value = event.target.value;
                    const pair = /^([^@\s]+)@([^@\s]+)$/.exec(value.trim());
                    setForm(
                      pair && !form.username
                        ? { ...form, username: pair[1], host: pair[2] }
                        : { ...form, host: value },
                    );
                  }}
                />
              </label>
              <div className="ssh-login-fields">
                <label>
                  用户名
                  <input
                    required
                    value={form.username}
                    autoComplete="username"
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
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
                    onChange={(event) => setForm({ ...form, port: event.target.value })}
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
                      onChange={(event) => setForm({ ...form, identityFile: event.target.value })}
                    />
                    <Button
                      onClick={() =>
                        void act(async () => {
                          const value = await api!.chooseIdentity();
                          if (current() && value)
                            setForm((previous) => ({ ...previous, identityFile: value }));
                        })
                      }
                    >
                      选择文件
                    </Button>
                  </div>
                </label>
              )}
            </>
          ) : null}
          {(adding || needsConnection) && (
            <>
              {target && (
                <div className="ssh-target">
                  <span>
                    <strong>{target.name}</strong>
                    <small>
                      {target.username}@{target.host}:{target.port}
                    </small>
                  </span>
                </div>
              )}
              {!available && <p role="status">请连接此设备所属的 Ubuntu 工作空间。</p>}
              <label>
                {(adding ? form.auth : target?.auth) === 'key' ? '私钥口令（如有）' : 'SSH 密码'}
                <input
                  type="password"
                  aria-label={
                    (adding ? form.auth : target?.auth) === 'key' ? '私钥口令（如有）' : 'SSH 密码'
                  }
                  autoComplete="off"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
                <small className="ssh-hint">仅用于本次连接，不保存密码或口令。</small>
              </label>
            </>
          )}
          {!adding && !needsConnection && (
            <>
              <label>
                {deviceId ? '项目绝对路径' : '本机项目目录'}
                <div className="ssh-field-row">
                  <input
                    aria-label={deviceId ? '项目绝对路径' : '本机项目目录'}
                    required
                    maxLength={2048}
                    value={path}
                    spellCheck={false}
                    onChange={(event) => changePath(event.target.value)}
                  />
                  {deviceId ? (
                    <Button
                      disabled={listingBusy}
                      onClick={() => void browse(path.trim() || undefined)}
                    >
                      浏览
                    </Button>
                  ) : (
                    window.desktop?.chooseProject && (
                      <Button
                        onClick={() =>
                          void act(async () => {
                            const value = await window.desktop!.chooseProject();
                            if (current() && value) changePath(value);
                          })
                        }
                      >
                        选择文件夹
                      </Button>
                    )
                  )}
                </div>
              </label>
              {target && (
                <>
                  {target.projects.length > 0 && (
                    <div className="ssh-recent-list" role="group" aria-label="最近项目">
                      <span className="ssh-field-label">最近项目</span>
                      {target.projects.slice(0, 5).map((directory) => (
                        <button
                          type="button"
                          key={directory}
                          className="ssh-folder"
                          title={directory}
                          onClick={() => void browse(directory)}
                        >
                          <FolderOpen />
                          <span>{directory}</span>
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
                        onClick={() => listing && void browse(listing.parent)}
                      >
                        <ArrowUp />
                      </IconButton>
                      <code title={listing?.path ?? path}>
                        <bdi>{listing?.path ?? (path || '~')}</bdi>
                      </code>
                    </div>
                    <div className="ssh-directories" role="group" aria-label="远程文件夹">
                      {listingBusy ? (
                        <p className="ssh-directories-note" role="status">
                          正在读取目标设备的目录…
                        </p>
                      ) : (
                        listing?.directories.map((directory) => (
                          <button
                            type="button"
                            key={directory.path}
                            className="ssh-folder"
                            title={directory.path}
                            onClick={() => void browse(directory.path)}
                          >
                            <Folder />
                            <span>{directory.name}</span>
                          </button>
                        ))
                      )}
                      {!listingBusy && listing && !listing.directories.length && (
                        <p className="ssh-directories-note">
                          此目录下没有可浏览的文件夹，可直接打开当前目录。
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </fieldset>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {!adding && api && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                turn.current++;
                setAdding(true);
                setForm({ ...emptyTarget });
                setSecret('');
                setError('');
              }}
            >
              <Plus />
              添加 SSH 设备
            </Button>
          )}
          {adding && (
            <Button
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setSecret('');
                setError('');
              }}
            >
              返回
            </Button>
          )}
          <Button disabled={busy && !connection.current} onClick={close}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              (!adding && (!available || (!needsConnection && (!path.trim() || listingBusy))))
            }
          >
            {busy
              ? '请稍候…'
              : adding
                ? '保存并连接'
                : needsConnection
                  ? '连接'
                  : deviceId && forceNew
                    ? '新建会话'
                    : '打开项目'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
