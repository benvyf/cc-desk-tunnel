import { useId, useState } from 'react';
import { ArrowUp, Check, ListOrdered, Pencil, Trash2, X } from './icons.tsx';
import { IconButton } from './ui.tsx';
import { attachmentMessage, messageLimit, splitAttachmentMessage } from './attachments.ts';
import type { FollowUp } from './followUps.ts';

export default function FollowUpQueue({
  items,
  paused,
  sending,
  disabled,
  running,
  remove,
  edit,
  beginEdit,
  sendNow,
  resume,
}: {
  items: FollowUp[];
  paused?: string;
  sending?: string;
  disabled: boolean;
  running: boolean;
  remove: (id: string) => void;
  edit: (id: string, text: string) => void;
  beginEdit: () => void;
  sendNow: (id: string) => void;
  resume: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const editorErrorId = useId();
  if (!items.length) return null;
  return (
    <section className="follow-up-queue" aria-label="待发送消息">
      {paused && (
        <header>
          <span title={paused}>{paused}</span>
          <button
            type="button"
            className="button"
            disabled={disabled || !!sending || !!editing}
            onClick={resume}
          >
            继续排队
          </button>
        </header>
      )}
      <ol>
        {items.map((item) => {
          const attached = splitAttachmentMessage(item.text);
          const draft = attachmentMessage(text, attached.files);
          const tooLong = draft.trim().length > messageLimit;
          const locked = disabled || !!sending;
          return (
            <li key={item.id}>
              <ListOrdered className="queued-message-icon" />
              {editing === item.id ? (
                <>
                  <div className="queued-editor">
                    <textarea
                      autoFocus
                      aria-label="编辑排队消息"
                      value={text}
                      maxLength={messageLimit}
                      disabled={locked}
                      aria-invalid={tooLong || undefined}
                      aria-describedby={tooLong ? editorErrorId : undefined}
                      onChange={(event) => setText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditing(null);
                        }
                      }}
                    />
                    {tooLong && (
                      <small id={editorErrorId} className="attachment-error" role="alert">
                        消息过长（含附件），请缩短正文或移除消息后重新添加附件。
                      </small>
                    )}
                  </div>
                  <IconButton
                    title="保存排队消息"
                    disabled={locked || (!text.trim() && !attached.files.length) || tooLong}
                    onClick={() => {
                      edit(item.id, draft);
                      setEditing(null);
                    }}
                  >
                    <Check />
                  </IconButton>
                  <IconButton title="取消编辑" onClick={() => setEditing(null)}>
                    <X />
                  </IconButton>
                </>
              ) : (
                <>
                  <span className="queued-text" title={attached.text}>
                    {attached.text || '附件消息'}
                    {attached.files.length > 0 && <small> · {attached.files.length} 个附件</small>}
                  </span>
                  {sending === item.id ? (
                    <small role="status">正在发送…</small>
                  ) : (
                    <>
                      <IconButton
                        title="编辑排队消息"
                        disabled={locked || !!item.attempted}
                        onClick={() => {
                          beginEdit();
                          setEditing(item.id);
                          setText(attached.text);
                        }}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        title="移除排队消息"
                        disabled={!!sending}
                        onClick={() => remove(item.id)}
                      >
                        <Trash2 />
                      </IconButton>
                      <IconButton
                        title={running ? '插话发送此消息' : '立即发送此消息'}
                        disabled={locked}
                        onClick={() => sendNow(item.id)}
                      >
                        <ArrowUp />
                      </IconButton>
                    </>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
