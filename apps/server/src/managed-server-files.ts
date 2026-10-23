import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_FILES,
  parseDescriptor,
  requireValue,
  sha256,
  validArchivePath,
  type ServerDescriptor,
  type ServerRelease,
} from '../../../packages/managed-server/src/index.ts';

export function assertSafeDirectory(path: string, create = false) {
  const absolute = resolve(path),
    root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      requireValue(create, 'Missing state directory');
      mkdirSync(current, { mode: 0o700 });
      syncDirectory(dirname(current));
    }
    const stat = lstatSync(current);
    requireValue(
      !stat.isSymbolicLink() && stat.isDirectory(),
      'Symlink or non-directory state path rejected',
    );
  }
  return absolute;
}
export function readRegular(path: string, max = MAX_EXPANDED_BYTES) {
  assertSafeDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isFile() && stat.size <= max, 'Non-file or file too large');
    const bytes = readFileSync(fd);
    requireValue(bytes.length <= max, 'File too large');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function durableWrite(path: string, value: unknown) {
  assertSafeDirectory(dirname(path), true);
  if (existsSync(path))
    requireValue(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      'Unsafe state file',
    );
  const temporary = `${path}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}
type Expected = Pick<
  ServerRelease,
  'build' | 'appVersion' | 'protocol' | 'sourceCommit' | 'descriptorSha256'
>;
function descriptor(bytes: Buffer, release: Expected) {
  requireValue(sha256(bytes) === release.descriptorSha256, 'Descriptor digest mismatch');
  const d = parseDescriptor(bytes);
  for (const field of ['build', 'appVersion', 'protocol', 'sourceCommit'] as const)
    requireValue(d[field] === release[field], 'Descriptor release mismatch');
  return d;
}
function verifyFiles(files: Map<string, Buffer>, d: ServerDescriptor) {
  requireValue(files.size === Object.keys(d.files).length + 1, 'Archive inventory mismatch');
  for (const [path, entry] of Object.entries(d.files)) {
    const bytes = files.get(path);
    requireValue(
      bytes && bytes.length === entry.size && sha256(bytes) === entry.sha256,
      `Inventory digest mismatch: ${path}`,
    );
  }
}
export function verifyReleaseDirectory(root: string, release: Expected) {
  assertSafeDirectory(root);
  const d = descriptor(readRegular(join(root, 'SERVER-RELEASE.json'), 4 * 1024 * 1024), release);
  const found = new Set<string>();
  let total = 0;
  function walk(prefix = '') {
    for (const name of readdirSync(join(root, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name;
      requireValue(validArchivePath(path), 'Unsafe installed path');
      const stat = lstatSync(join(root, path));
      requireValue(!stat.isSymbolicLink(), 'Installed symlink rejected');
      if (stat.isDirectory()) walk(path);
      else {
        requireValue(stat.isFile(), 'Installed non-file rejected');
        if (path === 'SERVER-RELEASE.json') continue;
        const entry = d.files[path];
        requireValue(entry && stat.size === entry.size, 'Installed inventory mismatch');
        total += stat.size;
        requireValue(
          total <= MAX_EXPANDED_BYTES && found.size < MAX_FILES,
          'Installed release too large',
        );
        requireValue(
          sha256(readRegular(join(root, path), entry.size)) === entry.sha256,
          `Installed digest mismatch: ${path}`,
        );
        found.add(path);
      }
    }
  }
  walk();
  requireValue(found.size === Object.keys(d.files).length, 'Installed inventory missing file');
  return d;
}
function textField(buffer: Buffer) {
  const zero = buffer.indexOf(0);
  const bytes = zero < 0 ? buffer : buffer.subarray(0, zero);
  requireValue(
    [...bytes].every((b) => b >= 32 && b <= 126),
    'Invalid tar text',
  );
  return bytes.toString('ascii');
}
function octal(buffer: Buffer) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  requireValue(/^[0-7]+$/.test(text), 'Invalid tar integer');
  const n = parseInt(text, 8);
  requireValue(Number.isSafeInteger(n), 'Tar overflow');
  return n;
}
export function extractRelease(
  archive: Buffer,
  destination: string,
  release: Expected & Pick<ServerRelease, 'size' | 'sha256'>,
) {
  requireValue(
    archive.length === release.size &&
      archive.length <= MAX_ARCHIVE_BYTES &&
      sha256(archive) === release.sha256,
    'Archive digest mismatch',
  );
  const bytes = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  const files = new Map<string, Buffer>();
  let offset = 0,
    ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) {
      requireValue(
        bytes.subarray(offset).every((b) => b === 0),
        'Tar trailing data',
      );
      ended = true;
      break;
    }
    const expected = octal(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    requireValue(
      checksum === expected && header.subarray(257, 263).equals(Buffer.from('ustar\0')),
      'Invalid ustar header',
    );
    requireValue(
      header[156] === 48 || header[156] === 0,
      'Tar links, directories and extended headers forbidden',
    );
    const prefix = textField(header.subarray(345, 500)),
      name = textField(header.subarray(0, 100));
    const path = prefix ? `${prefix}/${name}` : name;
    requireValue(
      validArchivePath(path) && !path.split('/').includes('node_modules') && !files.has(path),
      'Unsafe or duplicate archive path',
    );
    const size = octal(header.subarray(124, 136));
    requireValue(
      size <= MAX_EXPANDED_BYTES && offset + size <= bytes.length && files.size <= MAX_FILES,
      'Truncated or oversized archive',
    );
    files.set(path, bytes.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  requireValue(
    ended && files.has('SERVER-RELEASE.json'),
    'Missing archive descriptor or end marker',
  );
  const d = descriptor(files.get('SERVER-RELEASE.json')!, release);
  verifyFiles(files, d);
  requireValue(!existsSync(destination), 'Stage directory already exists');
  assertSafeDirectory(dirname(destination), true);
  const staging = mkdtempSync(join(dirname(destination), '.staging-'));
  for (const [path, content] of files) {
    const target = join(staging, path);
    assertSafeDirectory(dirname(target), true);
    const fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  // Sync nested directories before the durable journal may refer to this release.
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    let directory = dirname(join(staging, path));
    while (directory !== staging) {
      dirs.add(directory);
      directory = dirname(directory);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) syncDirectory(dir);
  syncDirectory(staging);
  verifyReleaseDirectory(staging, release);
  // A killed writer leaves only an unreferenced staging directory, never a partial final release.
  renameSync(staging, destination);
  syncDirectory(dirname(destination));
  return d;
}
