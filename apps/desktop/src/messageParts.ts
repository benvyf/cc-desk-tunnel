import {
  attachmentMessage,
  splitAttachmentMessage,
  splitPastedText,
  withPastedText,
} from './attachments.ts';
import { quoteMessage, splitQuoteMessage } from './quotes.ts';

// A sent question taken apart the way the input box holds a message: typed text, the pasted blocks beside it, quotes
// above it and files by path (MessageEditor.tsx, and an edit that comes back to an input box in App.tsx).
export function messageParts(text: string) {
  const attached = splitAttachmentMessage(text);
  const referenced = splitQuoteMessage(attached.text);
  const pasted = splitPastedText(referenced.text);
  return {
    body: pasted.text,
    blocks: pasted.blocks,
    quotes: referenced.quotes,
    files: attached.files,
  };
}
export type MessageParts = ReturnType<typeof messageParts>;
// And put back together, as the input box would send it.
export function joinMessage(parts: MessageParts) {
  return attachmentMessage(
    quoteMessage(withPastedText(parts.body, parts.blocks), parts.quotes),
    parts.files,
  );
}
