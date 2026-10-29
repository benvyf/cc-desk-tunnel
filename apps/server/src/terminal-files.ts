import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, sep } from 'node:path';

// Called only for an explicit preview. Never enumerates directories or follows
// terminal output automatically. The caller supplies this session's roots.
export async function readTerminalFile(path: string, roots: string[]) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('只支持节点绝对路径。');
  const actual = await realpath(path);
  const allowed = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  if (!allowed.some((root) => {
    if (!root) return false;
    const part = relative(root, actual);
    return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  })) throw new Error('路径不在此会话可预览的工作区内。');
  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件。');
    const extension = extname(actual).toLowerCase();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extension];
    const limit = mime ? 4 * 1024 * 1024 : 256 * 1024;
    if (stat.size > limit) throw new Error(mime ? '图片超过 4 MiB。' : '文本超过 256 KiB。');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('文件超过预览大小限制。');
    const data = bytes.subarray(0, bytesRead);
    if (mime) return { mime, data: data.toString('base64'), encoding: 'base64' as const };
    if (data.includes(0)) throw new Error('不支持预览二进制文件。');
    return { mime: 'text/plain', data: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'utf8' as const };
  } finally { await file.close(); }
}
