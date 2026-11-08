import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { signIndex } from '../../../packages/managed-updates/src/index.ts';
import { renewalDecision, verifyForRenewal } from '../../../scripts/renew-managed-index.mjs';

const now = Date.now();
const day = 86400000;
const release = {
  build: 2,
  appVersion: '0.3.6',
  protocol: 20,
  sourceCommit: 'a'.repeat(40),
  notes: 'pilot',
  filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
  size: 10,
  sha256: 'b'.repeat(64),
};
const payload = {
  schema: 1,
  product: 'cc-desk-tunnel-managed',
  channel: 'pilot',
  platform: 'win32',
  arch: 'x64',
  revision: 4,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 3 * day).toISOString(),
  state: 'published',
  release,
};

test('renew only when due; a forced acceptance run preserves the same release', () => {
  assert.equal(renewalDecision(payload, release, now), 'not-due');
  assert.equal(renewalDecision(payload, release, now + day), 'renew');
  assert.equal(renewalDecision(payload, release, now, true), 'renew');
});
test('withdrawal stays withdrawn and changed releases cannot be republished', () => {
  assert.equal(
    renewalDecision({ ...payload, state: 'empty', release: null }, release, now, true),
    'withdrawn',
  );
  assert.throws(() => renewalDecision({ ...payload, release: { ...release, build: 3 } }, release));
});
test('signing administrator can recover an expired authentic index without accepting bad signatures', () => {
  const keys = generateKeyPairSync('ed25519');
  const signed = signIndex(payload, 'test', keys.privateKey, now);
  assert.equal(
    verifyForRenewal(signed, { test: keys.publicKey }, now + 4 * day).payload.revision,
    4,
  );
  assert.throws(() =>
    verifyForRenewal(signed, { test: generateKeyPairSync('ed25519').publicKey }, now),
  );
  assert.throws(() => verifyForRenewal(signed, { test: keys.publicKey }, now - day));
});
