import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PermissionSource } from '@cc-desk-tunnel/protocol';

// The permission rules of the Claude Code settings files the CLI reads on this server, for a read-only view in the
// settings page. Only `permissions` is taken from a file, and only its rule lists, default mode and extra
// directories, each copied field by field: `env`, `apiKeyHelper` and every other key never leave this module.
// Files are opened read only; nothing is created, written or renamed.

const FILE_LIMIT = 2 * 1024 * 1024;
const RULE_LIMIT = 500;
const RULE_LENGTH = 2000;
// Bytes of the rules as JSON, over all files: a frame within the protocol's 256 KB with room to spare.
const TOTAL_LIMIT = 150 * 1024;
const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);

type Scope = PermissionSource['scope'];
export type PermissionPaths = { scope: Scope; path: string }[];

// Where the CLI looks, as it is started for a session: its configuration directory resolved against the session's
// working directory with the environment it is given (claude.ts), the session's project and local settings in that
// directory, the --settings file, and the managed settings. Without a session, the project and local are not known.
export function permissionPaths(
  options: { settingsPath?: string; environment?: Record<string, string> },
  cwd: string | undefined,
  platform = process.platform,
): PermissionPaths {
  const environment = { ...process.env, ...options.environment };
  const config = resolve(
    cwd ?? homedir(),
    environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  );
  return [
    { scope: 'user', path: join(config, 'settings.json') },
    ...(cwd
      ? [
          { scope: 'project' as const, path: join(cwd, '.claude', 'settings.json') },
          { scope: 'local' as const, path: join(cwd, '.claude', 'settings.local.json') },
        ]
      : []),
    ...(options.settingsPath ? [{ scope: 'flag' as const, path: options.settingsPath }] : []),
    ...(platform === 'linux'
      ? [{ scope: 'managed' as const, path: '/etc/claude-code/managed-settings.json' }]
      : []),
  ];
}

// The strings of a list, as written: not trimmed, not deduplicated, within the limits.
function strings(value: unknown, budget: { left: number }) {
  if (!Array.isArray(value)) return { list: [] as string[], cut: false };
  const list: string[] = [];
  let cut = false;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    // Counted as sent: JSON's escapes and UTF-8's bytes.
    const size = Buffer.byteLength(JSON.stringify(item));
    if (list.length >= RULE_LIMIT || item.length > RULE_LENGTH || size > budget.left) {
      cut = true;
      continue;
    }
    budget.left -= size;
    list.push(item);
  }
  return { list, cut };
}

// The fields shown, built anew from what the file says: nothing of the file is passed on whole.
export function projectPermissions(value: unknown, budget = { left: TOTAL_LIMIT }) {
  const permissions =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).permissions
      : undefined;
  const source =
    permissions && typeof permissions === 'object' && !Array.isArray(permissions)
      ? (permissions as Record<string, unknown>)
      : {};
  const allow = strings(source.allow, budget);
  const deny = strings(source.deny, budget);
  const ask = strings(source.ask, budget);
  const directories = strings(source.additionalDirectories, budget);
  const mode =
    typeof source.defaultMode === 'string' && MODES.has(source.defaultMode)
      ? source.defaultMode
      : undefined;
  return {
    allow: allow.list,
    deny: deny.list,
    ask: ask.list,
    ...(directories.list.length ? { additionalDirectories: directories.list } : {}),
    ...(mode ? { defaultMode: mode } : {}),
    ...(allow.cut || deny.cut || ask.cut || directories.cut ? { truncated: true as const } : {}),
  };
}

const empty = { allow: [], deny: [], ask: [] };

// One file, read through one descriptor: its kind and size are of the file read, not of a name that may change in
// between. A pipe or device does not hold the read up. What a file could not be read as is told by a status alone,
// never with a parser's message, which would quote the file.
export async function readPermissionSource(
  scope: Scope,
  path: string,
  budget = { left: TOTAL_LIMIT },
): Promise<PermissionSource> {
  const base = { scope, path };
  const link = await lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );
  const marked = link ? { symlink: true as const } : {};
  let handle;
  try {
    // A terminal it may lead to never becomes the service's controlling terminal.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ...base,
      ...marked,
      ...empty,
      status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable',
    };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ...base, ...marked, ...empty, status: 'not_file' };
    if (info.size > FILE_LIMIT) return { ...base, ...marked, ...empty, status: 'too_large' };
    const buffer = Buffer.alloc(Math.min(info.size, FILE_LIMIT) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_LIMIT) return { ...base, ...marked, ...empty, status: 'too_large' };
    const text = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
    let value: unknown;
    try {
      // An empty file is no settings, as the CLI takes it.
      value = text.trim() ? JSON.parse(text) : {};
    } catch {
      return { ...base, ...marked, ...empty, status: 'invalid_json' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { ...base, ...marked, ...empty, status: 'invalid_json' };
    return { ...base, ...marked, status: 'ok', ...projectPermissions(value, budget) };
  } catch {
    return { ...base, ...marked, ...empty, status: 'unreadable' };
  } finally {
    await handle.close();
  }
}

export async function readPermissions(paths: PermissionPaths) {
  const budget = { left: TOTAL_LIMIT };
  const sources: PermissionSource[] = [];
  for (const { scope, path } of paths)
    sources.push(await readPermissionSource(scope, path, budget));
  return sources;
}
