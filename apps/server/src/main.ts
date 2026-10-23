import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from './server.ts';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { clearServiceVariables, environmentConfig } from './config.ts';
import { removeFrpLeftovers } from './legacy.ts';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import {
  compatibility,
  parseDescriptor,
  sha256,
} from '../../../packages/managed-server/src/index.ts';
import { connectManagedSupervisor } from './managed-server-child.ts';
import type { ReadyProof } from './managed-server-supervisor.ts';

const { options, native, port } = environmentConfig(
  process.env,
  fileURLToPath(new URL('../../../.local/sessions', import.meta.url)),
);
const programDir = process.env.PROXY_PROGRAM_DIR;
const nonce = process.env.CC_MANAGED_NONCE ?? '';
const supervised =
  process.env.CC_MANAGED_SUPERVISED === '1' ? connectManagedSupervisor(nonce) : undefined;
const root = fileURLToPath(new URL('../../../', import.meta.url));
let readiness: ReadyProof | undefined;
if (supervised) {
  const descriptor = join(root, 'SERVER-RELEASE.json');
  const build = existsSync(descriptor) ? parseDescriptor(readFileSync(descriptor)).build : 1;
  readiness = {
    nonce,
    build,
    protocol: PROTOCOL_VERSION,
    releaseHash: process.env.CC_MANAGED_RELEASE_HASH ?? '',
    policyHash: sha256(JSON.stringify(compatibility(root))),
    openedStore: true,
    effectivePolicy:
      process.env.CC_MANAGED_POLICY_ENFORCED === '1'
        ? true
        : (() => {
            throw new Error('Managed policy was not enforced');
          })(),
  };
  options.managed = {
    backend: supervised.backend,
    initialMaintenance: true,
    nonce,
    readiness: () => readiness,
  };
}
for (const key of Object.keys(process.env))
  if (key.startsWith('CC_MANAGED_')) delete process.env[key];
if (native) removeFrpLeftovers();
clearServiceVariables(process.env);
// What a process that did not get to close left of its connections and of the doors of their devices.
if (native)
  for (const name of ['connections', 'devices'])
    rmSync(join(options.dataDir, name), { recursive: true, force: true });
const server = createProxyServer(options);
console.log(`Proxy ${native ? 'native' : 'simulation'} service: ${await server.listen(port)}`);
if (supervised && readiness) {
  // A real query proves the expected store opened; /health alone is never a commit signal.
  server.store.database.prepare('SELECT 1').get();
  supervised.onCommit(() => server.managedMaintenance!.release());
  supervised.onCancel(() => server.managedMaintenance!.release());
  supervised.ready(readiness);
}
// The entry script counts starts of an upgraded program and gives up on it after three that did not get here.
if (programDir) rmSync(join(programDir, 'attempts'), { force: true });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
  if (supervised) {
    process.disconnect?.();
    process.exitCode = 0;
  }
}
supervised?.onStop(() => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
