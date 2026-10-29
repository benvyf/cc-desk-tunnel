import { useEffect, useRef, useState } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { TerminalHandle, TerminalPhase } from './NativeTerminal.tsx';
import { Button } from './ui.tsx';
import AttachmentTiles from './AttachmentTiles.tsx';
import {
  attachmentKind,
  attachmentMessage,
  fileName,
  messageLimit,
  type Attachment,
} from './attachments.ts';

// Mounted once per tab, including while hidden: drafts never belong to the active
// tab implicitly. Async file preparation only updates this component's attachments.
export default function TerminalDraft({
  session,
  handle,
  phase,
  attachmentsAllowed,
}: {
  session: Session;
  handle: () => TerminalHandle | undefined;
  phase: TerminalPhase | 'creating';
  attachmentsAllowed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ready =
    phase === 'running' &&
    attachments.every((item) => item.status === 'ready') &&
    (!attachments.length || attachmentsAllowed);
  const text = attachmentMessage(draft, attachments);
  // The CLI is on Ubuntu. Local project files use its existing SSH execution
  // channel; images explicitly use the existing single-file scp/Read workflow.
  const payload = attachments.some((item) => attachmentKind(item.name) === 'IMAGE')
    ? `${text}\n图片附件来自项目设备 ${session.device?.name ?? ''}；请使用已有 SSH 单文件临时复制到 Linux、Read 后删除临时副本的流程读取。`
    : text;
  function add(paths: string[]) {
    if (!mounted.current) return;
    setAttachments((items) => {
      const known = new Set(items.map((item) => item.path));
      return [
        ...items,
        ...paths
          .filter((path) => {
            if (known.has(path)) return false;
            known.add(path);
            return true;
          })
          .map((path): Attachment => ({
            id: crypto.randomUUID(),
            name: fileName(path),
            path,
            status: 'ready',
          })),
      ];
    });
  }
  async function files(files: File[]) {
    if (!attachmentsAllowed || !window.desktop) return;
    for (const file of files) {
      if (!mounted.current) return;
      let path = '';
      try {
        path = window.desktop.pathForFile(file);
      } catch {
        /* Clipboard image. */
      }
      if (path) {
        add([path]);
        continue;
      }
      if (!file.type.startsWith('image/')) continue;
      const id = crypto.randomUUID();
      setAttachments((items) => [
        ...items,
        { id, name: file.name || '粘贴的图片', status: 'preparing' },
      ]);
      try {
        if (file.size > 20 << 20) throw new Error('图片超过 20 MB。');
        const saved = await window.desktop.saveImage(
          file.type,
          new Uint8Array(await file.arrayBuffer()),
        );
        if (mounted.current)
          setAttachments((items) =>
            items.map((item) =>
              item.id === id ? { ...item, path: saved, status: 'ready' } : item,
            ),
          );
      } catch (error) {
        if (mounted.current)
          setAttachments((items) =>
            items.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status: 'error',
                    error: error instanceof Error ? error.message : '保存失败。',
                  }
                : item,
            ),
          );
      }
    }
  }
  return (
    <section className="terminal-draft" aria-label="终端输入草稿">
      <div className="terminal-draft-actions">
        <Button
          size="sm"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded) requestAnimationFrame(() => input.current?.focus());
          }}
        >
          {expanded ? '收起编辑' : '编辑输入'}
        </Button>
        {expanded && (
          <>
            <Button
              size="sm"
              disabled={!ready || !text.trim()}
              onClick={() => {
                if (composing.current) return;
                try {
                  const target = handle();
                  if (!target) throw new Error('终端尚未准备好。');
                  target.paste(payload);
                  setMessage('已粘贴，请在终端检查后自行按 Enter；草稿已保留。');
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : '粘贴失败，草稿已保留。');
                }
              }}
            >
              粘贴到终端
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void (
                  window.desktop?.copyText(payload) ?? navigator.clipboard.writeText(payload)
                ).then(
                  () => setMessage('已复制，请手动粘贴并检查。'),
                  () => setMessage('无法访问剪贴板，草稿已保留。'),
                );
              }}
            >
              复制文本
            </Button>
            <Button
              size="sm"
              disabled={!attachmentsAllowed}
              onClick={() => {
                void window
                  .desktop!.chooseFiles()
                  .then(add, () => mounted.current && setMessage('选择附件失败。'));
              }}
            >
              添加附件
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setDraft('');
                setAttachments([]);
                setMessage('');
              }}
            >
              清空
            </Button>
          </>
        )}
      </div>
      {expanded && (
        <div
          className="terminal-draft-body"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void files([...event.dataTransfer.files]);
          }}
        >
          <AttachmentTiles
            items={attachments}
            remove={(id) => setAttachments((items) => items.filter((item) => item.id !== id))}
          />
          <textarea
            ref={input}
            aria-label="多行终端草稿"
            placeholder="Enter 换行；粘贴后在终端确认"
            value={draft}
            maxLength={messageLimit}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onPaste={(event) => {
              if (event.clipboardData.files.length && attachmentsAllowed) {
                event.preventDefault();
                void files([...event.clipboardData.files]);
              }
            }}
          />
          {!attachmentsAllowed && <small>当前项目不在本机，暂不支持添加本机附件。</small>}
          {message && <p role="status">{message}</p>}
        </div>
      )}
    </section>
  );
}
