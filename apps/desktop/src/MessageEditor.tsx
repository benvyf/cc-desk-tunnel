import { useId, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle } from './icons.tsx';
import AttachmentTiles from './AttachmentTiles.tsx';
import QuoteChips from './QuoteChips.tsx';
import { fitDraft } from './Composer.tsx';
import { messageLimit, withPastedText } from './attachments.ts';
import { joinMessage, messageParts } from './messageParts.ts';

// A question edited where it stands (Conversation.tsx): the bubble becomes a box as wide as the conversation, with
// what it carried still removable, and is sent again from there. Nothing is asked of the service until it is sent;
// cancelling puts the question back as it was.
export default function MessageEditor({
  text,
  blocked,
  send,
  cancel,
}: {
  // The question as it was sent.
  text: string;
  // Why it cannot be sent just now (a run under way, no connection); the box keeps what was written meanwhile.
  blocked?: string;
  // Resolves false when nothing was sent, which keeps the box open.
  send: (text: string) => Promise<boolean>;
  cancel: () => void;
}) {
  const [parts, setParts] = useState(() => messageParts(text));
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const composition = useRef({ active: false, until: 0 });
  const errorId = useId();
  const hintId = useId();
  const draft = joinMessage(parts);
  const body = withPastedText(parts.body, parts.blocks);
  const tooLong = draft.trim().length > messageLimit;
  const sendable =
    !sending &&
    !blocked &&
    !tooLong &&
    draft.trim() !== text.trim() &&
    (!!body.trim() || parts.files.length > 0) &&
    !(parts.quotes.length && !body.trim());
  // Opened with the caret at the end of the words, and in sight.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    fitDraft(element);
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    element.scrollTop = element.scrollHeight;
    frame.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  useLayoutEffect(() => fitDraft(box.current), [parts.body]);
  async function submit() {
    if (!sendable) return;
    setSending(true);
    try {
      if (await send(draft)) return;
    } catch {
      // Told where it was sent from (App.tsx).
    }
    setSending(false);
    requestAnimationFrame(() => box.current?.focus());
  }
  const refocus = () => box.current?.focus();
  return (
    <div className="message-editor" ref={frame} aria-busy={sending || undefined}>
      <QuoteChips
        quotes={parts.quotes}
        remove={
          sending
            ? undefined
            : (id) => {
                setParts((value) => ({
                  ...value,
                  quotes: value.quotes.filter((quote) => quote.id !== id),
                }));
                refocus();
              }
        }
      />
      <AttachmentTiles
        items={[...parts.blocks, ...parts.files]}
        disabled={sending}
        expand={(id) => {
          const block = parts.blocks.find((item) => item.id === id);
          if (block?.text === undefined) return;
          setParts((value) => ({
            ...value,
            body: !value.body ? block.text! : `${value.body.replace(/\n+$/, '')}\n${block.text}`,
            blocks: value.blocks.filter((item) => item.id !== id),
          }));
          requestAnimationFrame(() => {
            const element = box.current;
            if (!element) return;
            element.focus();
            element.setSelectionRange(element.value.length, element.value.length);
            element.scrollTop = element.scrollHeight;
          });
        }}
        remove={(id) => {
          setParts((value) => ({
            ...value,
            blocks: value.blocks.filter((item) => item.id !== id),
            files: value.files.filter((item) => item.id !== id),
          }));
          refocus();
        }}
      />
      <textarea
        ref={box}
        rows={1}
        aria-label="编辑内容"
        value={parts.body}
        maxLength={messageLimit}
        readOnly={sending}
        aria-invalid={tooLong || undefined}
        aria-describedby={tooLong ? errorId : blocked ? hintId : undefined}
        onChange={(event) => {
          const value = event.target.value;
          setParts((current) => ({ ...current, body: value }));
        }}
        onCompositionStart={() => {
          composition.current.active = true;
        }}
        onCompositionEnd={() => {
          composition.current.active = false;
          // As in the input box (Composer.tsx): keys that close a composition can arrive just after it ends.
          composition.current.until = performance.now() + 10;
        }}
        onKeyDown={(event) => {
          const composing =
            composition.current.active ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229;
          if (composing || performance.now() < composition.current.until) {
            event.stopPropagation();
            if (!composing && event.key === 'Enter' && !event.shiftKey) event.preventDefault();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            // Find and the panels have their own Escape; this one is the box's.
            event.stopPropagation();
            if (!sending) cancel();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {tooLong && (
        <small id={errorId} className="attachment-error" role="alert">
          消息过长（含附件），请缩短正文或移除部分附件。
        </small>
      )}
      <div className="message-editor-actions">
        {blocked && !tooLong && (
          <small id={hintId} className="message-editor-hint" role="status">
            {blocked}
          </small>
        )}
        <button type="button" className="button secondary" disabled={sending} onClick={cancel}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!sendable}
          onClick={() => void submit()}
        >
          {sending && <LoaderCircle className="spinning" />}
          {sending ? '发送中' : '发送'}
        </button>
      </div>
    </div>
  );
}
