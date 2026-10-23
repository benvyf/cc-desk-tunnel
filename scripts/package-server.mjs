import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildDescriptor } from '../packages/managed-server/src/index.ts';

const selected = (path) =>
  [
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'apps/server/package.json',
    'apps/desktop/package.json',
    'packages/protocol/package.json',
    'scripts/install-linux.sh',
  ].includes(path) ||
  ['apps/server/src/', 'packages/protocol/src/', 'packages/managed-server/src/', 'deploy/'].some(
    (prefix) => path.startsWith(prefix),
  );

function normalizeArchiveOwnership(archive) {
  // Windows bsdtar emits 0666 even for files written with mode 0644. Normalize the
  // fixed USTAR metadata before publication so Docker preserves immutable code.
  const bytes = gunzipSync(readFileSync(archive));
  for (let offset = 0; bytes[offset];) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.length !== 512 || ![0, 48].includes(header[156]))
      throw new Error('Only regular USTAR release files are allowed.');
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length)
      throw new Error('Malformed USTAR release file.');
    for (const [position, value] of [
      [100, 0o644],
      [108, 0],
      [116, 0],
    ])
      header.write(value.toString(8).padStart(7, '0') + '\0', position, 8, 'ascii');
    header.fill(0, 265, 329);
    header.write('root', 265, 4, 'ascii');
    header.write('root', 297, 4, 'ascii');
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  writeFileSync(archive, gzipSync(bytes));
}

export function packageServer(root, output) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (git('status', '--porcelain', '--untracked-files=normal').toString().trim())
    throw new Error('Server releases require a clean Git worktree.');
  const sourceCommit = git('rev-parse', 'HEAD').toString().trim();
  const config = JSON.parse(git('show', 'HEAD:deploy/managed-server.json'));
  const { version: appVersion } = JSON.parse(git('show', 'HEAD:apps/desktop/package.json'));
  const source = git('show', 'HEAD:packages/protocol/src/index.ts').toString();
  const protocol = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(source)?.[1]);
  const local = join(root, '.local');
  mkdirSync(local, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(local, 'server-package-'));
  const program = join(staging, 'program');
  const temporaryOutput = join(dirname(output), `.${randomUUID()}.server.part`);
  try {
    const files = git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean);
    for (const entry of files) {
      const [metadata, path] = entry.split('\t');
      if (!selected(path)) continue;
      if (!/^100(?:644|755) /.test(metadata))
        throw new Error('Server source must contain regular files only.');
      mkdirSync(dirname(join(program, path)), { recursive: true });
      // Export committed bytes: neither private untracked files nor Windows newline conversion enter a release.
      writeFileSync(join(program, path), git('show', `HEAD:${path}`), { mode: 0o644 });
    }
    const web = join(program, 'apps/server/web');
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        join(root, 'apps/desktop/vite.config.ts'),
        '--outDir',
        web,
        '--emptyOutDir',
      ],
      { cwd: root, windowsHide: true, stdio: 'inherit' },
    );
    if (!existsSync(join(web, 'index.html'))) throw new Error('Missing Web client build.');
    if (
      git('rev-parse', 'HEAD').toString().trim() !== sourceCommit ||
      git('status', '--porcelain', '--untracked-files=normal').toString().trim()
    )
      throw new Error('Server source worktree changed during the Web build.');
    const descriptor = buildDescriptor(program, {
      build: config.build,
      appVersion,
      protocol,
      sourceCommit,
    });
    writeFileSync(
      join(program, 'SERVER-RELEASE.json'),
      JSON.stringify(descriptor, null, 2) + '\n',
      {
        mode: 0o644,
      },
    );
    const list = join(staging, 'files.txt');
    writeFileSync(
      list,
      [...Object.keys(descriptor.files), 'SERVER-RELEASE.json'].sort().join('\n') + '\n',
    );
    const archive = join(staging, 'server.tar.gz');
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['--format=ustar', '--no-recursion', '-czf', archive, '-C', program, '-T', list],
      { cwd: root, windowsHide: true },
    );
    normalizeArchiveOwnership(archive);
    copyFileSync(archive, temporaryOutput);
    renameSync(temporaryOutput, output);
  } finally {
    rmSync(temporaryOutput, { force: true });
    if (dirname(staging) !== local) throw new Error('Unexpected packaging directory.');
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Server source bundle created: ${output}`);
  console.log(
    'Includes matching Web client and release inventory; no account data or credentials.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  packageServer(root, resolve(process.argv[2] ?? '.local/cc-desk-tunnel-server.tar.gz'));
}
