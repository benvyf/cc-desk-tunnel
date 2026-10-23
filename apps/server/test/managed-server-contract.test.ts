import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as contract from '../../../packages/managed-server/src/index.ts';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-10-24T00:00:00.000Z');
export function payload() {
  return {
    schema: 1,
    product: 'cc-desk-tunnel-managed-server',
    channel: 'pilot',
    platform: 'linux',
    arch: 'x64',
    revision: 2,
    issuedAt: '2026-10-24T00:00:00.000Z',
    expiresAt: '2026-10-25T00:00:00.000Z',
    release: {
      build: 2,
      appVersion: '0.2.11',
      protocol: 42,
      sourceCommit: 'a'.repeat(40),
      size: 1024,
      sha256: 'b'.repeat(64),
      descriptorSha256: 'c'.repeat(64),
      packageLockSha256: 'd'.repeat(64),
      runtimeLevel: 'node24-cli2.1.295-v1',
      compatibility: Object.fromEntries(
        contract.COMPATIBILITY_PATHS.map((p) => [p, 'e'.repeat(64)]),
      ),
    },
  } as contract.ServerPayload;
}
test('signed Linux contract strictly authenticates payload, expiration and replay floor', () => {
  assert.equal(typeof contract.signServerIndex, 'function');
  const envelope = contract.signServerIndex(payload(), 'test', keys.privateKey);
  const verified = contract.verifyServerIndex(JSON.stringify(envelope), {
    keys: { test: keys.publicKey },
    now,
  });
  assert.equal(verified.payload.release.protocol, 42);
  assert.throws(() =>
    contract.verifyServerIndex(JSON.stringify({ ...envelope, extra: true }), {
      keys: { test: keys.publicKey },
      now,
    }),
  );
  assert.throws(() =>
    contract.verifyServerIndex(
      JSON.stringify({ ...envelope, payload: envelope.payload.slice(1) }),
      { keys: { test: keys.publicKey }, now },
    ),
  );
  assert.throws(
    () =>
      contract.verifyServerIndex(JSON.stringify(envelope), {
        keys: { test: keys.publicKey },
        now: now + 2 * 86400000,
      }),
    /expir/i,
  );
  assert.doesNotThrow(() =>
    contract.verifyServerIndex(JSON.stringify(envelope), {
      keys: { test: keys.publicKey },
      now: now + 2 * 86400000,
      installed: true,
    }),
  );
  assert.throws(
    () =>
      contract.verifyServerIndex(JSON.stringify(envelope), {
        keys: { test: keys.publicKey },
        now,
        replay: {
          revision: 3,
          payloadHash: verified.payloadHash,
          highestBuild: 2,
          artifactHash: 'b'.repeat(64),
        },
      }),
    /replay/i,
  );
  const sameRevision = contract.signServerIndex(
    { ...payload(), release: { ...payload().release, sha256: 'f'.repeat(64) } },
    'test',
    keys.privateKey,
  );
  assert.throws(
    () =>
      contract.verifyServerIndex(JSON.stringify(sameRevision), {
        keys: { test: keys.publicKey },
        now,
        replay: verified.replay,
      }),
    /replay/i,
  );
});
test('strict release rejects unknown inputs, insecure identity and incomplete compatibility inventory', () => {
  for (const change of [
    { product: 'other' },
    { platform: 'win32' },
    { extra: true },
    { revision: -1 },
  ])
    assert.throws(() =>
      contract.signServerIndex(
        { ...payload(), ...change } as contract.ServerPayload,
        'test',
        keys.privateKey,
      ),
    );
  assert.throws(() =>
    contract.signServerIndex(
      { ...payload(), release: { ...payload().release, compatibility: {} } },
      'test',
      keys.privateKey,
    ),
  );
  assert.equal(
    contract.releaseFilename(payload().release),
    'cc-desk-tunnel-server-0.2.11-build2.tar.gz',
  );
});
test('compatibility pins all persisted protocol definitions while permitting only the handshake number to change', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of contract.COMPATIBILITY_PATHS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      path === 'packages/protocol/src/index.ts'
        ? 'export const PROTOCOL_VERSION = 20;\nexport const sessionSchema = "stable";\n'
        : path,
    );
  }
  const baseline = contract.compatibility(root);
  const path = join(root, 'packages/protocol/src/index.ts');
  writeFileSync(path, readFileSync(path, 'utf8').replace('= 20;', '= 21;'));
  assert.deepEqual(contract.compatibility(root), baseline);
  writeFileSync(path, readFileSync(path, 'utf8').replace('stable', 'changed'));
  assert.notDeepEqual(contract.compatibility(root), baseline);
  assert.ok(contract.COMPATIBILITY_PATHS.includes('apps/server/src/web-certificate.ts'));
  assert.ok(contract.COMPATIBILITY_PATHS.includes('packages/protocol/src/web.ts'));
});
