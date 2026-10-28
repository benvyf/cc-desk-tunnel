// Linux publication has its own directory and trust identity. Never mutates Windows stores.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { deflateSync, gunzipSync } from 'node:zlib';
import {
  assertSafeDirectory,
  extractRelease,
  readRegular,
  syncDirectory,
} from '../../server/src/managed-server-files.ts';
import {
  compatibility,
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_INDEX_BYTES,
  parseDescriptor,
  RUNTIME_LEVEL,
  releaseFilename,
  requireValue,
  sha256,
  verifyServerIndex,
  type KeyInput,
  type ServerRelease,
  type ServerPayload,
} from '../../../packages/managed-server/src/index.ts';
import { isDeepStrictEqual } from 'node:util';

export const SERVER_INDEX_PATH = '/cc-updates/server/v1/channels/pilot/linux-x64.json';
export const BOOTSTRAP_PATH = '/cc-updates/admin/server-bootstrap.py';
const origin = 'https://api.ghostapi.org';
export function renewalPayload(
  payload: ServerPayload,
  expectedRelease: ServerRelease,
  now = Date.now(),
  force = false,
) {
  requireValue(
    isDeepStrictEqual(payload.release, expectedRelease),
    'Linux release differs from renewal registration',
  );
  if (!force && Date.parse(payload.expiresAt) - now > 2 * 86400000) return undefined;
  return {
    ...payload,
    revision: payload.revision + 1,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 14 * 86400000).toISOString(),
  };
}
function optional(path: string, limit: number) {
  if (!existsSync(path)) return undefined;
  requireValue(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    'Unsafe distribution file',
  );
  return readRegular(path, limit);
}
function immutable(path: string, bytes: Buffer) {
  const old = optional(path, MAX_ARCHIVE_BYTES);
  if (old) {
    requireValue(old.equals(bytes), 'Immutable build substitution rejected');
    return;
  }
  const fd = openSync(path, 'wx', 0o644);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, 0o644);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(join(path, '..'));
}
export function releaseFromArchive(archive: Buffer): ServerRelease {
  requireValue(archive.length <= MAX_ARCHIVE_BYTES, 'Archive too large');
  const raw = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  let db: Buffer | undefined;
  // Read only descriptor bytes here; extractRelease below validates every header, path and inventory.
  for (let offset = 0; offset + 512 <= raw.length;) {
    const h = raw.subarray(offset, offset + 512);
    offset += 512;
    if (h.every((b) => b === 0)) break;
    const field = h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    requireValue(/^[0-7]+$/.test(field), 'Invalid archive size');
    const size = parseInt(field, 8);
    requireValue(size <= MAX_EXPANDED_BYTES && offset + size <= raw.length, 'Archive bounds');
    if (h.subarray(0, 100).toString('ascii').replace(/\0.*$/, '') === 'SERVER-RELEASE.json')
      db = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  requireValue(db, 'Missing descriptor');
  const d = parseDescriptor(db);
  const root = mkdtempSync(join(tmpdir(), 'cc-server-publication-'));
  try {
    const r = {
      build: d.build,
      appVersion: d.appVersion,
      protocol: d.protocol,
      sourceCommit: d.sourceCommit,
      size: archive.length,
      sha256: sha256(archive),
      descriptorSha256: sha256(db),
    };
    const program = join(root, 'program');
    extractRelease(archive, program, r);
    return {
      ...r,
      packageLockSha256: sha256(readRegular(join(program, 'package-lock.json'))),
      runtimeLevel: RUNTIME_LEVEL,
      compatibility: compatibility(program),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export class ServerDistribution {
  readonly root: string;
  readonly keys: Record<string, KeyInput>;
  constructor(dataDir: string, keys: Record<string, KeyInput>) {
    this.root = join(dataDir, 'server');
    this.keys = keys;
  }
  index() {
    if (!existsSync(this.root)) return undefined;
    assertSafeDirectory(this.root);
    const bytes = optional(join(this.root, 'index.json'), MAX_INDEX_BYTES);
    if (bytes) verifyServerIndex(bytes, { keys: this.keys, installed: true });
    return bytes;
  }
  status() {
    const bytes = this.index();
    if (!bytes) return { published: false as const };
    const { payload } = verifyServerIndex(bytes, { keys: this.keys, installed: true });
    return {
      published: true as const,
      payload,
      expired: Date.parse(payload.expiresAt) <= Date.now(),
      downloadPath: this.path(payload.release),
    };
  }
  path(r: ServerRelease) {
    return `/cc-updates/server/v1/artifacts/${r.build}/linux-x64/${releaseFilename(r)}`;
  }
  artifact(path: string) {
    const match =
      /^\/cc-updates\/server\/v1\/artifacts\/([1-9][0-9]*)\/linux-x64\/(cc-desk-tunnel-server-[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-zA-Z0-9.]{1,40})?-build[1-9][0-9]*\.tar\.gz)$/.exec(
        path,
      );
    if (!match || !Number.isSafeInteger(Number(match[1]))) return undefined;
    const folder = join(this.root, 'artifacts', match[1]!);
    if (!existsSync(folder)) return undefined;
    const metadata = optional(join(folder, 'release.json'), MAX_INDEX_BYTES);
    if (!metadata) return undefined;
    const { payload } = verifyServerIndex(metadata, { keys: this.keys, installed: true });
    if (this.path(payload.release) !== path) return undefined;
    const archive = optional(join(folder, match[2]!), MAX_ARCHIVE_BYTES);
    requireValue(
      archive &&
        archive.length === payload.release.size &&
        sha256(archive) === payload.release.sha256,
      'Published archive damaged',
    );
    return archive;
  }
  publish(index: Buffer, archive: Buffer) {
    assertSafeDirectory(this.root, true);
    // This tree contains public signed bytes only; root CLI publications must remain readable
    // to the existing unprivileged update-service identity.
    chmodSync(this.root, 0o755);
    const lock = join(this.root, '.publication-lock');
    mkdirSync(lock, { mode: 0o700 }); // A crashed publisher fails closed until an administrator removes its lock.
    let stage: string | undefined;
    try {
      const old = this.index();
      const previous = old
        ? verifyServerIndex(old, { keys: this.keys, installed: true })
        : undefined;
      const checked = verifyServerIndex(index, {
        keys: this.keys,
        ...(previous ? { replay: previous.replay } : {}),
      });
      const r = checked.payload.release;
      // A signature renewal must retain every release field, including runtime/compatibility metadata.
      if (previous && previous.payload.release.build === r.build)
        requireValue(
          JSON.stringify(previous.payload.release) === JSON.stringify(r),
          'Renewal changed release',
        );
      stage = mkdtempSync(join(this.root, '.stage-'));
      const program = join(stage, 'program');
      extractRelease(archive, program, r);
      requireValue(
        sha256(readRegular(join(program, 'package-lock.json'))) === r.packageLockSha256,
        'Lockfile mismatch',
      );
      requireValue(
        JSON.stringify(compatibility(program)) === JSON.stringify(r.compatibility),
        'Compatibility mismatch',
      );
      const folder = join(this.root, 'artifacts', String(r.build));
      assertSafeDirectory(folder, true);
      chmodSync(join(this.root, 'artifacts'), 0o755);
      chmodSync(folder, 0o755);
      const saved = optional(join(folder, 'release.json'), MAX_INDEX_BYTES);
      if (saved)
        requireValue(
          JSON.stringify(
            verifyServerIndex(saved, { keys: this.keys, installed: true }).payload.release,
          ) === JSON.stringify(r),
          'Immutable release substitution rejected',
        );
      immutable(join(folder, releaseFilename(r)), archive);
      if (!saved) immutable(join(folder, 'release.json'), index);
      const temporary = join(this.root, `.index-${randomUUID()}.part`);
      const fd = openSync(temporary, 'wx', 0o644);
      try {
        writeFileSync(fd, index);
        fchmodSync(fd, 0o644);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, join(this.root, 'index.json'));
      syncDirectory(this.root);
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
      rmSync(lock, { recursive: true });
    }
  }
}

export function bootstrapCommand(release: ServerRelease, installerHash: string) {
  requireValue(
    Number.isSafeInteger(release.build) &&
      release.build > 0 &&
      /^[a-f0-9]{64}$/.test(release.sha256) &&
      /^[a-f0-9]{64}$/.test(installerHash),
    'Invalid bootstrap identity',
  );
  const program = `import hashlib,pathlib,subprocess,tempfile,urllib.request\nclass NoRedirect(urllib.request.HTTPRedirectHandler):\n def redirect_request(self,*args,**kwargs): return None\nwith urllib.request.build_opener(NoRedirect).open(${JSON.stringify(origin + BOOTSTRAP_PATH)},timeout=30) as r: b=r.read(262145)\nif len(b)>262144 or hashlib.sha256(b).hexdigest()!=${JSON.stringify(installerHash)}: raise SystemExit('Installer verification failed')\nwith tempfile.TemporaryDirectory(prefix='cc-server-bootstrap-') as d:\n p=pathlib.Path(d)/'bootstrap.py';p.write_bytes(b)\n subprocess.run(['python3',str(p),'--build',${JSON.stringify(String(release.build))},'--sha256',${JSON.stringify(release.sha256)}],check=True)\n`;
  return "sudo python3 -c '" + program.replaceAll("'", "'\"'\"'") + "'";
}

export function upgradeCommand(release: ServerRelease, script: Buffer) {
  requireValue(
    Number.isSafeInteger(release.build) &&
      release.build > 0 &&
      Number.isSafeInteger(release.protocol) &&
      release.protocol > 0 &&
      /^[a-f0-9]{64}$/.test(release.sha256),
    'Invalid upgrade identity',
  );
  const target = { build: release.build, sha256: release.sha256, protocol: release.protocol };
  const program = `const target = ${JSON.stringify(target)};\n${script.toString('utf8')}`;
  const encoded = deflateSync(program).toString('base64');
  const loader =
    'eval(require("node:zlib").inflateSync(Buffer.from("' + encoded + '","base64")).toString())';
  const wrapper = `import subprocess,sys,json
program = ${JSON.stringify(loader)}
ids = subprocess.check_output(['docker','ps','--filter','label=com.docker.compose.service=proxy','--format','{{.ID}}'], text=True).split()
candidates = []
for container in ids:
 info = json.loads(subprocess.check_output(['docker','inspect',container], text=True))[0]
 project = (info.get('Config',{}).get('Labels') or {}).get('com.docker.compose.project','')
 if project == 'cc-desk-tunnel' or project.startswith('cc-desk-tunnel-'):
  candidates.append(container)
if len(candidates) != 1:
 raise SystemExit('Expected exactly one running CC Desk Tunnel service container; found '+str(len(candidates))+'. No upgrade requested.')
print('Selected local CC container: '+candidates[0], flush=True)
result = subprocess.run(['docker','exec','-i',candidates[0],'/opt/runtime/node/bin/node','--env-file=/data/config/service.env','--input-type=commonjs','-e',program])
sys.exit(result.returncode)`;
  return `sudo python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(wrapper).toString('base64')}"))'`;
}
