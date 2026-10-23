import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  buildDescriptor,
  COMPATIBILITY_PATHS,
  sha256,
} from '../../../packages/managed-server/src/index.ts';
import {
  extractRelease,
  verifyReleaseDirectory,
  assertSafeDirectory,
} from '../src/managed-server-files.ts';

export function tar(files: Record<string, Buffer | string>, link = false) {
  const blocks: Buffer[] = [];
  for (const [path, value] of Object.entries(files)) {
    const bytes = Buffer.from(value),
      header = Buffer.alloc(512);
    header.write(path);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = link ? 50 : 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
export function releaseFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'managed-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = Object.fromEntries(
    [
      'package.json',
      'package-lock.json',
      'apps/server/src/managed-main.ts',
      'packages/protocol/package.json',
      ...COMPATIBILITY_PATHS,
    ].map((p) => [
      p,
      p === 'package.json'
        ? '{"type":"module"}'
        : p === 'packages/protocol/src/index.ts'
          ? 'export const PROTOCOL_VERSION = 42;\n'
          : p,
    ]),
  );
  for (const [p, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), bytes);
  }
  const descriptor = buildDescriptor(root, {
    build: 2,
    appVersion: '0.2.11',
    protocol: 42,
    sourceCommit: 'a'.repeat(40),
  });
  const descriptorBytes = JSON.stringify(descriptor);
  return {
    root,
    files: { ...files, 'SERVER-RELEASE.json': descriptorBytes },
    descriptor,
    descriptorBytes,
  };
}
test('bounded file-only archive stages exact signed inventory; rejects tampering, traversal, links and extras', (t) => {
  const f = releaseFixture(t),
    archive = tar(f.files);
  const release = {
    ...f.descriptor,
    size: archive.length,
    sha256: sha256(archive),
    descriptorSha256: sha256(f.descriptorBytes),
  };
  const destination = join(f.root, 'stage');
  extractRelease(archive, destination, release);
  assert.equal(
    readFileSync(join(destination, 'apps/server/src/store.ts'), 'utf8'),
    'apps/server/src/store.ts',
  );
  verifyReleaseDirectory(destination, release);
  writeFileSync(join(destination, 'apps/server/src/store.ts'), 'tampered');
  assert.throws(() => verifyReleaseDirectory(destination, release), /digest|inventory/i);
  for (const bytes of [
    tar({ ...f.files, '../evil': 'evil' }),
    tar(f.files, true),
    tar({ ...f.files, extra: 'evil' }),
    tar({ ...f.files, 'apps/server/src/store.ts': 'bad' }),
  ]) {
    assert.throws(() =>
      extractRelease(bytes, join(f.root, 'bad'), {
        ...release,
        size: bytes.length,
        sha256: sha256(bytes),
      }),
    );
  }
});
test('state roots never follow symlinks', (t) => {
  const f = releaseFixture(t),
    target = join(f.root, 'target');
  mkdirSync(target);
  const link = join(f.root, 'linked');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertSafeDirectory(join(link, 'child'), true), /symlink/i);
});

test('process death during extraction never publishes a partial final directory', (t) => {
  const f = releaseFixture(t),
    archive = tar(f.files);
  const release = {
    ...f.descriptor,
    size: archive.length,
    sha256: sha256(archive),
    descriptorSha256: sha256(f.descriptorBytes),
  };
  const destination = join(f.root, 'atomic-release');
  const moduleUrl = new URL('../src/managed-server-files.ts', import.meta.url).href;
  const killed = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const {extractRelease} = await import(${JSON.stringify(moduleUrl)});
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const write = fs.writeFileSync;
    fs.writeFileSync = (...args) => { write(...args); process.exit(93); };
    syncBuiltinESMExports();
    extractRelease(Buffer.from(input.archive,'base64'), input.destination, input.release);
  `,
    ],
    {
      input: JSON.stringify({ archive: archive.toString('base64'), destination, release }),
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    },
  );
  assert.equal(killed.status, 93, killed.stderr);
  assert.equal(existsSync(destination), false);
  extractRelease(archive, destination, release);
  verifyReleaseDirectory(destination, release);
});
