// Separate Linux program-update trust boundary; never import into business protocol bundles.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export const PRODUCT = 'cc-desk-tunnel-managed-server';
export const RUNTIME_LEVEL = 'node24-cli2.1.295-v1';
export const MAX_INDEX_BYTES = 128 * 1024;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 10000;
export const COMPATIBILITY_PATHS = [
  ...[
    'store',
    'usage',
    'web-access',
    'native-settings',
    'native-onboarding',
    'native-instructions',
    'native-moderation-hook',
    'moderation',
    'errors',
    'native-deployment',
    'native-terminal-policy',
    'web-certificate',
    'web-totp',
    'device-terms',
    'claude',
    'legacy',
    'native-account',
  ].map((name) => `apps/server/src/${name}.ts`),
  'packages/protocol/src/index.ts',
  'packages/protocol/src/web.ts',
  'packages/protocol/src/web-certificate.ts',
];
export type ServerRelease = {
  build: number;
  appVersion: string;
  protocol: number;
  sourceCommit: string;
  size: number;
  sha256: string;
  packageLockSha256: string;
  runtimeLevel: string;
  compatibility: Record<string, string>;
  descriptorSha256: string;
};
export type ServerPayload = {
  schema: 1;
  product: typeof PRODUCT;
  channel: 'pilot';
  platform: 'linux';
  arch: 'x64';
  revision: number;
  issuedAt: string;
  expiresAt: string;
  release: ServerRelease;
};
export type SignedServerIndex = { payload: string; keyId: string; signature: string };
export type ReplayState = {
  revision: number;
  payloadHash: string;
  highestBuild: number;
  artifactHash: string;
};
export type DescriptorIdentity = Pick<
  ServerRelease,
  'build' | 'appVersion' | 'protocol' | 'sourceCommit'
>;
export type ServerDescriptor = DescriptorIdentity & {
  schema: 1;
  product: typeof PRODUCT;
  files: Record<string, { size: number; sha256: string }>;
};
export type KeyInput = KeyObject | string | Buffer;
export type VerifiedServerIndex = {
  payload: ServerPayload;
  payloadHash: string;
  envelope: SignedServerIndex;
  replay: ReplayState;
};

export function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
export function strictObject(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid object');
  const record = value as Record<string, unknown>;
  requireValue(
    Object.keys(record).length === fields.length && fields.every((f) => Object.hasOwn(record, f)),
    'Invalid fields',
  );
  return record;
}
export function sha256(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}
function positive(v: unknown) {
  requireValue(Number.isSafeInteger(v) && (v as number) > 0, 'Invalid positive integer');
}
function digest(v: unknown) {
  requireValue(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v), 'Invalid digest');
}
function identity(value: Record<string, unknown>) {
  positive(value.build);
  positive(value.protocol);
  requireValue(
    typeof value.appVersion === 'string' &&
      /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.]{1,40})?$/.test(value.appVersion),
    'Invalid version',
  );
  requireValue(
    typeof value.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(value.sourceCommit),
    'Invalid source commit',
  );
}
function timestamp(v: unknown) {
  requireValue(
    typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v),
    'Invalid UTC timestamp',
  );
  const n = Date.parse(v);
  requireValue(Number.isFinite(n) && new Date(n).toISOString() === v, 'Invalid UTC timestamp');
  return n;
}
function validatePayload(value: unknown): asserts value is ServerPayload {
  const p = strictObject(value, [
    'schema',
    'product',
    'channel',
    'platform',
    'arch',
    'revision',
    'issuedAt',
    'expiresAt',
    'release',
  ]);
  requireValue(
    p.schema === 1 &&
      p.product === PRODUCT &&
      p.channel === 'pilot' &&
      p.platform === 'linux' &&
      p.arch === 'x64',
    'Invalid server identity',
  );
  positive(p.revision);
  const issue = timestamp(p.issuedAt),
    expiry = timestamp(p.expiresAt);
  requireValue(expiry > issue && expiry - issue <= 31 * 86400000, 'Invalid expiry interval');
  const r = strictObject(p.release, [
    'build',
    'appVersion',
    'protocol',
    'sourceCommit',
    'size',
    'sha256',
    'packageLockSha256',
    'runtimeLevel',
    'compatibility',
    'descriptorSha256',
  ]);
  identity(r);
  positive(r.size);
  requireValue((r.size as number) <= MAX_ARCHIVE_BYTES, 'Archive too large');
  digest(r.sha256);
  digest(r.packageLockSha256);
  digest(r.descriptorSha256);
  requireValue(
    typeof r.runtimeLevel === 'string' &&
      /^node\d{1,3}-cli\d{1,4}\.\d{1,4}\.\d{1,5}-v\d{1,5}$/.test(r.runtimeLevel),
    'Invalid runtime level',
  );
  const compatibility = strictObject(r.compatibility, COMPATIBILITY_PATHS);
  Object.values(compatibility).forEach(digest);
}
function base64(v: unknown, max: number) {
  requireValue(
    typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v),
    'Invalid base64url',
  );
  const bytes = Buffer.from(v, 'base64url');
  requireValue(bytes.toString('base64url') === v, 'Noncanonical base64url');
  return bytes;
}
export function signServerIndex(
  payload: ServerPayload,
  keyId: string,
  key: KeyInput,
): SignedServerIndex {
  validatePayload(payload);
  requireValue(/^[a-zA-Z0-9_-]{1,80}$/.test(keyId), 'Invalid key ID');
  const privateKey =
    key instanceof Object && 'type' in key ? (key as KeyObject) : createPrivateKey(key as string);
  requireValue(privateKey.asymmetricKeyType === 'ed25519', 'Ed25519 required');
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    payload: bytes.toString('base64url'),
    keyId,
    signature: sign(null, bytes, privateKey).toString('base64url'),
  };
}
export function verifyServerIndex(
  bytes: string | Buffer,
  options: {
    keys: Record<string, KeyInput>;
    now?: number;
    replay?: ReplayState;
    installed?: boolean;
  },
): VerifiedServerIndex {
  requireValue(Buffer.byteLength(bytes) <= MAX_INDEX_BYTES, 'Index too large');
  const e = strictObject(JSON.parse(bytes.toString()), ['payload', 'keyId', 'signature']);
  requireValue(
    typeof e.keyId === 'string' && Object.hasOwn(options.keys, e.keyId),
    'Unknown signing key',
  );
  const payloadBytes = base64(e.payload, MAX_INDEX_BYTES),
    signature = base64(e.signature, 100);
  const input = options.keys[e.keyId];
  const key =
    input instanceof Object && 'type' in input
      ? (input as KeyObject)
      : createPublicKey(input as string);
  requireValue(
    key.asymmetricKeyType === 'ed25519' &&
      signature.length === 64 &&
      verify(null, payloadBytes, key, signature),
    'Invalid Ed25519 signature',
  );
  const payload: unknown = JSON.parse(payloadBytes.toString('utf8'));
  validatePayload(payload);
  const now = options.now ?? Date.now();
  if (!options.installed) {
    requireValue(timestamp(payload.issuedAt) <= now + 60000, 'Index issued in future');
    requireValue(timestamp(payload.expiresAt) > now, 'Index expired');
  }
  const hash = sha256(payloadBytes),
    floor = options.replay,
    release = payload.release;
  if (floor)
    requireValue(
      payload.revision >= floor.revision &&
        release.build >= floor.highestBuild &&
        (payload.revision !== floor.revision || hash === floor.payloadHash) &&
        (release.build !== floor.highestBuild || release.sha256 === floor.artifactHash),
      'Index replay rejected',
    );
  return {
    payload,
    payloadHash: hash,
    envelope: e as SignedServerIndex,
    replay: {
      revision: payload.revision,
      payloadHash: hash,
      highestBuild: release.build,
      artifactHash: release.sha256,
    },
  };
}
export function releaseFilename(r: Pick<ServerRelease, 'build' | 'appVersion'>) {
  return `cc-desk-tunnel-server-${r.appVersion}-build${r.build}.tar.gz`;
}
export function validArchivePath(path: string) {
  return (
    path.length <= 200 &&
    /^[a-zA-Z0-9_.@/+-]+$/.test(path) &&
    !path.startsWith('/') &&
    path.split('/').every((p) => p !== '.' && p !== '..' && p.length > 0)
  );
}
export function parseDescriptor(bytes: Buffer | string): ServerDescriptor {
  requireValue(Buffer.byteLength(bytes) <= 4 * 1024 * 1024, 'Descriptor too large');
  const d = strictObject(JSON.parse(bytes.toString()), [
    'schema',
    'product',
    'build',
    'appVersion',
    'protocol',
    'sourceCommit',
    'files',
  ]);
  requireValue(d.schema === 1 && d.product === PRODUCT, 'Invalid descriptor identity');
  identity(d);
  requireValue(
    d.files && typeof d.files === 'object' && !Array.isArray(d.files),
    'Invalid inventory',
  );
  const entries = Object.entries(d.files);
  requireValue(entries.length > 0 && entries.length <= MAX_FILES, 'Invalid file count');
  let total = 0;
  for (const [path, entry] of entries) {
    requireValue(
      validArchivePath(path) &&
        path !== 'SERVER-RELEASE.json' &&
        !path.split('/').includes('node_modules'),
      'Unsafe inventory path',
    );
    const file = strictObject(entry, ['size', 'sha256']);
    digest(file.sha256);
    requireValue(
      Number.isSafeInteger(file.size) && (file.size as number) >= 0,
      'Invalid file size',
    );
    total += file.size as number;
  }
  requireValue(total <= MAX_EXPANDED_BYTES, 'Inventory too large');
  for (const path of [
    'package.json',
    'package-lock.json',
    'apps/server/src/managed-main.ts',
    'packages/protocol/package.json',
    ...COMPATIBILITY_PATHS,
  ])
    requireValue(Object.hasOwn(d.files, path), `Missing required file: ${path}`);
  return d as ServerDescriptor;
}
export function compatibility(root: string) {
  return Object.fromEntries(
    COMPATIBILITY_PATHS.map((p) => {
      let bytes: Buffer | string = readFileSync(join(root, p));
      if (p === 'packages/protocol/src/index.ts') {
        // Pin the entire persisted schema/helper closure. Only the standalone handshake number may differ;
        // protocol history and every schema/serializer byte remain part of the compatibility digest.
        const source = bytes.toString('utf8');
        const declaration = /^export const PROTOCOL_VERSION = [0-9]+;(?=\r?$)/gm;
        requireValue(
          [...source.matchAll(declaration)].length === 1,
          'Invalid protocol version declaration',
        );
        bytes = source.replace(declaration, 'export const PROTOCOL_VERSION = 0;');
      }
      return [p, sha256(bytes)];
    }),
  );
}
export function buildDescriptor(root: string, value: DescriptorIdentity): ServerDescriptor {
  const files: ServerDescriptor['files'] = {};
  function walk(prefix = '') {
    for (const name of readdirSync(join(root, prefix)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === 'SERVER-RELEASE.json') continue;
      requireValue(
        validArchivePath(path) && !path.split('/').includes('node_modules'),
        'Unsafe inventory path',
      );
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) walk(path);
      else {
        requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Only regular release files allowed');
        files[path] = { size: stat.size, sha256: sha256(readFileSync(join(root, path))) };
      }
    }
  }
  walk();
  return parseDescriptor(JSON.stringify({ schema: 1, product: PRODUCT, ...value, files }));
}
