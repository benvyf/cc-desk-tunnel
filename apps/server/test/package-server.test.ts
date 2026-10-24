import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { extractRelease, verifyReleaseDirectory } from '../src/managed-server-files.ts';

const { packageServer } = await import(
  new URL('../../../scripts/package-server.mjs', import.meta.url).href
);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

test('server archives contain a fresh Web build without local data or desktop development files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-server-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'apps/server/package.json',
    'apps/server/src',
    'apps/desktop/package.json',
    'packages/protocol/package.json',
    'packages/protocol/src',
    'scripts/install-linux.sh',
    'deploy',
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path), { recursive: true });
  }
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  put('apps/server/src/main.ts', 'export {};');
  put('packages/managed-server/src/index.ts', 'export {};');
  put('deploy/managed-server.json', '{"build":1}');
  put('.gitignore', 'node_modules/\n.local/\n.env\n*.local.json\n');
  put('apps/desktop/dist/index.html', 'desktop build stays unchanged');
  put('apps/desktop/src/private-test.ts', 'not runtime code');
  put('.env', 'local-secret');
  put(
    'node_modules/vite/bin/vite.js',
    `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const directory=process.argv[process.argv.indexOf('--outDir')+1];
    mkdirSync(join(directory,'assets'),{recursive:true});
    writeFileSync(join(directory,'index.html'),'<script src="./assets/current.js"></script>');
    writeFileSync(join(directory,'assets/current.js'),'fresh web build');
  `,
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Release Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  put('deploy/private.local.json', '{"fixture":"never release this ignored file"}');
  const output = join(directory, '.local/server.tar.gz');
  packageServer(directory, output);
  const entries = execFileSync(tar, ['-tzf', output], {
    encoding: 'utf8',
    windowsHide: true,
  }).split(/\r?\n/);
  assert.ok(entries.includes('apps/server/web/index.html'));
  assert.ok(entries.includes('apps/server/web/assets/current.js'));
  assert.ok(entries.includes('CHANGELOG.md'));
  assert.ok(entries.includes('deploy/install.sh'));
  assert.ok(
    entries.includes('SERVER-RELEASE.json'),
    'paired server archive needs a release inventory',
  );
  assert.ok(
    !entries.some((entry) => entry.endsWith('/')),
    'release archive only contains regular files',
  );
  assert.ok(entries.includes('packages/managed-server/src/index.ts'));
  for (const path of [
    'apps/server/src/account-presentation.ts',
    'packages/protocol/src/account-display.ts',
    'packages/protocol/src/account-number.ts',
  ])
    assert.ok(entries.includes(path), `Server archive omits account display dependency: ${path}`);
  assert.ok(!entries.includes('deploy/private.local.json'));
  const descriptorBytes = execFileSync(tar, ['-xOzf', output, 'SERVER-RELEASE.json'], {
    windowsHide: true,
  });
  const descriptor = JSON.parse(descriptorBytes.toString());
  assert.equal(descriptor.build, 1);
  assert.equal(descriptor.protocol, 20);
  assert.equal(descriptor.sourceCommit, git('rev-parse', 'HEAD').toString().trim());
  const main = execFileSync(tar, ['-xOzf', output, 'apps/server/src/main.ts'], {
    windowsHide: true,
  });
  assert.deepEqual(descriptor.files['apps/server/src/main.ts'], {
    size: main.length,
    sha256: createHash('sha256').update(main).digest('hex'),
  });
  const archive = readFileSync(output);
  const tarBytes = gunzipSync(archive);
  for (let offset = 0; tarBytes[offset];) {
    const header = tarBytes.subarray(offset, offset + 512);
    assert.equal(
      parseInt(header.subarray(100, 108).toString(), 8),
      0o644,
      'Released files must not be group/world writable even when packaged on Windows',
    );
    assert.equal(parseInt(header.subarray(108, 116).toString(), 8), 0, 'Released owner is root');
    assert.equal(parseInt(header.subarray(116, 124).toString(), 8), 0, 'Released group is root');
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const release = {
    ...descriptor,
    descriptorSha256: createHash('sha256').update(descriptorBytes).digest('hex'),
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.length,
  };
  const extracted = join(directory, '.local/verified-release');
  assert.deepEqual(extractRelease(archive, extracted, release), descriptor);
  assert.deepEqual(verifyReleaseDirectory(extracted, release), descriptor);
  rmSync(extracted, { recursive: true, force: true });
  assert.ok(!entries.some((entry) => /node_modules|\.env|private-test|desktop\/dist/.test(entry)));
  assert.equal(
    readFileSync(join(directory, 'apps/desktop/dist/index.html'), 'utf8'),
    'desktop build stays unchanged',
  );
  assert.deepEqual(readdirSync(join(directory, '.local')), ['server.tar.gz']);
  const previous = readFileSync(output);
  const builder = readFileSync(join(directory, 'node_modules/vite/bin/vite.js'), 'utf8');
  put('node_modules/vite/bin/vite.js', builder + "\nwriteFileSync('package.json','{}');\n");
  assert.throws(() => packageServer(directory, output), /worktree changed/i);
  assert.deepEqual(readFileSync(output), previous);
  git('restore', '--', 'package.json');
  put('node_modules/vite/bin/vite.js', 'process.exit(1);');
  assert.throws(() => packageServer(directory, output));
  assert.deepEqual(readFileSync(output), previous);
  assert.deepEqual(readdirSync(join(directory, '.local')), ['server.tar.gz']);
  assert.equal(existsSync(join(directory, 'apps/server/web')), false);
});
