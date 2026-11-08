const {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} = require('node:crypto');
const { gunzipSync } = require('node:zlib');

const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_BLOCKMAP_BYTES = 4 * 1024 * 1024;
const MAX_DECODED_BLOCKMAP_BYTES = 16 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 1024 ** 3;
const RELEASE_FIELDS = [
  'build',
  'appVersion',
  'protocol',
  'sourceCommit',
  'filename',
  'size',
  'sha256',
];
const DOMAIN = 'CC-SPACE-NSIS-DIFFERENTIAL-V1\n';

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function object(value, fields) {
  requireValue(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    'Invalid differential object',
  );
  requireValue(
    Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => Object.hasOwn(value, field)),
    'Invalid differential fields',
  );
  return value;
}

function positive(value, max = Number.MAX_SAFE_INTEGER) {
  requireValue(
    Number.isSafeInteger(value) && value > 0 && value <= max,
    'Invalid differential integer',
  );
}

function hex(value, length) {
  requireValue(
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value),
    'Invalid differential digest',
  );
}

function base64(value, max, exact) {
  requireValue(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= Math.ceil(max / 3) * 4 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    'Invalid canonical base64',
  );
  const bytes = Buffer.from(value, 'base64');
  requireValue(
    bytes.length <= max &&
      (exact === undefined || bytes.length === exact) &&
      bytes.toString('base64') === value,
    'Invalid canonical base64',
  );
  return bytes;
}

function coordinates(value) {
  requireValue(value && typeof value === 'object', 'Missing artifact coordinates');
  positive(value.build);
  requireValue(
    typeof value.appVersion === 'string' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.appVersion) &&
      value.appVersion.split('.').every((part) => Number.isSafeInteger(Number(part))),
    'Invalid artifact version',
  );
  requireValue(
    value.filename === `CC-Space-Setup-${value.appVersion}-x64.exe` ||
      value.filename === `CC-Desk-Tunnel-Setup-${value.appVersion}-x64.exe`,
    'Invalid artifact filename',
  );
  return `/cc-updates/v1/artifacts/${value.build}/win32-x64/${value.filename}`;
}

function validatePayload(value) {
  const p = object(value, [
    'schema',
    'product',
    'channel',
    'platform',
    'arch',
    'release',
    'sha512',
    'blockmap',
  ]);
  requireValue(
    p.schema === 1 && p.product === 'cc-space-nsis-differential',
    'Invalid differential schema or product',
  );
  requireValue(
    ['pilot', 'stable'].includes(p.channel) && p.platform === 'win32' && p.arch === 'x64',
    'Invalid differential scope',
  );
  const r = object(p.release, RELEASE_FIELDS);
  coordinates(r);
  positive(r.protocol);
  positive(r.size, MAX_INSTALLER_BYTES);
  hex(r.sourceCommit, 40);
  hex(r.sha256, 64);
  base64(p.sha512, 64, 64);
  const m = object(p.blockmap, ['size', 'sha256', 'format']);
  positive(m.size, MAX_BLOCKMAP_BYTES);
  hex(m.sha256, 64);
  requireValue(m.format === 'gzip-json-v2', 'Unsupported differential blockmap format');
  return p;
}

function keyId(value) {
  requireValue(
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value),
    'Invalid differential key id',
  );
}

function boundedBytes(value, max) {
  requireValue(
    value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= max,
    'Invalid differential byte length',
  );
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function parse(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function signDescriptor(payload, id, key) {
  keyId(id);
  validatePayload(payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  requireValue(bytes.length <= MAX_PAYLOAD_BYTES, 'Differential payload too large');
  const encoded = bytes.toString('base64');
  const privateKey = key instanceof KeyObject ? key : createPrivateKey(key);
  requireValue(
    privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519',
    'Expected Ed25519 private key',
  );
  const signature = sign(null, Buffer.from(`${DOMAIN}${id}\n${encoded}`), privateKey).toString(
    'base64',
  );
  const envelope = Buffer.from(JSON.stringify({ keyId: id, payload: encoded, signature }));
  requireValue(envelope.length <= MAX_DESCRIPTOR_BYTES, 'Differential descriptor too large');
  return envelope;
}

function authenticatedDescriptor(bytes, keys) {
  const envelope = object(parse(boundedBytes(bytes, MAX_DESCRIPTOR_BYTES)), [
    'keyId',
    'payload',
    'signature',
  ]);
  keyId(envelope.keyId);
  const payload = base64(envelope.payload, MAX_PAYLOAD_BYTES);
  const signature = base64(envelope.signature, 64, 64);
  requireValue(keys && Object.hasOwn(keys, envelope.keyId), 'Unknown differential signing key');
  const input = keys[envelope.keyId];
  const publicKey =
    input instanceof KeyObject && input.type === 'public' ? input : createPublicKey(input);
  requireValue(publicKey.asymmetricKeyType === 'ed25519', 'Expected Ed25519 public key');
  requireValue(
    verify(
      null,
      Buffer.from(`${DOMAIN}${envelope.keyId}\n${envelope.payload}`),
      publicKey,
      signature,
    ),
    'Invalid differential signature',
  );
  const p = validatePayload(parse(payload));
  Object.freeze(p.release);
  Object.freeze(p.blockmap);
  return Object.freeze(p);
}

// This binds an already trusted current index release; index freshness and withdrawal
// checks remain the controller's responsibility.
function verifyDescriptor(bytes, keys, release, channel) {
  const p = authenticatedDescriptor(bytes, keys);
  requireValue(
    release && typeof release === 'object' && p.channel === channel,
    'Differential release scope mismatch',
  );
  requireValue(
    RELEASE_FIELDS.every(
      (field) => Object.hasOwn(release, field) && p.release[field] === release[field],
    ),
    'Differential release mismatch',
  );
  return p;
}

function verifyBaselineDescriptor(bytes, keys, identity) {
  const p = authenticatedDescriptor(bytes, keys);
  requireValue(
    identity && identity.product === 'cc-desk-tunnel-managed',
    'Invalid baseline product',
  );
  requireValue(
    ['channel', 'platform', 'arch'].every(
      (field) => Object.hasOwn(identity, field) && identity[field] === p[field],
    ),
    'Differential baseline scope mismatch',
  );
  requireValue(
    ['build', 'appVersion', 'protocol', 'sourceCommit'].every(
      (field) => Object.hasOwn(identity, field) && identity[field] === p.release[field],
    ),
    'Differential baseline identity mismatch',
  );
  return p;
}

function decodeBlockmap(bytes, payload) {
  const p = validatePayload(payload);
  const compressed = boundedBytes(bytes, MAX_BLOCKMAP_BYTES);
  requireValue(
    compressed.length === p.blockmap.size &&
      createHash('sha256').update(compressed).digest('hex') === p.blockmap.sha256,
    'Differential blockmap integrity mismatch',
  );
  requireValue(
    compressed[0] === 0x1f && compressed[1] === 0x8b && compressed[2] === 8,
    'Expected gzip blockmap',
  );
  const m = object(parse(gunzipSync(compressed, { maxOutputLength: MAX_DECODED_BLOCKMAP_BYTES })), [
    'version',
    'files',
  ]);
  requireValue(
    m.version === '2' && Array.isArray(m.files) && m.files.length === 1,
    'Unsupported differential blockmap',
  );
  const f = object(m.files[0], ['name', 'offset', 'checksums', 'sizes']);
  requireValue(f.name === 'file' && f.offset === 0, 'Invalid differential file span');
  requireValue(
    Array.isArray(f.checksums) &&
      Array.isArray(f.sizes) &&
      f.sizes.length > 0 &&
      f.sizes.length <= 200000 &&
      f.checksums.length === f.sizes.length,
    'Invalid differential chunks',
  );
  let total = 0;
  for (let i = 0; i < f.sizes.length; i++) {
    positive(f.sizes[i], 1024 * 1024);
    base64(f.checksums[i], 18, 18);
    total += f.sizes[i];
    requireValue(
      Number.isSafeInteger(total) && total <= p.release.size,
      'Invalid differential chunk span',
    );
  }
  requireValue(total === p.release.size, 'Incomplete differential chunk span');
  return m;
}

module.exports = {
  MAX_DESCRIPTOR_BYTES,
  MAX_BLOCKMAP_BYTES,
  MAX_DECODED_BLOCKMAP_BYTES,
  signDescriptor,
  verifyDescriptor,
  verifyBaselineDescriptor,
  decodeBlockmap,
  descriptorPath: (value) => `${coordinates(value)}.differential.json`,
  blockmapPath: (value) => `${coordinates(value)}.blockmap`,
};
