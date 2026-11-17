export type Attachment = {
  id: string;
  name: string;
  path?: string;
  // A long pasted text, kept beside the message instead of in the box; sent as part of the message.
  text?: string;
  status: 'preparing' | 'ready' | 'error';
  error?: string;
};
export type SetAttachments = (
  sessionId: string,
  update: (current: Attachment[]) => Attachment[],
) => void;

// Includes the attachment references appended to the text, matching message.send validation.
export const messageLimit = 16000;

export function fileName(path: string) {
  return path.split(/[/\\]/).pop() || '未命名文件';
}

export function attachmentKind(name: string) {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (/^(png|jpe?g|gif|webp|bmp|avif|heic)$/.test(extension)) return 'IMAGE';
  if (/^(ts|tsx|js|jsx|json|css|html|py|rs|go|java|c|cpp|h|sh|ya?ml|toml)$/.test(extension))
    return 'CODE';
  return extension && extension !== name.toLowerCase()
    ? extension.slice(0, 8).toUpperCase()
    : 'FILE';
}

// Pasted text this long becomes a block beside the message instead of filling the box.
export const pastedBlockLines = 20;
export const pastedBlockChars = 2000;

export function isPastedBlock(text: string) {
  return text.length >= pastedBlockChars || text.split('\n').length >= pastedBlockLines;
}

// Six lowercase letters or digits: a block's tag in the sent message (see `withPastedText`).
const tagPattern = /^[a-z0-9]{6}$/;
function randomTag() {
  const digits = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(digits, (value) => (value % 36).toString(36)).join('');
}
// A block's tag is the end of its id; ids from elsewhere get one derived from the whole id.
function tagOf(item: Attachment) {
  const end = item.id.slice(-6);
  if (tagPattern.test(end)) return end;
  let hash = 0;
  for (const char of item.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36).padStart(6, '0').slice(-6);
}

export function pastedBlock(text: string, tag = randomTag()): Attachment {
  const title = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return {
    id: `text:${Date.now().toString(36)}:${tag}`,
    name: (title ?? '粘贴的文本').slice(0, 80),
    text,
    status: 'ready',
  };
}

export function pastedSummary(text: string) {
  // Text copied from a terminal or an editor usually ends with a line break, which starts no line of its own.
  const lines = text.replace(/\n$/, '').split('\n').length;
  return `${lines} 行 · ${text.length.toLocaleString('zh-CN')} 字符`;
}

export function isPastedText(item: Attachment) {
  return item.text !== undefined && !item.path;
}

// The question as written: the typed text, then each pasted block, a blank line apart. It is what quotes wrap
// (see quoteMessage), so blocks belong to the text and not after the quote payload. Each block is wrapped in a
// tag of its own, which tells Claude it is pasted material and lets a sent message show it as a card again
// (see `splitPastedText`); the random part keeps a tag in the pasted text itself from ending the block.
export function withPastedText(text: string, attachments: Attachment[]) {
  const blocks = attachments
    .filter((item) => item.status === 'ready' && isPastedText(item))
    .map((item) => {
      const tag = `pasted_text_${tagOf(item)}`;
      return `<${tag}>\n${item.text}\n</${tag}>`;
    });
  return [text, ...blocks].filter(Boolean).join('\n\n');
}

// The pasted blocks at the end of a sent question, and the typed text before them. Text that only looks like a
// block somewhere else stays text.
const trailingBlock = /(?:^|\n\n)<pasted_text_([a-z0-9]{6})>\n([\s\S]*)\n<\/pasted_text_\1>$/;
export function splitPastedText(text: string) {
  const blocks: Attachment[] = [];
  let rest = text;
  for (let match = trailingBlock.exec(rest); match; match = trailingBlock.exec(rest)) {
    // The same message gives the same ids on every render; the tag stays the id's end (see `tagOf`).
    blocks.unshift({
      ...pastedBlock(match[2], match[1]),
      id: `text:sent:${match.index}:${match[1]}`,
    });
    rest = rest.slice(0, match.index);
  }
  return { text: rest, blocks };
}

// Copy and export: the question with its pasted text in place, without the tags.
export function plainPastedText(text: string) {
  const { text: typed, blocks } = splitPastedText(text);
  return [typed, ...blocks.map((block) => block.text!)].filter(Boolean).join('\n\n');
}

// Local attachments still reach Claude through the execution channel; previews never enter the message.
export function attachmentMessage(text: string, attachments: Attachment[]) {
  const paths = attachments
    .filter((item) => item.status === 'ready' && item.path)
    .map((item) => `"${item.path}"`);
  return [text, ...paths].filter(Boolean).join('\n');
}

// Only full, quoted path lines at the end of a user message are attachment references. Inline paths,
// code blocks and ordinary prose keep their original presentation and copy/export text.
export function splitAttachmentMessage(text: string) {
  const lines = text.split('\n');
  const files: Attachment[] = [];
  while (lines.length) {
    const match = /^"((?:[A-Za-z]:[/\\]|\\\\|\/)[^"\r\n]+)"$/.exec(lines.at(-1)!);
    if (!match) break;
    const path = match[1];
    files.unshift({ id: `${lines.length}:${path}`, name: fileName(path), path, status: 'ready' });
    lines.pop();
  }
  return { text: lines.join('\n'), files };
}
