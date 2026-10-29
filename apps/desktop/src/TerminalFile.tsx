import { useEffect, useState } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { platformOf } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Button, Modal } from './ui.tsx';
import { isPicture, linkTarget } from './links.ts';
import { terminalTarget } from './terminalLinks.ts';

type Preview = { mime: string; data: string; encoding: 'utf8' | 'base64' };
export default function TerminalFile({
  client,
  session,
  raw,
  nodeName,
  onClose,
}: {
  client: ProxyClient;
  session: Session;
  raw: string;
  nodeName: string;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [local, setLocal] = useState(false);
  const target = terminalTarget(raw);
  const path = target.value.replace(/:(\d+)(?::\d+)?$/, '');
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(path);
  const here =
    !!window.desktop && !client.state.browser && session.device?.id === client.state.device?.id;
  const copy = () =>
    void (
      window.desktop?.copyText(target.value) ?? navigator.clipboard.writeText(target.value)
    ).catch(() => setError('复制失败。'));
  useEffect(() => {
    let disposed = false;
    const generation = client.state.connectionId;
    void Promise.resolve().then(async () => {
      if (disposed) return;
      try {
        if (target.kind !== 'path')
          throw new Error('无法确定来源或实际工作目录，请复制后在终端中确认。');
        if (windows) {
          if (!here || platformOf(session.device) !== 'win32')
            throw new Error('这是另一台设备的路径，不能按本机同名文件打开。');
          const info = await window.desktop!.inspectPath(path);
          if (info.kind === 'missing') throw new Error('本机找不到这个路径。');
          const picture =
            isPicture(path) && info.kind === 'file'
              ? await window.desktop!.attachmentPreview(path)
              : null;
          if (disposed) return;
          setLocal(true);
          if (picture) setPreview({ mime: 'image/*', data: picture, encoding: 'base64' });
        } else {
          if (!client.state.terminalFiles) throw new Error('此节点暂不支持文件预览，请复制路径。');
          const file = await client.fetch({
            type: 'terminal.file.read',
            sessionId: session.id,
            path,
          });
          if (disposed || client.state.connectionId !== generation) return;
          setPreview(file);
        }
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : '预览失败。');
      }
    });
    return () => {
      disposed = true;
    };
  }, [client, session.id, raw]);
  return (
    <Modal
      title={windows ? `项目设备：${session.device?.name ?? '未知'}` : `节点：${nodeName}`}
      onClose={onClose}
    >
      <p className="terminal-file-path">{path}</p>
      {error && <p role="alert">{error}</p>}
      {preview &&
        (preview.mime.startsWith('image/') ? (
          <img
            className="terminal-file-image"
            alt={path}
            src={local ? preview.data : `data:${preview.mime};base64,${preview.data}`}
          />
        ) : (
          <pre className="terminal-file-text">{preview.data}</pre>
        ))}
      <div className="dialog-actions">
        <Button onClick={copy}>复制路径</Button>
        {local && (
          <Button
            onClick={() => {
              const link = linkTarget(target.value, {
                projectPath: session.projectPath,
                here: true,
                browser: false,
              });
              if (link?.kind === 'path')
                void window.desktop!.actOnPath('open', link.path, link).then(
                  (message) => message && setError(message),
                  () => setError('打开失败。'),
                );
            }}
          >
            打开
          </Button>
        )}
        {preview && !local && window.desktop?.saveTerminalFile && (
          <Button
            onClick={() =>
              void window
                .desktop!.saveTerminalFile(
                  path.split('/').pop() || 'file',
                  preview.data,
                  preview.encoding,
                )
                .catch(() => setError('下载失败。'))
            }
          >
            下载
          </Button>
        )}
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Modal>
  );
}
