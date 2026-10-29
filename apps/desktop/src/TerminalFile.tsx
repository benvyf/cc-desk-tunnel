import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { platformOf } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Button, Modal } from './ui.tsx';
import { isPicture } from './links.ts';
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
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [connection] = useState(state.connectionId);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [local, setLocal] = useState(false);
  const target = terminalTarget(raw);
  // File URIs identify the exact filename; plain CLI paths may carry a line/column.
  const position = /^file:/i.test(raw) ? null : /:(\d+)(?::(\d+))?$/.exec(target.value);
  const path = position ? target.value.slice(0, position.index) : target.value;
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(path);
  const here = !!window.desktop && !state.browser && session.device?.id === state.device?.id;
  const connected = state.status === 'connected' && state.connectionId === connection;
  const accessible = connected && (!windows || here);
  const canAccess = () =>
    client.state.status === 'connected' &&
    client.state.connectionId === connection &&
    (!windows ||
      (!!window.desktop &&
        !client.state.browser &&
        session.device?.id === client.state.device?.id));
  const copy = () =>
    void (
      window.desktop?.copyText(target.value) ?? navigator.clipboard.writeText(target.value)
    ).catch(() => setError('复制失败。'));
  useEffect(() => {
    let disposed = false;
    setError('');
    setPreview(null);
    setLocal(false);
    void Promise.resolve().then(async () => {
      if (disposed) return;
      try {
        if (!connected) throw new Error('连接已变化或已断开，请在当前终端重新打开预览。');
        if (target.kind !== 'path')
          throw new Error('无法确定来源或实际工作目录，请复制后在终端中确认。');
        if (windows) {
          if (!here || platformOf(session.device) !== 'win32')
            throw new Error('这是另一台设备的路径，不能按本机同名文件打开。');
          const info = await window.desktop!.inspectPath(path);
          if (disposed || !canAccess()) return;
          if (info.kind === 'missing') throw new Error('本机找不到这个路径。');
          setLocal(true);
          const picture =
            isPicture(path) && info.kind === 'file'
              ? await window.desktop!.attachmentPreview(path)
              : null;
          if (disposed || !canAccess()) return;
          if (picture) setPreview({ mime: 'image/*', data: picture, encoding: 'base64' });
          else if (isPicture(path)) setError('图片无法预览，可能过大或格式暂不支持。');
          else if (info.kind === 'file') {
            const data = await window.desktop!.readTerminalText(path);
            if (!disposed && canAccess())
              setPreview({ mime: 'text/plain', data, encoding: 'utf8' });
          }
        } else {
          if (!client.state.terminalFiles) throw new Error('此节点暂不支持文件预览，请复制路径。');
          const file = await client.fetch({
            type: 'terminal.file.read',
            sessionId: session.id,
            path,
          });
          if (disposed || !canAccess()) return;
          setPreview(file);
        }
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : '预览失败。');
      }
    });
    return () => {
      disposed = true;
    };
  }, [client, session.id, raw, state.connectionId, state.status, here]);
  return (
    <Modal
      title={windows ? `项目设备：${session.device?.name ?? '未知'}` : `节点：${nodeName}`}
      onClose={onClose}
    >
      <p className="terminal-file-path">{path}</p>
      {error && <p role="alert">{error}</p>}
      {preview &&
        accessible &&
        (preview.mime.startsWith('image/') ? (
          <img
            className="terminal-file-image"
            alt={path}
            src={local ? preview.data : `data:${preview.mime};base64,${preview.data}`}
            onError={() => setError('图片内容无法解码，请下载或打开文件检查。')}
          />
        ) : (
          <pre className="terminal-file-text">{preview.data}</pre>
        ))}
      <div className="dialog-actions">
        <Button onClick={copy}>复制路径</Button>
        {local && accessible && (
          <Button
            onClick={() => {
              if (!canAccess()) return;
              void window
                .desktop!.actOnPath('open', path, {
                  line: position ? Number(position[1]) : undefined,
                  column: position?.[2] ? Number(position[2]) : undefined,
                })
                .then(
                  (message) => message && setError(message),
                  () => setError('打开失败。'),
                );
            }}
          >
            打开
          </Button>
        )}
        {preview && accessible && !local && window.desktop?.saveTerminalFile && (
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
