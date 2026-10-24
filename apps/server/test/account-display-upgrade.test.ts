import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDescriptor,
  compatibility,
  COMPATIBILITY_PATHS,
  RUNTIME_LEVEL,
  sha256,
  signServerIndex,
  type ServerPayload,
} from '../../../packages/managed-server/src/index.ts';
import { ManagedServerSupervisor } from '../src/managed-server-supervisor.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('account display changes retain the reviewed Build 2 baseline and admit a managed program update', async (t) => {
  const reviewed = JSON.parse(
    readFileSync(
      new URL('fixtures/account-display-upgrade-baseline.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(compatibility(root), reviewed.compatibility);
  assert.equal(sha256(readFileSync(join(root, 'package-lock.json'))), reviewed.packageLockSha256);
  const profile = JSON.parse(
    readFileSync(join(root, 'deploy/server-bootstrap-profile.json'), 'utf8'),
  );
  for (const file of ['apps/server/src/native-account.ts', 'packages/protocol/src/index.ts'])
    assert.equal(sha256(readFileSync(join(root, file))), profile.files[file]);
  const scratch = mkdtempSync(join(tmpdir(), 'cc-account-upgrade-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const baseline = join(scratch, 'baseline');
  for (const file of [
    ...COMPATIBILITY_PATHS,
    'package.json',
    'package-lock.json',
    'packages/protocol/package.json',
    'apps/server/src/managed-main.ts',
  ]) {
    const target = join(baseline, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  const descriptor = buildDescriptor(baseline, {
    build: 2,
    protocol: 20,
    appVersion: '0.3.6',
    sourceCommit: reviewed.sourceCommit,
  });
  writeFileSync(join(baseline, 'SERVER-RELEASE.json'), JSON.stringify(descriptor));
  const keys = generateKeyPairSync('ed25519');
  const payload: ServerPayload = {
    schema: 1,
    product: 'cc-desk-tunnel-managed-server',
    channel: 'pilot',
    platform: 'linux',
    arch: 'x64',
    revision: 3,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    release: {
      build: 3,
      protocol: 20,
      appVersion: '0.3.6',
      sourceCommit: 'b'.repeat(40),
      size: 1024,
      sha256: 'c'.repeat(64),
      descriptorSha256: 'd'.repeat(64),
      packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))),
      runtimeLevel: RUNTIME_LEVEL,
      compatibility: compatibility(root),
    },
  };
  const envelope = signServerIndex(payload, 'test', keys.privateKey);
  const stateRoot = join(scratch, 'state');
  mkdirSync(stateRoot);
  const supervisor = new ManagedServerSupervisor({
    root: baseline,
    stateRoot,
    dataDirectories: [],
    keys: { test: keys.publicKey },
    runtimeCheck: () => true,
    launch: async () => {
      throw new Error('This check must not launch a process');
    },
    download: async () => Buffer.from(JSON.stringify(envelope)),
  });
  const result = await supervisor.check(20);
  assert.equal(result.compatible, true);
  assert.equal(result.reason, 'available');
});
