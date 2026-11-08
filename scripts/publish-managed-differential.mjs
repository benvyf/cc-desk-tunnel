import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ARTIFACT_BYTES,
  MAX_INDEX_BYTES,
  verifyIndex,
} from '../packages/managed-updates/src/index.ts';
import contract from '../apps/desktop/electron/managed-differential-contract.cjs';

const { signDescriptor, verifyDescriptor, decodeBlockmap, descriptorPath, blockmapPath } = contract;
const MAX_BLOCKMAP_BYTES = 4 * 1024 * 1024;
const usage =
  'node scripts/publish-managed-differential.mjs --source CLEAN_GIT --index SIGNED_V1_JSON --blockmap LOCAL_GZIP --private-key EXTERNAL_KEY --key-id ID --public-root ROOT [--artifact SOURCE_EXE]';
function check(value) {
  if (!value) throw new Error('Differential publication validation failed');
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
// Validate the spelling supplied by the caller before realpath can erase links/junctions.
async function safePath(input, kind, allowMissing = false) {
  const path = resolve(input);
  const root = parse(path).root;
  let current = root;
  const parts = relative(root, path).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return path;
      throw error;
    }
    check(!info.isSymbolicLink());
    check(relative(current, await realpath(current)) === '');
    if (i < parts.length - 1 || kind === 'directory') check(info.isDirectory());
    else check(info.isFile() && info.nlink === 1);
  }
  return path;
}
async function safeOpen(path) {
  await safePath(path, 'file');
  const before = await lstat(path, { bigint: true });
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat({ bigint: true });
    check(
      opened.isFile() &&
        opened.nlink === 1n &&
        opened.dev === before.dev &&
        opened.ino === before.ino,
    );
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function readLimited(path, limit) {
  const file = await safeOpen(path);
  try {
    const before = await file.stat({ bigint: true });
    check(before.size <= BigInt(limit));
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    check(
      total <= limit &&
        BigInt(total) === before.size &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
    );
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
}
function git(source, ...args) {
  return execFileSync('git', args, {
    cwd: source,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function sourceIdentity(source, release, channel) {
  await safePath(source, 'directory');
  check(relative(source, await realpath(git(source, 'rev-parse', '--show-toplevel'))) === '');
  check(git(source, 'status', '--porcelain', '--untracked-files=normal') === '');
  check(git(source, 'rev-parse', 'HEAD') === release.sourceCommit);
  const manifest = JSON.parse(git(source, 'show', 'HEAD:apps/desktop/package.json'));
  check(manifest.version === release.appVersion);
  const match = /^export const PROTOCOL_VERSION = (\d+);$/m.exec(
    git(source, 'show', 'HEAD:packages/protocol/src/index.ts').replace(/\r/g, ''),
  );
  check(match && Number(match[1]) === release.protocol);
  const identity = JSON.parse(git(source, 'show', 'HEAD:deploy/managed-client.json'));
  check(
    identity.build === release.build &&
      identity.channel === channel &&
      identity.product === 'cc-desk-tunnel-managed',
  );
  return identity;
}
async function hashInstaller(path, release) {
  const file = await safeOpen(path);
  try {
    const before = await file.stat({ bigint: true });
    check(
      before.size > 0n &&
        before.size <= BigInt(MAX_ARTIFACT_BYTES) &&
        before.size === BigInt(release.size),
    );
    const sha256 = createHash('sha256');
    const sha512 = createHash('sha512');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      check(size <= release.size);
      sha256.update(chunk);
      sha512.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    check(
      size === release.size &&
        sha256.digest('hex') === release.sha256 &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        after.nlink === 1n,
    );
    return sha512.digest('base64');
  } finally {
    await file.close();
  }
}
function publicFile(root, coordinate) {
  const prefix = '/cc-updates/v1/';
  check(coordinate.startsWith(prefix));
  const path = resolve(root, coordinate.slice(prefix.length));
  check(inside(root, path));
  return path;
}
async function preflight(path, bytes) {
  await safePath(path, 'file', true);
  try {
    check((await readLimited(path, bytes.length)).equals(bytes));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function publishImmutable(path, bytes) {
  if (await preflight(path, bytes)) return;
  await mkdir(dirname(path), { recursive: true });
  await safePath(dirname(path), 'directory');
  const temporary = join(dirname(path), `.differential-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o644);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // Hard-link creation is exclusive and atomically exposes only fully synced bytes.
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check(await preflight(path, bytes));
    }
  } finally {
    await unlink(temporary);
  }
  await syncDirectory(dirname(path));
  await safePath(path, 'file');
}

async function publishInstaller(path, source, release, sha512) {
  await safePath(path, 'file', true);
  await mkdir(dirname(path), { recursive: true });
  await safePath(dirname(path), 'directory');
  const temporary = join(dirname(path), `.installer-${randomUUID()}.tmp`);
  const input = await safeOpen(source);
  let output;
  let copied = false;
  try {
    output = await open(temporary, 'wx', 0o644);
    let total = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      total += chunk.length;
      check(total <= release.size);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
        check(bytesWritten > 0);
        offset += bytesWritten;
      }
    }
    check(total === release.size);
    await output.sync();
    copied = true;
  } finally {
    await input.close();
    await output?.close();
    if (output && !copied) await unlink(temporary);
  }
  try {
    check((await hashInstaller(temporary, release)) === sha512);
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      check((await hashInstaller(path, release)) === sha512);
    }
  } finally {
    await unlink(temporary);
  }
  await syncDirectory(dirname(path));
  await safePath(path, 'file');
}

export async function publishDifferential(args) {
  for (const name of ['source', 'index', 'blockmap', 'private-key', 'key-id', 'public-root'])
    check(typeof args[name] === 'string' && args[name]);
  const source = await safePath(args.source, 'directory');
  const publicRoot = await safePath(args['public-root'], 'directory');
  const privatePath = await safePath(args['private-key'], 'file');
  check(!inside(source, privatePath) && !inside(publicRoot, privatePath));
  const indexBytes = await readLimited(args.index, MAX_INDEX_BYTES);
  const envelope = JSON.parse(indexBytes);
  check(envelope.keyId === args['key-id']);
  // Inspect only coordinates first; no artifact access occurs until the complete v1 verifier succeeds.
  const untrusted = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  const identity = await sourceIdentity(source, untrusted.release, untrusted.channel);
  const { payload } = verifyIndex(indexBytes, identity.trustedKeys);
  check(payload.state === 'published' && payload.release);
  const release = payload.release;
  const key = createPrivateKey(await readLimited(privatePath, 16 * 1024));
  check(key.asymmetricKeyType === 'ed25519' && Object.hasOwn(identity.trustedKeys, args['key-id']));
  check(
    createPublicKey(key).export({ type: 'spki', format: 'pem' }) ===
      createPublicKey(identity.trustedKeys[args['key-id']]).export({ type: 'spki', format: 'pem' }),
  );
  const installer = publicFile(
    publicRoot,
    `/cc-updates/v1/artifacts/${release.build}/win32-x64/${release.filename}`,
  );
  if (args.artifact !== undefined) check(typeof args.artifact === 'string' && args.artifact);
  const sha512 = await hashInstaller(args.artifact || installer, release);
  let installerExists = true;
  if (args.artifact) {
    try {
      check((await hashInstaller(installer, release)) === sha512);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      installerExists = false;
    }
    await safePath(installer, 'file', true);
  }
  const mapBytes = await readLimited(args.blockmap, MAX_BLOCKMAP_BYTES);
  const { notes: _notes, ...tuple } = release;
  const descriptor = {
    schema: 1,
    product: 'cc-space-nsis-differential',
    channel: payload.channel,
    platform: 'win32',
    arch: 'x64',
    release: tuple,
    sha512,
    blockmap: {
      size: mapBytes.length,
      sha256: createHash('sha256').update(mapBytes).digest('hex'),
      format: 'gzip-json-v2',
    },
  };
  // Validates format, bounds and total size. Chunk Blake checksums are builder output;
  // the independently signed full installer hashes remain the final execution gate.
  decodeBlockmap(mapBytes, descriptor);
  const signed = signDescriptor(descriptor, args['key-id'], key);
  verifyDescriptor(signed, identity.trustedKeys, release, payload.channel);
  const descriptorCoordinate = descriptorPath(release);
  const mapCoordinate = blockmapPath(release);
  const descriptorFile = publicFile(publicRoot, descriptorCoordinate);
  const mapFile = publicFile(publicRoot, mapCoordinate);
  // Reject either contradiction before exposing either sidecar.
  await preflight(descriptorFile, signed);
  await preflight(mapFile, mapBytes);
  await sourceIdentity(source, release, payload.channel);
  if (!installerExists) await publishInstaller(installer, args.artifact, release, sha512);
  await publishImmutable(mapFile, mapBytes);
  await publishImmutable(descriptorFile, signed);
  // The original service must chmod/fsync its artifact during activation.
  // A root signer inherits the established public-root service owner, while
  // explicit public modes also survive a protected administrator umask.
  if (process.platform !== 'win32') {
    const owner = await lstat(publicRoot);
    for (const path of [
      dirname(dirname(installer)),
      dirname(installer),
      installer,
      mapFile,
      descriptorFile,
    ]) {
      const directory = path === dirname(installer) || path === dirname(dirname(installer));
      await safePath(path, directory ? 'directory' : 'file');
      const info = await lstat(path);
      if (process.getuid() === 0 && (info.uid !== owner.uid || info.gid !== owner.gid))
        await chown(path, owner.uid, owner.gid);
      const mode = directory ? 0o755 : 0o644;
      // Renewal runs in a read-only sandbox: correct public assets need no writes.
      if ((info.mode & 0o7777) !== mode) await chmod(path, mode);
    }
  }
  return {
    build: release.build,
    channel: payload.channel,
    descriptorPath: descriptorCoordinate,
    blockmapPath: mapCoordinate,
    size: release.size,
    sha256: release.sha256,
    sha512,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === '--help') console.log(usage);
    else {
      const args = Object.create(null);
      const allowed = new Set([
        'source',
        'index',
        'blockmap',
        'private-key',
        'key-id',
        'public-root',
        'artifact',
      ]);
      for (let i = 0; i < argv.length; i += 2) {
        const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
        check(
          allowed.has(name) &&
            !Object.hasOwn(args, name) &&
            argv[i + 1] &&
            !argv[i + 1].startsWith('--'),
        );
        args[name] = argv[i + 1];
      }
      console.log(JSON.stringify(await publishDifferential(args)));
    }
  } catch {
    // Never expose private paths/key material, untrusted JSON, Git output or raw errors.
    console.error(
      'Differential publication failed: arguments, source, signed index, key, artifact or immutable metadata validation failed.',
    );
    process.exitCode = 1;
  }
}
