import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { findGitBash } from '../electron/git-bash.mjs';

const require = createRequire(import.meta.url);
const {
  createGitChanges,
  validRef,
  validPath,
  parseNames,
  parseNumstat,
  parseStatus,
  SCRIPT,
} = require('../electron/git-changes.cjs');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'cc-git-changes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'keep.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'gone.txt'), 'bye\n');
  writeFileSync(join(root, 'old name.txt'), 'rename me\n'.repeat(20));
  writeFileSync(join(root, 'pic.bin'), Buffer.from([0, 1, 2, 3]));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const service = () => createGitChanges({ findShell: () => findGitBash() });

test('names and refs that could be read as options or ranges are refused', () => {
  for (const ref of ['refs/heads/main', 'refs/remotes/origin/feature/x'])
    assert.equal(validRef(ref), true, ref);
  for (const ref of [
    '-x',
    '--output=/tmp/x',
    'main',
    'refs/tags/v1',
    'refs/heads/a..b',
    'refs/heads/main@{1}',
    'refs/heads/-x',
    'refs/heads/a b',
    'refs/heads/x^',
  ])
    assert.equal(validRef(ref), false, ref);
  for (const path of ['a.txt', 'dir/中文 文件.md']) assert.equal(validPath(path), true, path);
  for (const path of ['/etc/passwd', 'C:/x', '../x', 'a/../../b', 'a//b', ''])
    assert.equal(validPath(path), false, path);
});

test('git’s -z records are read with renames, binaries, conflicts and odd paths', () => {
  assert.deepEqual(parseNames('M\0a b.txt\0R087\0old\0new\0D\0gone\0A\0中文\0'), [
    { path: 'a b.txt', status: 'M' },
    { path: 'new', oldPath: 'old', status: 'R' },
    { path: 'gone', status: 'D' },
    { path: '中文', status: 'A' },
  ]);
  const counts = parseNumstat('1\t2\ta b.txt\0-\t-\tpic.bin\0' + '3\t0\t\0old\0new\0');
  assert.deepEqual(counts.get('a b.txt'), { added: 1, deleted: 2 });
  assert.deepEqual(counts.get('pic.bin'), { binary: true });
  assert.deepEqual(counts.get('new'), { added: 3, deleted: 0 });
  const status = parseStatus(
    '? new file.txt\0u UU N... 100644 100644 100644 100644 a b c both.txt\0' +
      '2 R. N... 100644 100644 100644 a b R100 new\0old\0',
  );
  assert.deepEqual(status.untracked, ['new file.txt']);
  assert.deepEqual([...status.conflicts], ['both.txt']);
});

test('the working tree’s changes against HEAD, and a file’s diff on demand', async (t) => {
  const root = repository(t);
  writeFileSync(join(root, 'keep.txt'), 'one\nTWO\nthree\n');
  rmSync(join(root, 'gone.txt'));
  git(root, 'mv', 'old name.txt', 'new name.txt');
  writeFileSync(join(root, 'added.txt'), 'staged\n');
  git(root, 'add', 'added.txt');
  writeFileSync(join(root, 'pic.bin'), Buffer.from([0, 9, 9, 9]));
  mkdirSync(join(root, '新目录'));
  writeFileSync(join(root, '新目录', '未跟踪 文件.txt'), 'hello\nworld\n');
  const index = readFileSync(join(root, '.git', 'index'));
  const changes = service();
  const list = await changes.list({ root });
  assert.equal(list.branch, 'main');
  assert.equal(list.base, null);
  assert.match(list.against, /^[0-9a-f]{40}$/);
  assert.deepEqual(
    list.files.map((file) => [file.path, file.status, file.oldPath]),
    [
      ['added.txt', 'A', undefined],
      ['gone.txt', 'D', undefined],
      ['keep.txt', 'M', undefined],
      ['new name.txt', 'R', 'old name.txt'],
      ['pic.bin', 'M', undefined],
      ['新目录/', 'U', undefined],
    ],
  );
  const keep = list.files.find((file) => file.path === 'keep.txt');
  assert.deepEqual([keep.added, keep.deleted], [2, 1]);
  assert.equal(list.files.find((file) => file.path === 'pic.bin').binary, true);
  assert.deepEqual(list.summary, { files: 6, added: 3, deleted: 2, untracked: 1 });
  assert.deepEqual(list.refs.local, ['refs/heads/main']);
  // Read only: the index is as it was, and no lock is left.
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  assert.equal(existsSync(join(root, '.git', 'index.lock')), false);

  const diff = await changes.fileDiff({ root, against: list.against, path: 'keep.txt' });
  assert.equal(diff.kind, 'diff');
  assert.match(diff.text, /^-two$/m);
  assert.match(diff.text, /^\+TWO$/m);
  const renamed = await changes.fileDiff({ root, against: list.against, path: 'new name.txt' });
  assert.match(renamed.text, /rename from old name\.txt/);
  assert.equal(
    (await changes.fileDiff({ root, against: list.against, path: 'pic.bin' })).kind,
    'binary',
  );
  // Only what the latest list holds may be asked for.
  await assert.rejects(
    changes.fileDiff({ root, against: list.against, path: '../outside.txt' }),
    /已过期/,
  );
  await assert.rejects(
    changes.fileDiff({ root, against: '0'.repeat(40), path: 'keep.txt' }),
    /已过期/,
  );
});

test('an untracked file is shown whole, a binary one named, never followed out of the tree', async (t) => {
  const root = repository(t);
  writeFileSync(join(root, 'note.txt'), '第一行\n第二行\n');
  writeFileSync(join(root, 'blob.dat'), Buffer.from([1, 0, 2]));
  const changes = service();
  const list = await changes.list({ root });
  const note = await changes.fileDiff({ root, against: list.against, path: 'note.txt' });
  assert.deepEqual(note, { kind: 'new', text: '第一行\n第二行\n', truncated: false });
  assert.deepEqual(await changes.fileDiff({ root, against: list.against, path: 'blob.dat' }), {
    kind: 'binary',
  });
});

test('against a local branch or a remote-tracking ref already on disk, from where they parted', async (t) => {
  const root = repository(t);
  git(root, 'switch', '-q', '-c', 'feature');
  writeFileSync(join(root, 'feature.txt'), 'f\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'feature');
  git(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'main-only.txt'), 'm\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'main moves on');
  git(root, 'switch', '-q', 'feature');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  const changes = service();
  for (const base of ['refs/heads/main', 'refs/remotes/origin/main']) {
    const list = await changes.list({ root, base });
    assert.equal(list.base, base);
    // What main did after the branch left it is not this branch's change.
    assert.deepEqual(
      list.files.map((file) => [file.path, file.status]),
      [['feature.txt', 'A']],
    );
  }
  const list = await changes.list({ root });
  assert.deepEqual(list.refs.remote, ['refs/remotes/origin/main']);
  await assert.rejects(changes.list({ root, base: 'refs/heads/none' }), /找不到/);
  await assert.rejects(changes.list({ root, base: '--output=x' }), /只能与/);
});

test('a repository with no commit yet lists its files as new; a folder outside one says so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cc-git-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = mkdtempSync(join(tmpdir(), 'cc-git-none-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  git(root, 'init', '-q');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  const list = await service().list({ root });
  assert.deepEqual(
    list.files.map((file) => [file.path, file.status]),
    [['a.txt', 'A']],
  );
  await assert.rejects(service().list({ root: outside }), /不在 Git 仓库中/);
});

test('the repository’s own filters, fsmonitor, external diff, text conversion and pager never run', async (t) => {
  const root = repository(t);
  const sentinel = join(root, '..', `${root.split(/[\\/]/).pop()}-ran`);
  t.after(() => rmSync(sentinel, { force: true }));
  const hook = `sh -c 'echo ran >> "${sentinel.replace(/\\/g, '/')}"; cat'`;
  for (const [key, value] of [
    ['filter.evil.clean', hook],
    ['filter.evil.smudge', hook],
    ['filter.evil.process', hook],
    ['core.fsmonitor', hook],
    ['diff.external', hook],
    ['diff.evil.textconv', hook],
    ['core.pager', hook],
    ['pager.diff', hook],
  ])
    git(root, 'config', key, value);
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil diff=evil\n');
  writeFileSync(join(root, 'keep.txt'), 'changed\n');
  const changes = service();
  const list = await changes.list({ root });
  assert.ok(list.filtered.includes('evil'));
  await changes.fileDiff({ root, against: list.against, path: 'keep.txt' });
  assert.equal(existsSync(sentinel), false, 'a configured program ran');
});

test('the script holds no command that reaches a network', () => {
  for (const word of ['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule update', 'remote '])
    assert.ok(!SCRIPT.includes(word), word);
  // `g` runs git; `d` runs `g diff`.
  const commands = [...SCRIPT.matchAll(/(?:^|[\s;{(|$])g ([a-z][a-z-]*)/gm)].map(
    (match) => match[1],
  );
  assert.ok(commands.length >= 8);
  assert.ok(/d\(\) \{ g diff /.test(SCRIPT));
  for (const command of commands)
    assert.ok(
      [
        'version',
        'symbolic-ref',
        'for-each-ref',
        'rev-parse',
        'merge-base',
        'hash-object',
        'status',
        'diff',
      ].includes(command),
      command,
    );
  assert.match(SCRIPT, /protocol\.allow=never/);
  assert.match(SCRIPT, /GIT_NO_LAZY_FETCH=1/);
});

test('a partial clone missing an object never asks its remote for it', async (t) => {
  const { createServer } = await import('node:net');
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = repository(t);
  writeFileSync(join(root, 'keep.txt'), 'changed\n');
  // The committed keep.txt is no longer here, as in a partial clone that never fetched it.
  const blob = git(root, 'rev-parse', 'HEAD:keep.txt').trim();
  rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  git(root, 'config', 'core.repositoryformatversion', '1');
  git(root, 'config', 'extensions.partialClone', 'origin');
  git(root, 'config', 'remote.origin.url', `http://127.0.0.1:${server.address().port}/repo.git`);
  git(root, 'config', 'remote.origin.promisor', 'true');
  const changes = service();
  const list = await changes.list({ root });
  await changes.fileDiff({ root, against: list.against, path: 'keep.txt' }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(connections, 0);
  // The same diff by plain git does go to the remote: the test above stands for something.
  try {
    execFileSync('git', ['diff', 'HEAD', '--', 'keep.txt'], {
      cwd: root,
      timeout: 5000,
      stdio: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '' },
    });
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(connections > 0, 'plain git did not reach the remote');
});

test('filters named by an include, a worktree’s config or a pattern never run either', async (t) => {
  const sentinelOf = (root) => join(root, '..', `${root.split(/[\\/]/).pop()}-ran`);
  const hook = (sentinel) => `sh -c 'echo ran >> "${sentinel.replace(/\\/g, '/')}"; cat'`;
  // An include.
  const included = repository(t);
  const one = sentinelOf(included);
  t.after(() => rmSync(one, { force: true }));
  writeFileSync(
    join(included, '.git', 'extra'),
    `[filter "inc"]\n\tclean = ${hook(one)}\n\tsmudge = ${hook(one)}\n`,
  );
  git(included, 'config', 'include.path', 'extra');
  writeFileSync(join(included, '.gitattributes'), '*.txt filter=inc\n');
  writeFileSync(join(included, 'keep.txt'), 'changed\n');
  const list = await service().list({ root: included });
  assert.ok(list.filtered.includes('inc'));
  assert.equal(existsSync(one), false, 'an included filter ran');
  // A worktree's own config.
  const worktree = repository(t);
  const two = sentinelOf(worktree);
  t.after(() => rmSync(two, { force: true }));
  git(worktree, 'config', 'extensions.worktreeConfig', 'true');
  git(worktree, 'config', '--worktree', 'filter.wt.clean', hook(two));
  writeFileSync(join(worktree, '.gitattributes'), '*.txt filter=wt\n');
  writeFileSync(join(worktree, 'keep.txt'), 'changed\n');
  assert.ok((await service().list({ root: worktree })).filtered.includes('wt'));
  assert.equal(existsSync(two), false, 'a worktree filter ran');
  // A name that is a pattern is refused, not expanded.
  const pattern = repository(t);
  const three = sentinelOf(pattern);
  t.after(() => rmSync(three, { force: true }));
  git(pattern, 'config', 'filter.*.clean', hook(three));
  writeFileSync(join(pattern, '.gitattributes'), '*.txt filter=*\n');
  writeFileSync(join(pattern, 'keep.txt'), 'changed\n');
  await assert.rejects(service().list({ root: pattern }), /过滤器/);
  assert.equal(existsSync(three), false, 'a pattern-named filter ran');
});

test('a file touched but not changed leaves the index as it was', async (t) => {
  const root = repository(t);
  const { utimesSync } = await import('node:fs');
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'keep.txt'), later, later);
  const index = readFileSync(join(root, '.git', 'index'));
  const changes = service();
  const list = await changes.list({ root });
  await changes.list({ root, base: 'refs/heads/main' });
  assert.deepEqual(list.files, []);
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
});

test('a path with brackets is that path, not a pattern; an untracked folder opens to a note', async (t) => {
  const root = repository(t);
  mkdirSync(join(root, 'src', '[id]'), { recursive: true });
  mkdirSync(join(root, 'src', 'i'), { recursive: true });
  writeFileSync(join(root, 'src', '[id]', 'page.tsx'), 'bracket\n');
  writeFileSync(join(root, 'src', 'i', 'page.tsx'), 'plain\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'pages');
  writeFileSync(join(root, 'src', '[id]', 'page.tsx'), 'bracket changed\n');
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'folder', 'x.txt'), 'x\n');
  const changes = service();
  const list = await changes.list({ root });
  assert.deepEqual(
    list.files.map((file) => file.path),
    ['folder/', 'src/[id]/page.tsx'],
  );
  const diff = await changes.fileDiff({ root, against: list.against, path: 'src/[id]/page.tsx' });
  assert.match(diff.text, /^\+bracket changed$/m);
  assert.deepEqual(await changes.fileDiff({ root, against: list.against, path: 'folder/' }), {
    kind: 'other',
  });
});

test('a long untracked file is cut by bytes and says so', async (t) => {
  const root = repository(t);
  writeFileSync(join(root, 'long.txt'), '中文内容\n'.repeat(60_000));
  const changes = service();
  const list = await changes.list({ root });
  const diff = await changes.fileDiff({ root, against: list.against, path: 'long.txt' });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.text) <= 512 * 1024);
  assert.ok(!diff.text.endsWith('�'));
});

test('a file whose mode alone changed is still listed', async (t) => {
  const root = repository(t);
  git(root, 'update-index', '--chmod=+x', 'keep.txt');
  const list = await service().list({ root });
  assert.deepEqual(
    list.files.map((file) => [file.path, file.status]),
    [['keep.txt', 'M']],
  );
});

test('past the time allowed the whole tree ends, and the answer does not wait for it', async (t) => {
  const root = repository(t);
  const late = join(root, '..', `${root.split(/[\\/]/).pop()}-late`);
  t.after(() => rmSync(late, { force: true }));
  // A child that would write after the shell is gone, were it left running.
  const changes = createGitChanges({
    findShell: () => findGitBash(),
    killTree: (pid) =>
      execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }),
    script: `(sleep 3; echo late > "${late.replace(/\\/g, '/')}") & wait`,
    timeoutSeconds: 1,
  });
  const started = Date.now();
  await assert.rejects(changes.list({ root }), /超时/);
  assert.ok(Date.now() - started < 2500);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(existsSync(late), false, 'a child outlived the time allowed');
});

test('a name that starts with a space keeps it, here and over SSH', async (t) => {
  const root = repository(t);
  writeFileSync(join(root, ' spaced.txt'), 'new\n');
  const changes = service();
  const list = await changes.list({ root });
  assert.deepEqual(
    list.files.map((file) => file.path),
    [' spaced.txt'],
  );
  assert.equal(
    (await changes.fileDiff({ root, against: list.against, path: ' spaced.txt' })).kind,
    'new',
  );
  // Over SSH the same script runs under sh, given the command a remote shell would be: here, Git Bash stands in.
  const shell = await findGitBash();
  const remote = createGitChanges({
    ssh: async (_id, command) =>
      execFileSync(
        shell,
        ['-c', command.replace(/^cd -- '[^']*' &&/, `cd -- '${root.replace(/\\/g, '/')}' &&`)],
        {
          env: { ...process.env, MSYS_NO_PATHCONV: '1' },
        },
      ),
  });
  const over = await remote.list({ root: '/project', targetId: 'box' });
  assert.deepEqual(
    over.files.map((file) => file.path),
    [' spaced.txt'],
  );
  assert.equal(
    (
      await remote.fileDiff({
        root: '/project',
        targetId: 'box',
        against: over.against,
        path: ' spaced.txt',
      })
    ).kind,
    'new',
  );
});
