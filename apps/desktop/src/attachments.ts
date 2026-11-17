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

export function pastedBlock(text: string): Attachment {
  const title = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return {
    id: `text:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    name: (title ?? '粘贴的文本').slice(0, 80),
    text,
    status: 'ready',
  };
}

export function pastedSummary(text: string) {
  return `${text.split('\n').length} 行 · ${text.length.toLocaleString('zh-CN')} 字`;
}

// Pasted blocks follow the typed text; local attachments still reach Claude through the execution channel as
// quoted path lines at the end, and previews never enter the message.
export function attachmentMessage(text: string, attachments: Attachment[]) {
  const blocks = attachments
    .filter((item) => item.status === 'ready' && item.text !== undefined && !item.path)
    .map((item) => item.text!);
  const body = [text, ...blocks].filter(Boolean).join('\n\n');
  const paths = attachments
    .filter((item) => item.status === 'ready' && item.path)
    .map((item) => `"${item.path}"`);
  return [body, ...paths].filter(Boolean).join('\n');
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
