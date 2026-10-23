import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerOptions } from './server.ts';
import { moderationConfig } from './moderation.ts';

function port(value: string | undefined, fallback: number, name: string) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Invalid ${name}`);
  return number;
}

// The proxy's own settings must not leak into the native CLI or its shells: they inherit this process environment.
// FRPS_* is what deployments made before 0.2.10 still carry in their configuration; nothing reads it any more.
export function clearServiceVariables(env: NodeJS.ProcessEnv) {
  for (const name of Object.keys(env))
    if (
      /^(PROXY_|FRPS_)/.test(name) ||
      [
        'CLAUDE_PATH',
        'CLAUDE_MODEL',
        'CLAUDE_SETTINGS_PATH',
        'CLAUDE_CONTEXT_RETENTION_DAYS',
      ].includes(name)
    )
      delete env[name];
}

export function environmentConfig(env: NodeJS.ProcessEnv, defaultDataDir: string) {
  const native = env.PROXY_ADAPTER === 'claude-code';
  const reverseProxy = env.PROXY_TLS_MODE === 'reverse-proxy';
  if (env.PROXY_TLS_MODE && !['direct', 'reverse-proxy'].includes(env.PROXY_TLS_MODE))
    throw new Error('PROXY_TLS_MODE must be direct or reverse-proxy.');
  const retention = Number(env.CLAUDE_CONTEXT_RETENTION_DAYS ?? 3650);
  if (!Number.isInteger(retention) || retention < 1)
    throw new Error('Invalid CLAUDE_CONTEXT_RETENTION_DAYS');
  const maxRuns = env.PROXY_MAX_RUNS ? Number(env.PROXY_MAX_RUNS) : undefined;
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1))
    throw new Error('Invalid PROXY_MAX_RUNS');
  const grace = env.PROXY_GRACE_SECONDS ? Number(env.PROXY_GRACE_SECONDS) : undefined;
  if (grace !== undefined && (!Number.isInteger(grace) || grace < 0 || grace > 3600))
    throw new Error('Invalid PROXY_GRACE_SECONDS');
  if (native && !reverseProxy && (!env.PROXY_TLS_CERT || !env.PROXY_TLS_KEY))
    throw new Error('Direct mode requires PROXY_TLS_CERT and PROXY_TLS_KEY.');
  const options: ServerOptions = {
    token: env.PROXY_TOKEN ?? '',
    moderation: env.PROXY_MODERATION_CONFIG
      ? moderationConfig(JSON.parse(readFileSync(env.PROXY_MODERATION_CONFIG, 'utf8')))
      : undefined,
    dataDir: resolve(env.PROXY_DATA_DIR ?? defaultDataDir),
    host: env.PROXY_HOST ?? (native && !reverseProxy ? '0.0.0.0' : '127.0.0.1'),
    reverseProxy,
    tls:
      native && !reverseProxy
        ? {
            cert: readFileSync(env.PROXY_TLS_CERT!),
            key: readFileSync(env.PROXY_TLS_KEY!),
          }
        : undefined,
    tunnel: native ? {} : undefined,
    maxRuns,
    graceMs: grace === undefined ? undefined : grace * 1000,
    allowedOrigins: env.PROXY_ORIGINS?.split(','),
    claude: native
      ? {
          executable: env.CLAUDE_PATH ?? 'claude',
          model: env.CLAUDE_MODEL,
          settingsPath: env.CLAUDE_SETTINGS_PATH,
          contextRetentionDays: retention,
        }
      : undefined,
  };
  // Custom builds are deployed by the administrator; legacy release settings are ignored.
  return { options, native, port: port(env.PROXY_PORT, 8787, 'PROXY_PORT') };
}
