import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { ClaudeOptions } from './claude.ts';

// Metadata only: no SDK query, subprocess, credential file or global history scan.
// Inputs are the config directory already selected for the PTY and its known cwd.
export function terminalHistoryContext(
  options: ClaudeOptions,
  environment: Record<string, string>,
  cwd: string,
) {
  const config = resolve(cwd, environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const key = createHash('sha256')
    .update(JSON.stringify([config, options.executable, options.settingsPath ?? null]))
    .digest('hex');
  return { config, key };
}
export function terminalHistoryPath(config: string, cwd: string, nativeId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nativeId))
    throw new Error('官方历史 ID 无效。');
  const project = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  // CLI uses a hashed suffix for very long paths. Do not guess or scan other roots.
  if (project.length > 200)
    throw new Error('此 CLI 长路径历史格式暂不支持，请使用官方历史选择器。');
  return join(config, 'projects', project, `${nativeId}.jsonl`);
}
async function openTerminalHistory(config: string, cwd: string, nativeId: string) {
  const path = terminalHistoryPath(config, cwd, nativeId);
  let file;
  try {
    const actual = await realpath(path);
    const expected = join(
      await realpath(join(config, 'projects')),
      basename(dirname(path)),
      basename(path),
    );
    if (
      process.platform === 'win32'
        ? actual.toLowerCase() !== expected.toLowerCase()
        : actual !== expected
    )
      return null;
    file = await open(
      actual,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function readTerminalMessages(config: string, cwd: string, nativeId: string) {
  return new TerminalHistoryReader(config, cwd, nativeId).read({ final: true });
}

// Cache raw records, not a second implementation of the CLI's parent/compaction chain.
// Reads are bounded chunks; the SDK selects the effective main chain from the cached snapshot.
export class TerminalHistoryReader {
  readonly path: string;
  private entries: SessionStoreEntry[] = [];
  private offset = 0;
  private tail = Buffer.alloc(0);
  private line = 0;
  private eofLine = false;
  private identity?: string;
  private modified?: number;
  private result?: Awaited<ReturnType<typeof getSessionMessages>>;
  private config: string;
  private cwd: string;
  private nativeId: string;
  constructor(config: string, cwd: string, nativeId: string) {
    this.config = config;
    this.cwd = cwd;
    this.nativeId = nativeId;
    this.path = terminalHistoryPath(config, cwd, nativeId);
  }
  async read({ final = false, reconcile = false } = {}) {
    const file = await openTerminalHistory(this.config, this.cwd, this.nativeId);
    if (!file) {
      // A replaced or removed file must not masquerade as the old cached chain.
      this.reset();
      return [];
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new Error(`Terminal transcript is not a regular file: ${this.path}`);
      const identity = `${stat.dev}:${stat.ino}`;
      if (
        !final &&
        !reconcile &&
        identity === this.identity &&
        stat.size === this.offset &&
        stat.mtimeMs === this.modified &&
        this.result
      )
        return this.result;
      if (
        reconcile ||
        (this.identity !== undefined &&
          (identity !== this.identity ||
            stat.size < this.offset ||
            (stat.size === this.offset && stat.mtimeMs !== this.modified)))
      )
        this.reset();
      this.identity = identity;
      // Capture the limit on the same descriptor used to read the initial snapshot.
      const limit = final || reconcile ? stat.size : Math.min(stat.size, this.offset + 1024 * 1024);
      while (this.offset < limit) {
        const chunk = Buffer.alloc(Math.min(256 * 1024, limit - this.offset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, this.offset);
        if (!bytesRead) throw new Error(`Terminal transcript changed while reading: ${this.path}`);
        this.offset += bytesRead;
        let bytes = chunk.subarray(0, bytesRead);
        if (this.eofLine) {
          if (bytes[0] !== 10)
            throw new Error(`Invalid terminal transcript after line ${this.line}: ${this.path}`);
          bytes = bytes.subarray(1);
          this.eofLine = false;
        }
        const buffer = Buffer.concat([this.tail, bytes]);
        const end = buffer.lastIndexOf(10) + 1;
        this.tail = Buffer.from(buffer.subarray(end));
        if (end)
          for (const line of buffer.subarray(0, end).toString('utf8').split('\n').slice(0, -1))
            this.accept(line);
      }
      this.modified = stat.mtimeMs;
      if (final && this.tail.length) {
        this.accept(this.tail.toString('utf8'));
        this.tail = Buffer.alloc(0);
        this.eofLine = true;
      }
    } finally {
      await file.close();
    }
    const messages = await getSessionMessages(this.nativeId, {
      dir: this.cwd,
      includeSystemMessages: true,
      sessionStore: {
        async append() {
          throw new Error('Terminal history reader is read-only');
        },
        load: async () => this.entries,
      },
    });
    // The SDK preserves summaries, but their raw parent boundary carries the compression metadata.
    const raw = new Map(
      this.entries.map((entry) => [String(entry.uuid), entry as Record<string, unknown>]),
    );
    const selected = new Set(messages.map((message) => message.uuid));
    const normalized: typeof messages = [];
    for (const message of messages) {
      const entry = raw.get(message.uuid);
      // SDK 0.3.286 selects these system records but drops their content. Normalize only
      // the selected local commands, keeping the SDK's chain selection and UUIDs.
      if (
        entry?.type === 'system' &&
        entry.subtype === 'local_command' &&
        typeof entry.content === 'string'
      ) {
        Object.assign(message, { type: 'user', message: { role: 'user', content: entry.content } });
      }
      if (entry?.isCompactSummary) {
        const boundary = raw.get(String(entry.parentUuid));
        Object.assign(message, { compact: boundary?.compactMetadata });
        // Fast /compact may finish between polls. The SDK then drops the pre-boundary
        // chain, including the actual typed question, and keeps only a repeated command
        // after the summary. Recover that last human question only for the selected
        // manual boundary. Do not replay any other pre-boundary messages.
        if ((boundary?.compactMetadata as { trigger?: string } | undefined)?.trigger === 'manual') {
          const index = this.entries.findIndex((row) => row.uuid === entry.parentUuid);
          for (let i = index - 1; i >= 0; i--) {
            const row = this.entries[i] as Record<string, unknown>;
            if (row.type === 'system' && row.subtype === 'compact_boundary') break;
            if (!['user', 'assistant'].includes(String(row.type)) || row.isMeta || row.isSidechain)
              continue;
            const content = (row.message as { content?: unknown } | undefined)?.content;
            const origin = (row.origin as { kind?: unknown } | undefined)?.kind;
            if (
              row.type === 'user' &&
              (!origin || origin === 'human') &&
              typeof content === 'string' &&
              /^\/compact(?:\s|$)/.test(content) &&
              typeof row.uuid === 'string' &&
              !selected.has(row.uuid)
            )
              normalized.push({
                type: 'user',
                uuid: row.uuid,
                session_id: this.nativeId,
                parent_tool_use_id: null,
                message: row.message,
                timestamp: row.timestamp,
              } as unknown as typeof message);
            break;
          }
        }
      }
      normalized.push(message);
    }
    this.result = normalized;
    return normalized;
  }
  private reset() {
    this.entries = [];
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.line = 0;
    this.eofLine = false;
    this.identity = undefined;
    this.modified = undefined;
    this.result = undefined;
  }
  private accept(line: string) {
    this.line++;
    if (!line.trim()) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid terminal transcript at line ${this.line}: ${this.path}`);
    }
    if (value && typeof value === 'object' && typeof value.type === 'string')
      this.entries.push(value);
  }
}
// Read persistence metadata independently of the bounded title preview. Callers must first validate messages.
export async function readTerminalContext(config: string, cwd: string, nativeId: string) {
  const file = await openTerminalHistory(config, cwd, nativeId);
  if (!file) return null;
  try {
    const stat = await file.stat();
    return stat.isFile() && stat.size ? { updatedAt: stat.mtime.toISOString() } : null;
  } finally {
    await file.close();
  }
}

export async function readTerminalHistory(config: string, cwd: string, nativeId: string) {
  const file = await openTerminalHistory(config, cwd, nativeId);
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size) return null;
    const bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n')) {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !value ||
        typeof value !== 'object' ||
        value.type !== 'user' ||
        value.sessionId !== nativeId ||
        value.isMeta ||
        value.isSidechain
      )
        continue;
      const content = value.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join(' ')
            : '';
      return {
        title: text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) || '官方终端历史',
        updatedAt: stat.mtime.toISOString(),
      };
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await file?.close();
  }
}
