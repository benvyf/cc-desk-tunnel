import { useState } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { folderName } from './paths.ts';
import { isMac } from './platform.ts';
import { Button, Modal } from './ui.tsx';

// The dialogs share the window's busy flag and error line, so a failed request stays visible in the open dialog.
type DialogProps = { busy: boolean; connected: boolean; error: string | null; close: () => void };

export function AddProjectDialog({
  busy,
  connected,
  error,
  close,
  add,
  title = '添加项目',
  action = '添加',
}: DialogProps & { add: (path: string) => void; title?: string; action?: string }) {
  const [path, setPath] = useState('');
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          add(path.trim());
        }}
      >
        <label>
          本机项目目录
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={isMac ? '/Users/me/projects/my-project' : 'D:\\projects\\my-project'}
            maxLength={2048}
            required
            spellCheck={false}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !connected}>
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteSessionDialog({
  session,
  busy,
  connected,
  error,
  close,
  confirm,
}: DialogProps & {
  session: Session;
  // Both kinds of session say the same now (only the session's record goes; the project's files stay).
  native: boolean;
  confirm: () => void;
}) {
  return (
    <Modal
      title="删除会话"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <p className="delete-question">删除“{session.title}”？</p>
      <p className="muted">会话记录会被删除，项目文件不受影响。</p>
      {typeof window.desktop?.localHistory?.identity === 'function' && (
        <p className="muted">已保存的本地归档会保留，可在“本地聊天记录”中单独删除。</p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={close}>
          取消
        </Button>
        <Button variant="danger" disabled={busy || !connected} onClick={confirm}>
          删除
        </Button>
      </div>
    </Modal>
  );
}

export function RenameSessionDialog({
  session,
  busy,
  connected,
  error,
  close,
  rename,
}: DialogProps & {
  session: Session;
  rename: (title: string) => void;
}) {
  const [title, setTitle] = useState(session.title);
  return (
    <Modal
      title="重命名会话"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          rename(title);
        }}
      >
        <label>
          名称
          <input
            autoFocus
            maxLength={120}
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !connected}>
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameProjectDialog({
  path,
  name: current,
  close,
  rename,
}: {
  path: string;
  name: string;
  close: () => void;
  rename: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  return (
    <Modal title="项目显示名称" onClose={close}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          rename(name.trim());
        }}
      >
        <label>
          显示名称
          <input
            autoFocus
            maxLength={60}
            value={name}
            placeholder={folderName(path)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="muted">
          只改变这台电脑上列表里的名字，不改动文件夹 <code>{path}</code>；留空恢复文件夹名。
        </p>
        <div className="dialog-actions">
          <Button onClick={close}>取消</Button>
          <Button type="submit" variant="primary">
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
