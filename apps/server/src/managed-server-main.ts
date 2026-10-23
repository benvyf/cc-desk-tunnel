// Immutable image supervisor. It owns environment precedence, policy checks, child launch and journal.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { requireValue } from '../../../packages/managed-server/src/index.ts';
import { environmentConfig } from './config.ts';
import { serviceVersion } from './updates.ts';
import { ManagedServerSupervisor } from './managed-server-supervisor.ts';
import { forkProgram } from './managed-server-process.ts';
import type { ManagedBackend } from './managed-server-http.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const identity = JSON.parse(readFileSync(join(root, 'deploy/managed-server.json'), 'utf8'));
requireValue(
  identity.product === 'cc-desk-tunnel-managed-server' &&
    identity.build === 1 &&
    identity.channel === 'pilot' &&
    identity.origin === 'https://api.ghostapi.org',
  'Invalid immutable managed server identity',
);
const { options, port } = environmentConfig(process.env, join(root, '.local/sessions'));
const env: NodeJS.ProcessEnv = { ...process.env, PROXY_DATA_DIR: options.dataDir };
// process.env already contains Node's exact environment > env-file merge. Children receive this snapshot;
// rereading service.env on restart would silently alter the administrator's effective configuration.
let supervisor: ManagedServerSupervisor;
const backend: ManagedBackend = {
  check: (protocol) => supervisor.check(protocol),
  status: () => supervisor.status(),
  prepare: (confirmation) => supervisor.prepare(confirmation),
  activate: () => {
    void supervisor.activate().catch(() => {
      console.error('Managed upgrade failed; administrator attention required.');
      process.exitCode = 1;
    });
  },
};
supervisor = new ManagedServerSupervisor({
  root,
  stateRoot: '/data/managed-server',
  dataDirectories: [
    '/data/config',
    options.dataDir,
    resolve(env.HOME ?? '/data/home'),
    resolve(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? '/data/home', '.claude')),
  ],
  onUnexpectedExit: () => {
    console.error(
      'Business server exited unexpectedly; exiting container to reap all native processes. Docker restart policy must restart this container; repeated crashes require administrator attention.',
    );
    process.exit(1);
  },
  keys: identity.keys,
  baselineCurrent: {
    build: 1,
    protocol: PROTOCOL_VERSION,
    appVersion: serviceVersion(),
    sha256: null,
  },
  runtimeCheck: () => {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'x64' ||
      process.versions.node.split('.')[0] !== '24' ||
      readFileSync('/opt/runtime/level', 'utf8').trim() !== '1'
    )
      return false;
    return [
      '/opt/runtime/level',
      '/opt/runtime/node/bin/node',
      '/opt/runtime/cli/bin/claude',
    ].every((path) => {
      const stat = statSync(path);
      return stat.uid === 0 && !(stat.mode & 0o022) && stat.isFile();
    });
  },
  launch: (launch) =>
    forkProgram(
      launch,
      {
        env,
        cwd: process.cwd(),
        port,
        tls: Boolean(options.tls),
        loader: join(root, 'apps/server/src/managed-server-loader.mjs'),
      },
      backend,
    ),
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await supervisor.stop();
};
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
try {
  await supervisor.start();
} catch {
  await stop();
  console.error('Managed server startup failed; no unverified program was launched.');
  process.exitCode = 1;
}
