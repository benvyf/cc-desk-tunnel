// Root/operator CLI only. The web service has public verification keys and never imports this.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../apps/update-service/src/config.ts';
import { readRegular } from '../apps/server/src/managed-server-files.ts';
import {
  AgentPackages,
  agentArchive,
  agentManifestFromArchive,
  signAgentIndex,
  verifyAgentIndex,
} from '../apps/update-service/src/agent-packages.ts';

const sourceFiles = {
  'worker.py': 'apps/update-service/web/host-worker.py',
  'runtime-support/apply.py': 'apps/update-service/web/host-runtime-support.py',
  'operations.py': 'apps/update-service/web/host-operations.py',
  'agent.py': 'apps/update-service/web/host-updater-agent.py',
  'relay-agent.py': 'apps/update-service/web/relay-agent.py',
  'relay-control.cjs': 'apps/update-service/web/relay-control.cjs',
  'server-upgrade.cjs': 'apps/update-service/web/server-upgrade.cjs',
  'base/upgrade-runtime-base.py': 'scripts/upgrade-runtime-base.py',
  'base/upgrade-message-review.py': 'scripts/upgrade-message-review.py',
  'base/install-cc-space-037.py': 'scripts/install-cc-space-037.py',
  'base/server-bootstrap.py': 'apps/update-service/web/server-bootstrap.py',
  'base/fresh-install.py': 'apps/update-service/web/fresh-install-host-base.py',
};
const config = (path) => validateConfig(JSON.parse(readRegular(resolve(path), 65536)));
export function buildArchive(root, revision = 'HEAD') {
  assert(/^(?:HEAD|[a-f0-9]{40})$/.test(revision), 'Use HEAD or a full commit');
  const commit = execFileSync('git', ['rev-parse', revision], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
  }).trim();
  assert(/^[a-f0-9]{40}$/.test(commit));
  return agentArchive(
    Object.fromEntries(
      Object.entries(sourceFiles).map(([name, path]) => [
        name,
        execFileSync('git', ['show', commit + ':' + path], {
          cwd: root,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        }),
      ]),
    ),
  );
}
function signed(payload, keyFile, keyId, keys) {
  const e = signAgentIndex(payload, keyId, readRegular(resolve(keyFile), 16384));
  verifyAgentIndex(e, keys);
  return Buffer.from(JSON.stringify(e) + '\n');
}
export function signArchive(configFile, archiveFile, keyFile, keyId, version, output) {
  const c = config(configFile),
    bytes = readRegular(resolve(archiveFile), 2 * 1024 * 1024),
    now = Date.now();
  const payload = {
    schema: 1,
    product: 'cc-host-agent',
    platform: 'linux-x64',
    version,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 14 * 86400000).toISOString(),
    ...agentManifestFromArchive(bytes),
  };
  writeFileSync(resolve(output), signed(payload, keyFile, keyId, c.trustedKeys), {
    flag: 'wx',
    mode: 0o644,
  });
  return payload;
}
export function publish(configFile, indexFile, archiveFile) {
  const c = config(configFile);
  new AgentPackages(c.dataDir, c.trustedKeys).publish(
    readRegular(resolve(indexFile), 128 * 1024),
    readRegular(resolve(archiveFile), 2 * 1024 * 1024),
  );
}
export function renew(registrationFile, force = false) {
  const r = JSON.parse(readRegular(resolve(registrationFile), 65536));
  assert.deepEqual(Object.keys(r).sort(), ['expectedArchive', 'keyFile', 'keyId', 'serviceConfig']);
  const c = config(r.serviceConfig),
    d = new AgentPackages(c.dataDir, c.trustedKeys),
    bytes = d.index();
  assert(bytes, 'No agent publication');
  const p = verifyAgentIndex(bytes, c.trustedKeys, true);
  assert.deepEqual(p.archive, r.expectedArchive, 'Agent archive differs from renewal registration');
  if (!force && Date.parse(p.expiresAt) - Date.now() > 2 * 86400000) return 'not-due';
  const now = Date.now(),
    next = {
      ...p,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 14 * 86400000).toISOString(),
    };
  d.publish(signed(next, r.keyFile, r.keyId, c.trustedKeys), d.artifact(d.path(p.archive.sha256)));
  return 'renewed';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'build' && args.length === 2)
      writeFileSync(resolve(args[1]), buildArchive(resolve(args[0])).bytes, {
        flag: 'wx',
        mode: 0o644,
      });
    else if (action === 'sign' && args.length === 6)
      signArchive(args[0], args[1], args[2], args[3], Number(args[4]), args[5]);
    else if (action === 'publish' && args.length === 3) publish(...args);
    else if (
      action === 'renew' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--force'))
    )
      console.log(renew(args[0], args[1] === '--force'));
    else
      throw Error(
        'Usage: build REPO ARCHIVE | sign SERVICE_CONFIG ARCHIVE KEY KEY_ID VERSION OUTPUT | publish SERVICE_CONFIG INDEX ARCHIVE | renew REGISTRATION [--force]',
      );
  } catch {
    console.error(
      'Host agent publication failed; check exact registration, signatures and paths. No private details printed.',
    );
    process.exitCode = 1;
  }
}
