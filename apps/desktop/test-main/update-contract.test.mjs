import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  signIndex,
  verifyIndex,
  selectUpdate,
  artifactPath,
} from '../../../packages/managed-updates/src/index.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keys = { test: publicKey };
const now = Date.parse('2026-10-23T00:00:00Z');
const identity = {
  product: 'cc-desk-tunnel-managed',
  channel: 'pilot',
  platform: 'win32',
  arch: 'x64',
  build: 1,
  protocol: 20,
};
function payload() {
  return {
    schema: 1,
    product: identity.product,
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    revision: 1,
    issuedAt: '2026-10-23T00:00:00Z',
    expiresAt: '2026-10-26T00:00:00Z',
    state: 'published',
    release: {
      build: 2,
      appVersion: '0.3.6',
      protocol: 20,
      sourceCommit: 'a'.repeat(40),
      notes: '修复说明，按纯文本显示。',
      filename: 'CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
      size: 123,
      sha256: 'b'.repeat(64),
    },
  };
}
// Independent signer: malformed payloads must reach the verifier, not its signing validator.
function wire(value, keyId = 'test') {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64');
  return JSON.stringify({
    schema: 1,
    keyId,
    payload: encoded,
    signature: sign(
      null,
      Buffer.from(`CC-DESK-TUNNEL-UPDATE-V1\n${keyId}\n${encoded}`),
      privateKey,
    ).toString('base64'),
  });
}
const verified = (value) => verifyIndex(wire(value), keys, now);

test('interoperates with the exact domain-separated signature and hashes raw payload bytes', () => {
  const signed = signIndex(payload(), 'test', privateKey, now);
  const result = verifyIndex(signed, keys, now);
  assert.deepEqual(result.payload, payload());
  assert.equal(
    result.payloadHash,
    createHash('sha256')
      .update(Buffer.from(JSON.parse(signed).payload, 'base64'))
      .digest('hex'),
  );
  assert.deepEqual(JSON.parse(signed), JSON.parse(wire(payload())));
  assert.ok(Object.isFrozen(result.payload.release));
  assert.equal(
    artifactPath(result.payload.release),
    '/cc-updates/v1/artifacts/2/win32-x64/CC-Desk-Tunnel-Setup-0.3.6-x64.exe',
  );
});

test('rejects tampering, unknown keys, wrong keys and non-Ed25519 keys', () => {
  const envelope = JSON.parse(wire(payload()));
  envelope.payload = Buffer.from(JSON.stringify({ ...payload(), revision: 2 })).toString('base64');
  assert.throws(() => verifyIndex(JSON.stringify(envelope), keys, now));
  assert.throws(() => verifyIndex(wire(payload(), 'unknown'), keys, now));
  assert.throws(() => verifyIndex(wire(payload(), 'toString'), {}, now));
  assert.throws(() =>
    verifyIndex(wire(payload()), { test: generateKeyPairSync('ed25519').publicKey }, now),
  );
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => verifyIndex(wire(payload()), { test: rsa.publicKey }, now));
  assert.throws(() => signIndex(payload(), 'test', rsa.privateKey, now));
  const renamed = { ...JSON.parse(wire(payload())), keyId: 'alias' };
  assert.throws(() => verifyIndex(JSON.stringify(renamed), { alias: publicKey }, now));
});

test('verifies the original bytes even with whitespace, and rejects signed invalid UTF-8', () => {
  function rawWire(bytes) {
    const payload = bytes.toString('base64');
    return JSON.stringify({
      schema: 1,
      keyId: 'test',
      payload,
      signature: sign(
        null,
        Buffer.from(`CC-DESK-TUNNEL-UPDATE-V1\ntest\n${payload}`),
        privateKey,
      ).toString('base64'),
    });
  }
  const bytes = Buffer.from(JSON.stringify(payload(), null, 2) + '\n');
  const result = verifyIndex(rawWire(bytes), keys, now);
  assert.equal(result.payloadHash, createHash('sha256').update(bytes).digest('hex'));
  const bad = Buffer.concat([
    Buffer.from(JSON.stringify(payload()).slice(0, -1)),
    Buffer.from([0xff]),
    Buffer.from('}'),
  ]);
  assert.throws(() => verifyIndex(rawWire(bad), keys, now));
  assert.throws(() => verifyIndex(wire(payload()), keys, now + 3 * 86400000));
});

test('rejects malformed, noncanonical or oversized envelopes before accepting payloads', () => {
  for (const edit of [
    (e) => ({ ...e, extra: true }),
    (e) => ({ ...e, schema: 2 }),
    (e) => ({ ...e, payload: `${e.payload}\n` }),
    (e) => ({ ...e, payload: e.payload.replace(/=+$/, '') + '=' }),
    (e) => ({ ...e, signature: Buffer.alloc(63).toString('base64') }),
    (e) => ({ ...e, signature: e.signature.replace(/==$/, '=') }),
    (e) => ({ ...e, keyId: 'bad\nkey' }),
  ])
    assert.throws(() => verifyIndex(JSON.stringify(edit(JSON.parse(wire(payload())))), keys, now));
  for (const raw of ['null', '[]', '{', ' '.repeat(65537), Buffer.from([0xff])]) {
    assert.throws(() => verifyIndex(raw, keys, now));
  }
});

test('rejects authenticated schema violations, unsafe numbers, paths and time violations', () => {
  const edits = [
    (p) => {
      p.extra = 1;
    },
    (p) => {
      p.product = 'official';
    },
    (p) => {
      p.channel = 'other';
    },
    (p) => {
      p.platform = 'linux';
    },
    (p) => {
      p.arch = 'arm64';
    },
    (p) => {
      p.revision = 0;
    },
    (p) => {
      p.revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (p) => {
      p.release.build = 1.5;
    },
    (p) => {
      p.release.protocol = -1;
    },
    (p) => {
      p.release.sha256 = 'B'.repeat(64);
    },
    (p) => {
      p.release.size = 1073741825;
    },
    (p) => {
      p.release.size = 0;
    },
    (p) => {
      p.release.sourceCommit = 'short';
    },
    (p) => {
      p.release.appVersion = '0.3.6-custom';
    },
    (p) => {
      p.release.filename = '../setup.exe';
    },
    (p) => {
      p.release.url = 'https://evil.invalid';
    },
    (p) => {
      p.release.notes = 'x'.repeat(8001);
    },
    (p) => {
      p.state = 'empty';
    },
    (p) => {
      p.release = null;
    },
    (p) => {
      p.issuedAt = '2026-10-23T00:05:01Z';
    },
    (p) => {
      p.issuedAt = '2026-02-30T00:00:00Z';
    },
    (p) => {
      p.issuedAt = '2026-10-23T08:00:00+08:00';
    },
    (p) => {
      p.expiresAt = '2026-10-23T00:00:00Z';
    },
    (p) => {
      p.expiresAt = '2026-10-30T00:00:01Z';
    },
  ];
  for (const edit of edits) {
    const p = payload();
    edit(p);
    assert.throws(() => verified(p), edit.toString());
  }
});

test('allows same app version with higher build; tracks immutable revision and artifact identity', () => {
  const first = selectUpdate(verified(payload()), identity);
  assert.equal(first.status, 'available');
  assert.equal(first.release.build, 2);
  assert.equal(selectUpdate(verified(payload()), identity, first.nextState).status, 'available');
  assert.equal(
    selectUpdate(verified(payload()), { ...identity, build: 2 }, first.nextState).status,
    'current',
  );
  const p = payload();
  p.revision = 2;
  p.release.notes = '续期';
  const renewed = selectUpdate(verified(p), identity, first.nextState);
  assert.equal(renewed.status, 'available');
  assert.throws(() => selectUpdate(verified(payload()), identity, renewed.nextState), /revision/);
  p.revision = 1;
  assert.throws(() => selectUpdate(verified(p), identity, first.nextState), /revision/);
  p.revision = 2;
  p.release.sha256 = 'c'.repeat(64);
  assert.throws(() => selectUpdate(verified(p), identity, first.nextState), /build/);
});

test('withdrawal advances revision and prevents replay; compatibility checks never offer an executable', () => {
  const first = selectUpdate(verified(payload()), identity);
  const p = payload();
  p.revision = 2;
  p.state = 'empty';
  p.release = null;
  const withdrawn = selectUpdate(verified(p), identity, first.nextState);
  assert.equal(withdrawn.status, 'empty');
  assert.equal(withdrawn.release, null);
  assert.throws(() => selectUpdate(verified(payload()), identity, withdrawn.nextState));
  for (const change of [
    { channel: 'stable' },
    { product: 'other' },
    { platform: 'linux' },
    { arch: 'arm64' },
  ]) {
    const result = selectUpdate(verified(payload()), { ...identity, ...change });
    assert.equal(result.status, 'scope-mismatch');
    assert.equal(result.release, null);
    assert.equal(result.nextState, null);
  }
  const incompatible = selectUpdate(verified(payload()), { ...identity, protocol: 19 });
  assert.equal(incompatible.status, 'protocol-mismatch');
  assert.equal(incompatible.release, null);
  assert.equal(incompatible.nextState.revision, 1);
  const higher = payload();
  higher.release.build = 3;
  const seen = selectUpdate(verified(higher), identity);
  const lower = payload();
  lower.revision = 2;
  assert.equal(selectUpdate(verified(lower), identity, seen.nextState).status, 'current');
});
