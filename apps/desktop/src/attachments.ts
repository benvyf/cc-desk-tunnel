export type Attachment = {
  id: string;
  name: string;
  path?: string;
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
