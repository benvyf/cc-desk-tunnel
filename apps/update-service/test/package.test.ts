import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { packageUpdateService, runtimeFiles } = await import(
  new URL('../../../scripts/package-update-service.mjs', import.meta.url).href
);
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('the packaged update service imports its complete runtime without workspace dependencies', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'cc-update-package-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = join(scratch, 'source');
  for (const file of runtimeFiles) {
    const target = join(source, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, windowsHide: true, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Package Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  const archive = join(scratch, 'runtime.tar.gz');
  const info = await packageUpdateService(source, archive);
  const extracted = join(scratch, 'extracted');
  mkdirSync(extracted);
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xzf', archive, '-C', extracted],
    { windowsHide: true, stdio: 'pipe' },
  );
  for (const [file, hash] of Object.entries(info.files))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(extracted, file)))
        .digest('hex'),
      hash,
    );
  // Import the real HTTP entry and its dependencies, without opening a port or reading configuration.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'await import(process.argv[1]);',
      pathToFileURL(join(extracted, 'apps/update-service/src/http.ts')).href,
    ],
    { cwd: extracted, windowsHide: true, stdio: 'pipe' },
  );
});
