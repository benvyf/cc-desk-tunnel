import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { packageUpdateService, runtimeFiles } from '../../../scripts/package-update-service.mjs';

test('service archive contains only allowlisted runtime files and refuses dirty sources or overwrite', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-update-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  for (const path of runtimeFiles) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), 'runtime fixture');
  }
  await writeFile(join(source, '.gitignore'), 'secret.key\n');
  await writeFile(join(source, 'secret.key'), 'must not enter archive');
  git('init');
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  );
  const archive = join(root, 'service.tar.gz');
  const info = await packageUpdateService(source, archive);
  assert.equal(info.sourceCommit, git('rev-parse', 'HEAD'));
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const files = execFileSync(tar, ['-tzf', archive], { encoding: 'utf8', windowsHide: true });
  assert.doesNotMatch(files, /secret|node_modules|\.git|apps\/server|apps\/desktop/);
  assert.match(files, /BUILD-INFO\.json/);
  const before = await readFile(archive);
  await assert.rejects(packageUpdateService(source, archive));
  assert.deepEqual(await readFile(archive), before);
  await writeFile(join(source, 'dirty.txt'), 'dirty');
  await assert.rejects(packageUpdateService(source, join(root, 'dirty.tar.gz')), /clean/);
});
