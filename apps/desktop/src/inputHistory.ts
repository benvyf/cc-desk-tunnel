import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { messageLimit, splitAttachmentMessage } from './attachments.ts';
import { splitQuoteMessage } from './quotes.ts';

// Reuse the current session's saved messages and pending queue. This is a view,
// not a second store; failed sends and other sessions never enter it.
export function inputHistory(
  events: readonly { payload: EventPayload }[],
  queued: readonly { id?: string; text: string }[] = [],
): string[] {
  const result: string[] = [];
  const sent = new Set(
    events.flatMap(({ payload }) => (payload.type === 'message.user' ? [payload.messageId] : [])),
  );
  const texts = [
    ...events.flatMap(({ payload }) =>
      payload.type === 'message.user' && !payload.continued ? [payload.text] : [],
    ),
    ...queued.filter(({ id }) => !id || !sent.has(id)).map(({ text }) => text),
  ];
  for (let index = texts.length - 1; index >= 0 && result.length < 200; index--) {
    const text = splitQuoteMessage(splitAttachmentMessage(texts[index]).text).text;
    if (text.trim() && text.length <= messageLimit && result.at(-1) !== text) result.push(text);
  }
  return result.reverse();
}
