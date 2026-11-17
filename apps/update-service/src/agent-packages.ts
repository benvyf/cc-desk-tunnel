// Public code-only worker publications. Signing belongs to the root publication CLI.
import { sign, verify, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  chmodSync,
  fchmodSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  assertSafeDirectory,
  readRegular,
  syncDirectory,
} from '../../server/src/managed-server-files.ts';
import {
  requireValue as need,
  strictObject,
  sha256,
  type KeyInput,
} from '../../../packages/managed-server/src/index.ts';

export const AGENT_INDEX_PATH = '/cc-host/v2/agent-index.json';
export type AgentManifest = {
  schema: 1;
  product: 'cc-host-agent';
  platform: 'linux-x64';
  version: number;
  issuedAt: string;
  expiresAt: string;
  archive: { sha256: string; size: number };
  files: Record<string, { sha256: string; size: number }>;
};
export type SignedAgentIndex = { payload: string; keyId: string; signature: string };
const compressed = 2 * 1024 * 1024,
  expanded = 8 * 1024 * 1024;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const safe = (p: string) =>
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:py|cjs)$/.test(p) &&
  Buffer.byteLength(p) <= 100 &&
  !p
    .replace(/\.[^.]+$/, '')
    .split('/')
    .some((v) =>
      [
        'config',
        'token',
        'tokens',
        'data',
        'secret',
        'secrets',
        'credentials',
        'identity',
      ].includes(v.toLowerCase()),
    );
export function canonicalAgent(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalAgent).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalAgent((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function signAgentIndex(
  payload: AgentManifest,
  keyId: string,
  key: KeyInput,
): SignedAgentIndex {
  const bytes = Buffer.from(canonicalAgent(payload));
  return {
    payload: bytes.toString('base64url'),
    keyId,
    signature: sign(
      null,
      bytes,
      typeof key === 'object' && !Buffer.isBuffer(key) ? key : createPrivateKey(key),
    ).toString('base64url'),
  };
}
export function verifyAgentIndex(
  input: Buffer | SignedAgentIndex,
  keys: Record<string, KeyInput>,
  installed = false,
  now = Date.now(),
): AgentManifest {
  if (Buffer.isBuffer(input)) {
    need(input.length <= 128 * 1024, 'Agent index too large');
    input = JSON.parse(input.toString());
  }
  const e = strictObject(input, ['payload', 'keyId', 'signature']);
  need(typeof e.keyId === 'string' && Object.hasOwn(keys, e.keyId), 'Unknown agent signing key');
  need(
    typeof e.payload === 'string' &&
      /^[A-Za-z0-9_-]+$/.test(e.payload) &&
      e.payload.length <= 128 * 1024,
    'Invalid payload encoding',
  );
  need(
    typeof e.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(e.signature),
    'Invalid signature encoding',
  );
  const bytes = Buffer.from(e.payload, 'base64url'),
    sig = Buffer.from(e.signature, 'base64url');
  need(
    bytes.toString('base64url') === e.payload && sig.toString('base64url') === e.signature,
    'Noncanonical encoding',
  );
  const key = keys[e.keyId]!;
  need(
    verify(
      null,
      bytes,
      typeof key === 'object' && !Buffer.isBuffer(key) ? key : createPublicKey(key),
      sig,
    ),
    'Invalid agent signature',
  );
  const p = strictObject(JSON.parse(bytes.toString()), [
    'schema',
    'product',
    'platform',
    'version',
    'issuedAt',
    'expiresAt',
    'archive',
    'files',
  ]);
  need(canonicalAgent(p) === bytes.toString(), 'Noncanonical agent payload');
  need(
    p.schema === 1 &&
      p.product === 'cc-host-agent' &&
      p.platform === 'linux-x64' &&
      positive(p.version),
    'Invalid agent identity',
  );
  need(typeof p.issuedAt === 'string' && typeof p.expiresAt === 'string', 'Invalid agent dates');
  const start = Date.parse(p.issuedAt),
    end = Date.parse(p.expiresAt);
  need(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= now + 60000 &&
      end > start &&
      end - start <= 31 * 86400000 &&
      (installed || end > now),
    'Invalid agent validity',
  );
  const a = strictObject(p.archive, ['sha256', 'size']);
  need(
    digest(a.sha256) && positive(a.size) && Number(a.size) <= compressed,
    'Invalid agent archive',
  );
  need(p.files && typeof p.files === 'object' && !Array.isArray(p.files), 'Invalid agent files');
  const files = Object.entries(p.files);
  need(
    files.length > 0 &&
      files.length <= 128 &&
      Object.hasOwn(p.files, 'worker.py') &&
      new Set(files.map(([k]) => k.toLowerCase())).size === files.length,
    'Invalid agent file count',
  );
  let total = 0;
  for (const [path, v] of files) {
    need(safe(path), 'Unsafe agent file');
    const f = strictObject(v, ['sha256', 'size']);
    need(
      digest(f.sha256) && Number.isSafeInteger(f.size) && Number(f.size) >= 0,
      'Invalid agent file',
    );
    total += Number(f.size);
  }
  need(total <= expanded, 'Agent files too large');
  return p as unknown as AgentManifest;
}
function octal(header: Buffer, start: number, len: number) {
  const v = header
    .subarray(start, start + len)
    .toString('ascii')
    .replace(/\0.*$/, '')
    .trim();
  need(/^[0-7]+$/.test(v), 'Invalid tar number');
  return parseInt(v, 8);
}
export function verifyAgentArchive(archive: Buffer, p: Pick<AgentManifest, 'archive' | 'files'>) {
  need(
    archive.length <= compressed &&
      archive.length === p.archive.size &&
      sha256(archive) === p.archive.sha256,
    'Agent archive mismatch',
  );
  const raw = gunzipSync(archive, { maxOutputLength: expanded });
  need(raw.length % 512 === 0, 'Invalid tar bounds');
  const found = new Set<string>();
  let offset = 0,
    ended = false;
  while (offset + 512 <= raw.length) {
    const h = raw.subarray(offset, offset + 512);
    offset += 512;
    if (h.every((b) => b === 0)) {
      need(
        raw.subarray(offset).every((b) => b === 0),
        'Trailing tar data',
      );
      ended = true;
      break;
    }
    need(found.size < 128, 'Too many agent files');
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    need(
      safe(name) &&
        !found.has(name) &&
        h[156] === 48 &&
        h.subarray(157, 257).every((b) => b === 0) &&
        h.subarray(345, 500).every((b) => b === 0),
      'Unsafe tar entry',
    );
    need(h.subarray(257, 263).toString() === 'ustar\0', 'Unsupported tar header');
    const check = octal(h, 148, 8),
      copy = Buffer.from(h);
    copy.fill(32, 148, 156);
    need(copy.reduce((a, b) => a + b, 0) === check, 'Tar checksum');
    const size = octal(h, 124, 12);
    need(offset + size <= raw.length, 'Truncated tar entry');
    const f = p.files[name],
      bytes = raw.subarray(offset, offset + size);
    need(f && f.size === size && f.sha256 === sha256(bytes), 'Agent file inventory mismatch');
    found.add(name);
    offset += Math.ceil(size / 512) * 512;
  }
  need(ended && found.size === Object.keys(p.files).length, 'Incomplete agent inventory');
}
export function agentArchive(files: Record<string, Buffer>) {
  need(Object.keys(files).length > 0 && Object.keys(files).length <= 128, 'Invalid file count');
  const chunks: Buffer[] = [],
    inventory: AgentManifest['files'] = {};
  let total = 1024;
  for (const name of Object.keys(files).sort()) {
    need(safe(name), 'Unsafe agent file');
    const bytes = files[name]!;
    const h = Buffer.alloc(512);
    h.write(name);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.fill(32, 148, 156);
    h[156] = 48;
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(
      h
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
    chunks.push(h, bytes, padding);
    total += 512 + bytes.length + padding.length;
    inventory[name] = { sha256: sha256(bytes), size: bytes.length };
  }
  need(total <= expanded, 'Expanded archive too large');
  chunks.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(chunks), { level: 9 });
  need(bytes.length <= compressed, 'Compressed archive too large');
  return {
    bytes,
    manifest: { archive: { sha256: sha256(bytes), size: bytes.length }, files: inventory },
  };
}
export function agentManifestFromArchive(bytes: Buffer) {
  need(bytes.length <= compressed, 'Archive too large');
  const raw = gunzipSync(bytes, { maxOutputLength: expanded });
  const files: AgentManifest['files'] = {};
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const h = raw.subarray(offset, offset + 512);
    offset += 512;
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    need(safe(name), 'Unsafe agent path');
    const size = octal(h, 124, 12);
    need(offset + size <= raw.length, 'Archive bounds');
    files[name] = { size, sha256: sha256(raw.subarray(offset, offset + size)) };
    offset += Math.ceil(size / 512) * 512;
  }
  const manifest = { archive: { size: bytes.length, sha256: sha256(bytes) }, files };
  verifyAgentArchive(bytes, manifest);
  return manifest;
}
export class AgentPackages {
  readonly root: string;
  readonly keys: Record<string, KeyInput>;
  constructor(root: string, keys: Record<string, KeyInput>) {
    this.root = join(root, 'host-agent');
    this.keys = keys;
  }
  path(digest: string) {
    return `/cc-host/v2/agent-artifacts/${digest}.tar.gz`;
  }
  index() {
    if (!existsSync(this.root)) return undefined;
    const file = join(this.root, 'index.json');
    if (!existsSync(file)) return undefined;
    const bytes = readRegular(file, 128 * 1024);
    const p = verifyAgentIndex(bytes, this.keys, true);
    verifyAgentArchive(
      readRegular(join(this.root, 'artifacts', p.archive.sha256 + '.tar.gz'), compressed),
      p,
    );
    return bytes;
  }
  status() {
    const bytes = this.index();
    if (!bytes) return null;
    const payload = verifyAgentIndex(bytes, this.keys, true);
    return {
      payload,
      index: JSON.parse(bytes.toString()) as SignedAgentIndex,
      expired: Date.parse(payload.expiresAt) <= Date.now(),
    };
  }
  artifact(path: string) {
    const m = /^\/cc-host\/v2\/agent-artifacts\/([a-f0-9]{64})\.tar\.gz$/.exec(path);
    if (!m) return undefined;
    const meta = join(this.root, 'artifacts', m[1] + '.json');
    if (!existsSync(meta)) return undefined;
    const p = verifyAgentIndex(readRegular(meta, 128 * 1024), this.keys, true);
    need(p.archive.sha256 === m[1], 'Artifact metadata mismatch');
    const bytes = readRegular(join(this.root, 'artifacts', m[1] + '.tar.gz'), compressed);
    verifyAgentArchive(bytes, p);
    return bytes;
  }
  publish(index: Buffer, archive: Buffer) {
    assertSafeDirectory(this.root, true);
    chmodSync(this.root, 0o755);
    const lockPath = join(this.root, '.publication.sqlite');
    const lock = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    try {
      // An uncommitted SQLite transaction is released by the OS on publisher exit.
      lock.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER);');
      const p = verifyAgentIndex(index, this.keys),
        old = this.status();
      if (old)
        need(
          p.version >= old.payload.version &&
            (p.version !== old.payload.version ||
              canonicalAgent({ ...p, issuedAt: '', expiresAt: '' }) ===
                canonicalAgent({ ...old.payload, issuedAt: '', expiresAt: '' })),
          'Agent rollback or equivocation',
        );
      verifyAgentArchive(archive, p);
      const dir = join(this.root, 'artifacts');
      assertSafeDirectory(dir, true);
      chmodSync(dir, 0o755);
      const immutable = (path: string, bytes: Buffer) => {
        if (existsSync(path)) {
          need(readRegular(path, compressed).equals(bytes), 'Immutable agent substitution');
          return;
        }
        this.write(path, bytes);
      };
      immutable(join(dir, p.archive.sha256 + '.tar.gz'), archive);
      const metadata = join(dir, p.archive.sha256 + '.json');
      if (!existsSync(metadata)) immutable(metadata, index);
      this.write(join(this.root, 'index.json'), index);
    } finally {
      lock.close();
    }
  }
  private write(path: string, bytes: Buffer) {
    const tmp = path + '.' + randomUUID() + '.part';
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      try {
        writeFileSync(fd, bytes);
        fchmodSync(fd, 0o644);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      syncDirectory(join(path, '..'));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
