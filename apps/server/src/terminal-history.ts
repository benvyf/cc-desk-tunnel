import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ClaudeOptions } from './claude.ts';

// Metadata only: no SDK query, subprocess, credential file or global history scan.
// Inputs are the config directory already selected for the PTY and its known cwd.
export function terminalHistoryContext(options: ClaudeOptions, environment: Record<string, string>) {
  const config = resolve(environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const key = createHash('sha256').update(JSON.stringify([config, options.executable, options.settingsPath ?? null])).digest('hex');
  return { config, key };
}
export function terminalHistoryPath(config: string, cwd: string, nativeId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(nativeId)) throw new Error('官方历史 ID 无效。');
  const project = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  // CLI uses a hashed suffix for very long paths. Do not guess or scan other roots.
  if (project.length > 200) throw new Error('此 CLI 长路径历史格式暂不支持，请使用官方历史选择器。');
  return join(config, 'projects', project, `${nativeId}.jsonl`);
}
export async function readTerminalHistory(config: string, cwd: string, nativeId: string) {
  const path = terminalHistoryPath(config, cwd, nativeId);
  let file;
  try {
    const actual = await realpath(path);
    const expected = join(await realpath(join(config, 'projects')), basename(dirname(path)), basename(path));
    if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) return null;
    file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size) return null;
    const bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n')) {
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.type !== 'user' || value.sessionId !== nativeId || value.isMeta || value.isSidechain) continue;
      const content = value.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join(' ') : '';
      return { title: text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) || '官方终端历史', updatedAt: stat.mtime.toISOString() };
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { await file?.close(); }
}
