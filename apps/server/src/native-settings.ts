import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeSettingsSchema } from '@cc-desk-tunnel/protocol';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';

// The official CLI's user settings file. The proxy edits only the keys in the protocol schema and keeps every
// other key as it found it; a new CLI process reads the file when it starts, so changes apply from the next run.
export function settingsPath(configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  return join(configDirectory ?? join(homedir(), '.claude'), 'settings.json');
}

// Settings the CLI takes as environment variables, which the file holds under `env` as text.
const variables: Partial<Record<keyof NativeSettings, string>> = {
  toolSearch: 'ENABLE_TOOL_SEARCH',
};
const environment = (file: Record<string, unknown>) =>
  file.env && typeof file.env === 'object' && !Array.isArray(file.env)
    ? (file.env as Record<string, unknown>)
    : {};

function readFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings file is not an object');
  return value;
}

export function readNativeSettings(path = settingsPath()): NativeSettings {
  const file = readFile(path);
  // A value the schema does not accept was written by hand; it is shown as unset and left alone until changed here.
  return Object.fromEntries(
    Object.entries(nativeSettingsSchema.shape).map(([key, schema]) => {
      const variable = variables[key as keyof NativeSettings];
      if (variable) {
        const text = environment(file)[variable];
        return [key, text === 'true' ? true : text === 'false' ? false : null];
      }
      const parsed = schema.safeParse(file[key] ?? null);
      return [key, parsed.success ? parsed.data : null];
    }),
  ) as NativeSettings;
}

// CLI 2.1.295: explicit --settings wins over local, project and selected user settings.
// The terminal's generated settings retain the provider's explicit values.
function cliSettingPaths(config: string, cwd: string, explicit?: string) {
  return [
    settingsPath(config),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
    ...(explicit ? [explicit] : []),
    ...(process.platform === 'linux' ? ['/etc/claude-code/managed-settings.json'] : []),
  ];
}

export function terminalCompactWindow(config: string, cwd: string, explicit: string) {
  let window: number | null = null;
  for (const path of cliSettingPaths(config, cwd, explicit)) {
    try {
      const values = readFile(path);
      // The CLI discards an invalid key at its source, so it cannot shadow a valid lower-priority value.
      const parsed = nativeSettingsSchema.shape.autoCompactWindow.safeParse(
        values.autoCompactWindow,
      );
      if (parsed.success && parsed.data !== null) window = parsed.data;
    } catch (error) {
      // Context sampling must not make a recoverable settings issue stop a terminal.
      // Do not log parser messages: they can quote provider configuration bytes.
      console.warn('Terminal context settings could not be read', {
        path,
        code:
          error instanceof SyntaxError
            ? 'invalid_json'
            : ((error as NodeJS.ErrnoException).code ?? 'unreadable'),
      });
    }
  }
  return window;
}

// The CLI applies settings.env after the inherited process environment. Put the
// session PATH in its private explicit settings as well, retaining all provider keys.
export function writeSessionSshSettings(
  path: string,
  options: {
    source?: string;
    config: string;
    cwd: string;
    bin: string;
    inheritedPath: string;
  },
) {
  let settings: Record<string, unknown>;
  try {
    settings = options.source ? readFile(options.source) : {};
  } catch (error) {
    const code =
      error instanceof SyntaxError
        ? 'invalid_json'
        : ((error as NodeJS.ErrnoException).code ?? 'unreadable');
    throw new Error(`CLI session settings could not be read (${code}): ${options.source}`);
  }
  if (Object.values(environment(settings)).some((value) => typeof value !== 'string'))
    throw new Error(`CLI session env values must be strings: ${options.source}`);
  let base = options.inheritedPath;
  for (const file of cliSettingPaths(options.config, options.cwd, options.source)) {
    let values;
    try {
      values = file === options.source ? settings : readFile(file);
    } catch (error) {
      // The CLI also ignores malformed optional setting files; the provider file above is required.
      console.warn('Session SSH PATH settings could not be read', {
        path: file,
        code:
          error instanceof SyntaxError
            ? 'invalid_json'
            : ((error as NodeJS.ErrnoException).code ?? 'unreadable'),
      });
      continue;
    }
    const value = environment(values).PATH;
    if (typeof value !== 'string') continue;
    if (file === '/etc/claude-code/managed-settings.json') {
      // Keep the administrator's PATH and use explicit ssh -F guidance instead.
      console.warn('Session SSH uses explicit configuration because PATH is managed');
      return undefined;
    }
    base = value;
  }
  const scoped = `${options.bin}:${base}`;
  writeFileSync(
    path,
    JSON.stringify({ ...settings, env: { ...environment(settings), PATH: scoped } }),
    { mode: 0o600 },
  );
  return scoped;
}

export function updateNativeSettings(values: Partial<NativeSettings>, path = settingsPath()) {
  const file = readFile(path);
  for (const [key, value] of Object.entries(values)) {
    const variable = variables[key as keyof NativeSettings];
    if (variable) {
      if (value === undefined) continue;
      const env = { ...environment(file) };
      if (value === null) delete env[variable];
      else env[variable] = String(value);
      if (Object.keys(env).length) file.env = env;
      else delete file.env;
      continue;
    }
    if (value === null) delete file[key];
    else if (value !== undefined) file[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.proxy`, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.proxy`, path);
  return readNativeSettings(path);
}
