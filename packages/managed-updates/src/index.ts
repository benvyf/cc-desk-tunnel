// Node-only contract. Do not import this module into the renderer protocol bundle.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';

export const MAX_INDEX_BYTES = 64 * 1024;
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const PRODUCT = 'cc-desk-tunnel-managed';
const verifiedIndex = Symbol('verified update index');
const DAY = 24 * 60 * 60 * 1000;

export type Release = Readonly<{
  build: number;
  appVersion: string;
  protocol: number;
  sourceCommit: string;
  notes: string;
  filename: string;
  size: number;
  sha256: string;
}>;
export type Payload = Readonly<{
  schema: 1;
  product: typeof PRODUCT;
  channel: 'pilot' | 'stable';
  platform: 'win32';
  arch: 'x64';
  revision: number;
  issuedAt: string;
  expiresAt: string;
  state: 'published' | 'empty';
  release: Release | null;
}>;
export type VerifiedIndex = Readonly<{
  payload: Payload;
  payloadHash: string;
  [verifiedIndex]: true;
}>;
export type Identity = {
  product: string;
  channel: string;
  platform: string;
  arch: string;
  build: number;
  protocol: number;
};
// Stored per product/channel/platform/arch by the future controller, not per connection.
export type ReplayState = Readonly<{
  revision: number;
  payloadHash: string;
  highestBuild: number;
  artifactHash: string | null;
}>;
type KeyInput = KeyObject | string | Buffer;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  requireValue(
    keys.length === fields.length && fields.every((k) => Object.hasOwn(record, k)),
    'Invalid fields',
  );
  return record;
}

function positive(value: unknown): asserts value is number {
  requireValue(Number.isSafeInteger(value) && (value as number) > 0, 'Invalid positive integer');
}

function hex(value: unknown, length: number): asserts value is string {
  requireValue(
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value),
    'Invalid digest',
  );
}

function timestamp(value: unknown): number {
  requireValue(
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value),
    'Invalid UTC time',
  );
  const parsed = Date.parse(value);
  requireValue(
    Number.isFinite(parsed) &&
      new Date(parsed).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'),
    'Invalid UTC time',
  );
  return parsed;
}

function release(value: unknown): Release {
  const r = object(value, [
    'build',
    'appVersion',
    'protocol',
    'sourceCommit',
    'notes',
    'filename',
    'size',
    'sha256',
  ]);
  positive(r.build);
  positive(r.protocol);
  positive(r.size);
  requireValue(r.size <= MAX_ARTIFACT_BYTES, 'Artifact too large');
  requireValue(
    typeof r.appVersion === 'string' &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(r.appVersion) &&
      r.appVersion.split('.').every((v) => Number.isSafeInteger(Number(v))),
    'Invalid app version',
  );
  requireValue(
    r.filename === `CC-Desk-Tunnel-Setup-${r.appVersion}-x64.exe`,
    'Invalid artifact filename',
  );
  hex(r.sourceCommit, 40);
  hex(r.sha256, 64);
  // Notes remain untrusted plain text; consumers must never interpret them as HTML.
  requireValue(typeof r.notes === 'string' && r.notes.length <= 8000, 'Invalid notes');
  return Object.freeze({ ...r }) as Release;
}

export function validatePayload(value: unknown, now = Date.now()): Payload {
  requireValue(Number.isFinite(now), 'Invalid current time');
  const p = object(value, [
    'schema',
    'product',
    'channel',
    'platform',
    'arch',
    'revision',
    'issuedAt',
    'expiresAt',
    'state',
    'release',
  ]);
  requireValue(p.schema === 1 && p.product === PRODUCT, 'Invalid product or schema');
  requireValue(
    (p.channel === 'pilot' || p.channel === 'stable') && p.platform === 'win32' && p.arch === 'x64',
    'Invalid target',
  );
  positive(p.revision);
  const issued = timestamp(p.issuedAt);
  const expires = timestamp(p.expiresAt);
  requireValue(
    issued <= now + 5 * 60 * 1000 &&
      expires > now &&
      expires > issued &&
      expires - issued <= 7 * DAY,
    'Invalid validity interval',
  );
  requireValue(p.state === 'published' || p.state === 'empty', 'Invalid state');
  const artifact = p.state === 'published' ? release(p.release) : null;
  requireValue(p.state !== 'empty' || p.release === null, 'Empty index must have null release');
  return Object.freeze({ ...p, release: artifact }) as Payload;
}

function keyIdValid(keyId: unknown): asserts keyId is string {
  requireValue(typeof keyId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(keyId), 'Invalid key ID');
}

function ed25519(input: KeyInput, kind: 'public' | 'private'): KeyObject {
  const key =
    input instanceof KeyObject
      ? input
      : kind === 'private'
        ? createPrivateKey(input)
        : createPublicKey(input);
  requireValue(key.type === kind && key.asymmetricKeyType === 'ed25519', 'Expected Ed25519 key');
  return key;
}

function signatureInput(keyId: string, payload: string): Buffer {
  return Buffer.from(`CC-DESK-TUNNEL-UPDATE-V1\n${keyId}\n${payload}`, 'utf8');
}

function base64(value: unknown): Buffer {
  requireValue(typeof value === 'string' && value.length > 0, 'Invalid Base64');
  const decoded = Buffer.from(value, 'base64');
  requireValue(decoded.toString('base64') === value, 'Noncanonical Base64');
  return decoded;
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function signIndex(
  value: unknown,
  keyId: string,
  privateKey: KeyInput,
  now = Date.now(),
): Buffer {
  keyIdValid(keyId);
  const validated = validatePayload(value, now);
  const payload = Buffer.from(JSON.stringify(validated)).toString('base64');
  const signature = sign(
    null,
    signatureInput(keyId, payload),
    ed25519(privateKey, 'private'),
  ).toString('base64');
  const result = Buffer.from(JSON.stringify({ schema: 1, keyId, payload, signature }) + '\n');
  requireValue(result.length <= MAX_INDEX_BYTES, 'Index too large');
  return result;
}

export function verifyIndex(
  bytes: string | Buffer,
  trustedKeys: Readonly<Record<string, KeyInput>>,
  now = Date.now(),
): VerifiedIndex {
  requireValue(typeof bytes === 'string' || Buffer.isBuffer(bytes), 'Invalid index bytes');
  requireValue(Buffer.byteLength(bytes) <= MAX_INDEX_BYTES, 'Index too large');
  const envelope = object(parseJson(Buffer.from(bytes)), [
    'schema',
    'keyId',
    'payload',
    'signature',
  ]);
  requireValue(envelope.schema === 1, 'Invalid envelope schema');
  keyIdValid(envelope.keyId);
  requireValue(Object.hasOwn(trustedKeys, envelope.keyId), 'Unknown signing key');
  const decoded = base64(envelope.payload);
  const signature = base64(envelope.signature);
  requireValue(signature.length === 64, 'Invalid signature length');
  requireValue(
    verify(
      null,
      signatureInput(envelope.keyId, envelope.payload as string),
      ed25519(trustedKeys[envelope.keyId]!, 'public'),
      signature,
    ),
    'Invalid signature',
  );
  const payload = validatePayload(parseJson(decoded), now);
  return Object.freeze({
    payload,
    payloadHash: createHash('sha256').update(decoded).digest('hex'),
    [verifiedIndex]: true as const,
  });
}

export function artifactPath(value: Release): string {
  const r = release(value);
  return `/cc-updates/v1/artifacts/${r.build}/win32-x64/${r.filename}`;
}

function artifactHash(value: Release): string {
  // A revision may edit notes, but must not change an already observed build's identity.
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.build,
        value.appVersion,
        value.protocol,
        value.sourceCommit,
        value.filename,
        value.size,
        value.sha256,
      ]),
    )
    .digest('hex');
}

export function selectUpdate(
  index: VerifiedIndex,
  installed: Identity,
  previous: ReplayState | null = null,
): {
  status: 'available' | 'current' | 'empty' | 'protocol-mismatch' | 'scope-mismatch';
  release: Release | null;
  nextState: ReplayState | null;
} {
  requireValue(index[verifiedIndex] === true, 'Expected verified index');
  positive(installed.build);
  positive(installed.protocol);
  const p = index.payload;
  if (
    p.product !== installed.product ||
    p.channel !== installed.channel ||
    p.platform !== installed.platform ||
    p.arch !== installed.arch
  ) {
    return { status: 'scope-mismatch', release: null, nextState: previous };
  }
  if (previous) {
    positive(previous.revision);
    hex(previous.payloadHash, 64);
    requireValue(
      Number.isSafeInteger(previous.highestBuild) && previous.highestBuild >= 0,
      'Invalid build state',
    );
    if (previous.artifactHash !== null) hex(previous.artifactHash, 64);
    requireValue(
      p.revision >= previous.revision &&
        (p.revision !== previous.revision || index.payloadHash === previous.payloadHash),
      'Rejected revision replay',
    );
  }
  let highestBuild = previous?.highestBuild ?? 0;
  let hash = previous?.artifactHash ?? null;
  let status: 'available' | 'current' | 'empty' | 'protocol-mismatch';
  const r = p.release;
  if (!r) status = 'empty';
  else if (r.protocol !== installed.protocol) status = 'protocol-mismatch';
  else {
    const candidateHash = artifactHash(r);
    requireValue(
      r.build !== highestBuild || hash === candidateHash,
      'Conflicting artifact for observed build',
    );
    status = r.build > installed.build && r.build >= highestBuild ? 'available' : 'current';
    if (r.build > highestBuild) {
      highestBuild = r.build;
      hash = candidateHash;
    }
  }
  const nextState = Object.freeze({
    revision: p.revision,
    payloadHash: index.payloadHash,
    highestBuild,
    artifactHash: hash,
  });
  return { status, release: status === 'available' ? r : null, nextState };
}
