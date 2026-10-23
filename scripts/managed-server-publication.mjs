import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../apps/update-service/src/config.ts';
import {
  ServerDistribution,
  releaseFromArchive,
  renewalPayload,
} from '../apps/update-service/src/server-distribution.ts';
import { signServerIndex, verifyServerIndex } from '../packages/managed-server/src/index.ts';
import { readRegular } from '../apps/server/src/managed-server-files.ts';

function config(path) {
  return validateConfig(JSON.parse(readRegular(resolve(path), 65536)));
}
function signed(payload, keyFile, keyId, trustedKeys) {
  const envelope = signServerIndex(payload, keyId, readRegular(resolve(keyFile), 16384));
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
  verifyServerIndex(bytes, { keys: trustedKeys });
  return bytes;
}
export function publish(configFile, indexFile, archiveFile) {
  const c = config(configFile);
  new ServerDistribution(c.dataDir, c.trustedKeys).publish(
    readRegular(resolve(indexFile), 128 * 1024),
    readRegular(resolve(archiveFile), 64 * 1024 * 1024),
  );
}
export function renew(configFile, force = false) {
  const c = JSON.parse(readRegular(resolve(configFile), 65536));
  assert.deepEqual(Object.keys(c).sort(), ['expectedRelease', 'keyFile', 'keyId', 'serviceConfig']);
  const service = config(c.serviceConfig);
  const d = new ServerDistribution(service.dataDir, service.trustedKeys);
  const bytes = d.index();
  assert(bytes, 'No Linux release is registered');
  const current = verifyServerIndex(bytes, { keys: service.trustedKeys, installed: true });
  assert(Date.parse(current.payload.issuedAt) <= Date.now() + 60000, 'Future Linux index');
  const next = renewalPayload(current.payload, c.expectedRelease, Date.now(), force);
  if (!next) return 'not-due';
  const archive = d.artifact(d.path(next.release));
  assert(archive, 'Registered archive missing');
  d.publish(signed(next, c.keyFile, c.keyId, service.trustedKeys), archive);
  return 'renewed';
}
export function signArchive(configFile, archiveFile, keyFile, keyId, revision, output) {
  const c = config(configFile),
    archive = readRegular(resolve(archiveFile), 64 * 1024 * 1024);
  const release = releaseFromArchive(archive),
    now = Date.now();
  const payload = {
    schema: 1,
    product: 'cc-desk-tunnel-managed-server',
    channel: 'pilot',
    platform: 'linux',
    arch: 'x64',
    revision,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 14 * 86400000).toISOString(),
    release,
  };
  writeFileSync(resolve(output), signed(payload, keyFile, keyId, c.trustedKeys), {
    flag: 'wx',
    mode: 0o644,
  });
  return release;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2);
    if (action === 'publish' && args.length === 3) {
      publish(...args);
      console.log('Signed Linux release published. Windows stores unchanged.');
    } else if (
      action === 'renew' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--force'))
    )
      console.log(renew(args[0], args[1] === '--force'));
    else if (action === 'sign' && args.length === 6) {
      const r = signArchive(args[0], args[1], args[2], args[3], Number(args[4]), args[5]);
      console.log(`Signed Linux Build ${r.build}, SHA256 ${r.sha256}`);
    } else
      throw Error(
        'Usage: publish SERVICE_CONFIG INDEX ARCHIVE | sign SERVICE_CONFIG ARCHIVE PRIVATE_KEY KEY_ID REVISION OUTPUT | renew RENEW_CONFIG [--force]',
      );
  } catch {
    console.error(
      'Linux publication failed; check exact release registration, signatures, paths and permissions. No private details printed.',
    );
    process.exitCode = 1;
  }
}
