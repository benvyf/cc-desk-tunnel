import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const contract = require('../electron/managed-differential-contract.cjs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keys = { release: publicKey };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checksum = Buffer.alloc(18, 3).toString('base64');
const release = {
  build: 34,
  appVersion: '0.3.10',
  protocol: 1,
  sourceCommit: 'a'.repeat(40),
  filename: 'CC-Space-Setup-0.3.10-x64.exe',
  size: 12,
  sha256: 'b'.repeat(64),
};
const identity = {
  product: 'cc-desk-tunnel-managed',
  channel: 'pilot',
  platform: 'win32',
  arch: 'x64',
  ...release,
};
const map = () => ({
  version: '2',
  files: [{ name: 'file', offset: 0, checksums: [checksum, checksum], sizes: [5, 7] }],
});
const fixture = (blockmap = gzipSync(JSON.stringify(map()))) => ({
  bytes: blockmap,
  payload: {
    schema: 1,
    product: 'cc-space-nsis-differential',
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    release: { ...release },
    sha512: Buffer.alloc(64, 2).toString('base64'),
    blockmap: { size: blockmap.length, sha256: digest(blockmap), format: 'gzip-json-v2' },
  },
});
function rawSign(payload, key = privateKey, id = 'release') {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return Buffer.from(
    JSON.stringify({
      keyId: id,
      payload: encoded,
      signature: sign(
        null,
        Buffer.from(`CC-SPACE-NSIS-DIFFERENTIAL-V1\n${id}\n${encoded}`),
        key,
      ).toString('base64'),
    }),
  );
}
const verify = (bytes, expected = release, channel = 'pilot') =>
  contract.verifyDescriptor(bytes, keys, expected, channel);

test('signs and verifies a domain-separated descriptor bound to the complete release tuple', () => {
  const { payload } = fixture();
  const bytes = contract.signDescriptor(payload, 'release', privateKey);
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(verify(bytes, { ...release, notes: 'Untrusted display-only text' }), payload);
  assert.deepEqual(JSON.parse(bytes.toString()), JSON.parse(rawSign(payload).toString()));
  for (const field of Object.keys(release)) {
    const value = typeof release[field] === 'number' ? release[field] + 1 : `${release[field]}x`;
    assert.throws(() => verify(bytes, { ...release, [field]: value }), undefined, field);
    const incomplete = { ...release };
    delete incomplete[field];
    assert.throws(() => verify(bytes, incomplete), undefined, `missing ${field}`);
  }
  assert.throws(() => verify(bytes, release, 'stable'));
});

test('baseline binding requires the embedded product, channel, build and source identity', () => {
  const bytes = rawSign(fixture().payload);
  assert.deepEqual(contract.verifyBaselineDescriptor(bytes, keys, identity), fixture().payload);
  for (const field of [
    'product',
    'channel',
    'platform',
    'arch',
    'build',
    'appVersion',
    'protocol',
    'sourceCommit',
  ]) {
    const value = typeof identity[field] === 'number' ? identity[field] + 1 : `${identity[field]}x`;
    assert.throws(
      () => contract.verifyBaselineDescriptor(bytes, keys, { ...identity, [field]: value }),
      undefined,
      field,
    );
    const incomplete = { ...identity };
    delete incomplete[field];
    assert.throws(() => contract.verifyBaselineDescriptor(bytes, keys, incomplete));
  }
});

test('rejects wrong keys, unknown ids, changed payloads and a different signature domain', () => {
  const { payload } = fixture();
  assert.throws(() => verify(rawSign(payload, generateKeyPairSync('ed25519').privateKey)));
  assert.throws(() => verify(rawSign(payload, privateKey, 'unknown')));
  const envelope = JSON.parse(rawSign(payload));
  envelope.payload = Buffer.from(JSON.stringify({ ...payload, channel: 'stable' })).toString(
    'base64',
  );
  assert.throws(() => verify(Buffer.from(JSON.stringify(envelope))));
  envelope.payload = JSON.parse(rawSign(payload)).payload;
  envelope.signature = sign(null, Buffer.from(envelope.payload), privateKey).toString('base64');
  assert.throws(() => verify(Buffer.from(JSON.stringify(envelope))));
  const renamed = JSON.parse(rawSign(payload));
  renamed.keyId = 'alias';
  assert.throws(() =>
    contract.verifyDescriptor(
      Buffer.from(JSON.stringify(renamed)),
      { ...keys, alias: publicKey },
      release,
      'pilot',
    ),
  );
  assert.throws(() =>
    contract.signDescriptor(
      payload,
      'release',
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    ),
  );
});

test('requires canonical base64, bounded envelope and payload, and exact fields', () => {
  const { payload } = fixture();
  const original = JSON.parse(rawSign(payload));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const noncanonical = `${original.signature.slice(0, -3)}${alphabet[alphabet.indexOf(original.signature.at(-3)) | 1]}==`;
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), Buffer.from(original.signature, 'base64'));
  assert.throws(() =>
    verify(Buffer.from(JSON.stringify({ ...original, signature: noncanonical }))),
  );
  for (const field of ['signature', 'payload']) {
    for (const value of [
      ` ${original[field]}`,
      `${original[field]}\n`,
      original[field].replace(/=+$/, ''),
      '!!!!',
    ]) {
      if (value === original[field]) continue;
      assert.throws(() => verify(Buffer.from(JSON.stringify({ ...original, [field]: value }))));
    }
  }
  for (const extra of ['notes', '__proto__', 'constructor']) {
    const p = JSON.parse(JSON.stringify(payload));
    Object.defineProperty(p, extra, { value: 1, enumerable: true });
    assert.throws(() => verify(rawSign(p)));
    assert.throws(() => verify(Buffer.from(JSON.stringify({ ...original, [extra]: 1 }))));
  }
  assert.throws(() => verify(Buffer.alloc(contract.MAX_DESCRIPTOR_BYTES + 1, 32)));
  const encoded = Buffer.alloc(8193, 32).toString('base64');
  assert.throws(() => verify(Buffer.from(JSON.stringify({ ...original, payload: encoded }))));
  for (const mutate of [
    (p) => {
      p.release.notes = 'not allowed';
    },
    (p) => {
      p.blockmap.extra = true;
    },
    (p) => {
      p.blockmap.format = 'binary-v3';
    },
    (p) => {
      p.release.size = 1024 ** 3 + 1;
    },
    (p) => {
      p.release.build = Number.MAX_SAFE_INTEGER + 1;
    },
    (p) => {
      p.sha512 = Buffer.alloc(63).toString('base64');
    },
    (p) => {
      p.sha512 = p.sha512.replace(/=+$/, '');
    },
    (p) => {
      p.release.sha256 = 'B'.repeat(64);
    },
    (p) => {
      p.release.sourceCommit = 'x'.repeat(40);
    },
    (p) => {
      p.blockmap.size = contract.MAX_BLOCKMAP_BYTES + 1;
    },
    (p) => {
      p.channel = 'beta';
    },
    (p) => {
      p.platform = 'linux';
    },
    (p) => {
      p.schema = 2;
    },
  ]) {
    const p = structuredClone(payload);
    mutate(p);
    assert.throws(() => verify(rawSign(p)));
    assert.throws(() => contract.signDescriptor(p, 'release', privateKey));
  }
});

test('artifact paths validate minimal coordinates and prohibit traversal or ambiguous versions', () => {
  const coordinates = { build: 34, appVersion: '0.3.10', filename: release.filename };
  const base = `/cc-updates/v1/artifacts/34/win32-x64/${release.filename}`;
  assert.equal(contract.descriptorPath(coordinates), `${base}.differential.json`);
  assert.equal(contract.blockmapPath(coordinates), `${base}.blockmap`);
  assert.match(
    contract.blockmapPath({ ...coordinates, filename: 'CC-Desk-Tunnel-Setup-0.3.10-x64.exe' }),
    /CC-Desk-Tunnel/,
  );
  for (const change of [
    { build: 0 },
    { build: '34' },
    { build: Number.MAX_SAFE_INTEGER + 1 },
    { appVersion: '00.3.10' },
    { appVersion: '0.3.10+build.34' },
    { appVersion: '9007199254740992.1.1' },
    { filename: '../setup.exe' },
    { filename: `${release.filename}?x` },
    { filename: 'CC-Space-Setup-0.3.11-x64.exe' },
    { filename: 'CC-Space-Setup-0.3.10-x64.exe/../../evil' },
  ]) {
    assert.throws(() => contract.descriptorPath({ ...coordinates, ...change }));
    assert.throws(() => contract.blockmapPath({ ...coordinates, ...change }));
  }
});

test('decodes only the authenticated gzip JSON v2 map with an exact installer span', () => {
  const { payload, bytes } = fixture();
  assert.deepEqual(contract.decodeBlockmap(bytes, payload), map());
  assert.throws(() => contract.decodeBlockmap(Buffer.concat([bytes, Buffer.from('x')]), payload));
  const corrupt = Buffer.from(bytes);
  corrupt[20] ^= 1;
  assert.throws(() => contract.decodeBlockmap(corrupt, payload));
  for (const mutate of [
    (m) => {
      m.version = 2;
    },
    (m) => {
      m.version = '3';
    },
    (m) => {
      m.files.push(structuredClone(m.files[0]));
    },
    (m) => {
      m.files[0].name = '../file';
    },
    (m) => {
      m.files[0].offset = 1;
    },
    (m) => {
      m.files[0].sizes = [5];
    },
    (m) => {
      m.files[0].sizes = [5, 6];
    },
    (m) => {
      m.files[0].sizes = [0, 12];
    },
    (m) => {
      m.files[0].sizes = [-1, 13];
    },
    (m) => {
      m.files[0].sizes = [1.5, 10.5];
    },
    (m) => {
      m.files[0].sizes = [1048577, 7];
    },
    (m) => {
      m.files[0].sizes = [Number.MAX_SAFE_INTEGER, 7];
    },
    (m) => {
      m.files[0].checksums[0] = `${checksum}\n`;
    },
    (m) => {
      m.files[0].checksums[0] = Buffer.alloc(17).toString('base64');
    },
    (m) => {
      m.files[0].checksums = [];
      m.files[0].sizes = [];
    },
    (m) => {
      m.files[0].extra = true;
    },
    (m) => {
      m.__proto__ = { polluted: true };
      m.constructor = 1;
    },
  ]) {
    const m = map();
    mutate(m);
    const f = fixture(gzipSync(JSON.stringify(m)));
    assert.throws(() => contract.decodeBlockmap(f.bytes, f.payload));
  }
});

test('rejects oversized compressed maps, gzip bombs, non-gzip maps and excess chunks', () => {
  assert.equal(contract.MAX_DESCRIPTOR_BYTES, 16 * 1024);
  assert.equal(contract.MAX_BLOCKMAP_BYTES, 4 * 1024 * 1024);
  assert.equal(contract.MAX_DECODED_BLOCKMAP_BYTES, 16 * 1024 * 1024);
  for (const bytes of [
    Buffer.alloc(contract.MAX_BLOCKMAP_BYTES + 1),
    gzipSync(Buffer.alloc(contract.MAX_DECODED_BLOCKMAP_BYTES + 1, 32)),
    Buffer.from(JSON.stringify(map())),
    gzipSync('not JSON'),
    gzipSync(
      JSON.stringify({
        version: '2',
        files: [
          {
            name: 'file',
            offset: 0,
            checksums: Array(200001).fill(checksum),
            sizes: Array(200001).fill(1),
          },
        ],
      }),
    ),
  ]) {
    const f = fixture(bytes);
    assert.throws(() => contract.decodeBlockmap(bytes, f.payload));
  }
});
