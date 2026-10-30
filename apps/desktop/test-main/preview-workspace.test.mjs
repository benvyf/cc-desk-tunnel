import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createPreviewWorkspace } = require('../electron/preview-workspace.cjs');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-workspace-'));
  const workspace = createPreviewWorkspace();
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, 'project');
  await mkdir(project);
  return { root, project, workspace };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function changed(events, after = 0) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (events.length > after) return events.at(-1);
    await pause(25);
  }
  assert.fail('Expected a local filesystem change event within 2500ms');
}

test('lists only one directory, sorted directories first, without reading file contents', async (t) => {
  const { project, workspace } = await fixture(t);
  await mkdir(join(project, 'z-folder'));
  await mkdir(join(project, 'a-folder'));
  await writeFile(join(project, 'b.txt'), 'PRIVATE BODY');
  await writeFile(join(project, 'a.txt'), 'ANOTHER BODY');
  await writeFile(join(project, 'a-folder/nested.txt'), 'NESTED BODY');
  assert.deepEqual(await workspace.list({ root: project }), [
    { name: 'a-folder', path: join(project, 'a-folder'), kind: 'directory' },
    { name: 'z-folder', path: join(project, 'z-folder'), kind: 'directory' },
    { name: 'a.txt', path: join(project, 'a.txt'), kind: 'file' },
    { name: 'b.txt', path: join(project, 'b.txt'), kind: 'file' },
  ]);
  assert.deepEqual(await workspace.list({ root: project, path: join(project, 'a-folder') }), [
    { name: 'nested.txt', path: join(project, 'a-folder/nested.txt'), kind: 'file' },
  ]);
});

test('hides credentials and hidden entries but permits generated .local directories', async (t) => {
  const { project, workspace } = await fixture(t);
  for (const name of ['.git', '.ssh', '.claude', '.codex', '.local', '.hidden'])
    await mkdir(join(project, name));
  await writeFile(join(project, '.env'), 'SECRET');
  await writeFile(join(project, '.local/result.txt'), 'LOCAL');
  assert.deepEqual(
    (await workspace.list({ root: project })).map((entry) => entry.name),
    ['.local'],
  );
  assert.equal(
    (await workspace.list({ root: project, path: join(project, '.local') }))[0].name,
    'result.txt',
  );
  for (const name of ['.git', '.ssh', '.claude', '.codex', '.hidden', '.env']) {
    await assert.rejects(workspace.list({ root: project, path: join(project, name) }), /私有|隐藏/);
    await assert.rejects(
      workspace.watch({ root: project, path: join(project, name), key: name }, () => {}),
      /私有|隐藏/,
    );
  }
  await assert.rejects(workspace.list({ root: join(project, '.claude') }), /私有|隐藏/);
});

test('rejects nonlocal paths and traversal before directory access', async (t) => {
  const { root, project, workspace } = await fixture(t);
  for (const value of [
    '\\\\server\\share',
    '//server/share',
    'relative',
    'file:///C:/project',
    '\0',
  ]) {
    await assert.rejects(workspace.list({ root: value }), /本机|绝对路径/);
    await assert.rejects(workspace.list({ root: project, path: value }), /本机|绝对路径/);
  }
  await assert.rejects(workspace.list({ root: project, path: root }), /工作区/);
  await assert.rejects(
    workspace.watch({ root: project, path: root, key: 'escape' }, () => {}),
    /工作区/,
  );
});

test('omits aliases outside the root or into credential folders and rejects direct access', async (t) => {
  const { root, project, workspace } = await fixture(t);
  await mkdir(join(root, 'outside'));
  await mkdir(join(project, '.claude'));
  await mkdir(join(project, 'safe'));
  await symlink(join(root, 'outside'), join(project, 'outside-link'), 'junction');
  await symlink(join(project, '.claude'), join(project, 'credential-link'), 'junction');
  await symlink(join(project, 'safe'), join(project, 'safe-link'), 'junction');
  assert.deepEqual(
    (await workspace.list({ root: project })).map((entry) => entry.name),
    ['safe', 'safe-link'],
  );
  for (const name of ['outside-link', 'credential-link']) {
    await assert.rejects(
      workspace.list({ root: project, path: join(project, name) }),
      /工作区|私有/,
    );
    await assert.rejects(
      workspace.watch({ root: project, path: join(project, name), key: name }, () => {}),
      /工作区|私有/,
    );
  }
});

test('rejects an oversized directory with an explicit limit instead of silently truncating it', async (t) => {
  const { project, workspace } = await fixture(t);
  await Promise.all(
    Array.from({ length: 2001 }, (_, i) => writeFile(join(project, `${i}.txt`), '')),
  );
  await assert.rejects(workspace.list({ root: project }), /2000/);
});

test('opened file watches debounce metadata through atomic saves, deletion and recreation', async (t) => {
  const { project, workspace } = await fixture(t);
  const file = join(project, 'opened.txt');
  await writeFile(file, 'SECRET ORIGINAL');
  const events = [];
  await workspace.watch({ root: project, path: file, key: 'tab' }, (event) => events.push(event));
  await writeFile(join(project, 'replacement.tmp'), 'SECRET NEW');
  await rename(file, join(project, 'old.tmp'));
  await rename(join(project, 'replacement.tmp'), file);
  assert.deepEqual(await changed(events), { key: 'tab', path: file });
  await pause(150);
  assert.equal(events.length, 1, 'a save burst is debounced');
  await rm(file);
  await changed(events, 1);
  const count = events.length;
  await writeFile(file, 'SECRET RECREATED');
  await changed(events, count);
  assert(
    events.every((event) => JSON.stringify(event) === JSON.stringify({ key: 'tab', path: file })),
  );
});

test('file watches ignore unrelated sibling writes while directory watches still notify', async (t) => {
  const { project, workspace } = await fixture(t);
  const file = join(project, 'opened.txt');
  const sibling = join(project, 'unrelated.txt');
  await writeFile(file, 'OPENED BODY');
  await writeFile(sibling, 'UNRELATED BODY');
  const fileEvents = [];
  const directoryEvents = [];
  await workspace.watch({ root: project, path: file, key: 'file' }, (event) =>
    fileEvents.push(event),
  );
  await workspace.watch({ root: project, path: project, key: 'directory' }, (event) =>
    directoryEvents.push(event),
  );
  await writeFile(sibling, 'UNRELATED BODY UPDATED');
  await changed(directoryEvents);
  await pause(150);
  assert.deepEqual(fileEvents, [], 'sibling edits must not refresh or reconvert the opened file');
  await writeFile(file, 'OPENED BODY UPDATED');
  assert.deepEqual(await changed(fileEvents), { key: 'file', path: file });
});

test('expanded directory watches survive deletion and recreation', async (t) => {
  const { project, workspace } = await fixture(t);
  const folder = join(project, 'expanded');
  await mkdir(folder);
  const events = [];
  await workspace.watch({ root: project, path: folder, key: 'tree' }, (event) =>
    events.push(event),
  );
  await writeFile(join(folder, 'first.txt'), 'BODY');
  await changed(events);
  let count = events.length;
  await rm(folder, { recursive: true });
  await changed(events, count);
  count = events.length;
  await mkdir(folder);
  await changed(events, count);
  count = events.length;
  await writeFile(join(folder, 'second.txt'), 'BODY');
  await changed(events, count);
  assert.deepEqual(events.at(-1), { key: 'tree', path: folder });
});

test('shared tree and file watches settle after parent deletion and resume on recreation', async (t) => {
  const { project, workspace } = await fixture(t);
  const folder = join(project, 'expanded');
  const file = join(folder, 'opened.txt');
  await mkdir(folder);
  await writeFile(file, 'BODY');
  const treeEvents = [];
  const fileEvents = [];
  await workspace.watch({ root: project, path: folder, key: 'tree' }, (event) =>
    treeEvents.push(event),
  );
  await workspace.watch({ root: project, path: file, key: 'file' }, (event) =>
    fileEvents.push(event),
  );
  await rm(folder, { recursive: true });
  await changed(treeEvents);
  await changed(fileEvents);
  await pause(250);
  const settled = [treeEvents.length, fileEvents.length];
  await pause(350);
  assert.deepEqual(
    [treeEvents.length, fileEvents.length],
    settled,
    'deleted native handles must stop emitting callbacks',
  );
  await mkdir(folder);
  await writeFile(file, 'RECREATED');
  await changed(treeEvents, settled[0]);
  await changed(fileEvents, settled[1]);
  await pause(150);
  const recreated = [treeEvents.length, fileEvents.length];
  await writeFile(file, 'CHANGED AFTER RECREATION');
  await changed(treeEvents, recreated[0]);
  await changed(fileEvents, recreated[1]);
  assert.deepEqual(treeEvents.at(-1), { key: 'tree', path: folder });
  assert.deepEqual(fileEvents.at(-1), { key: 'file', path: file });
});

test('a file watch recovers its deleted parent without requiring an expanded tree subscription', async (t) => {
  const { project, workspace } = await fixture(t);
  const folder = join(project, 'parent');
  const file = join(folder, 'opened.txt');
  await mkdir(folder);
  await writeFile(file, 'BODY');
  const events = [];
  await workspace.watch({ root: project, path: file, key: 'file' }, (event) => events.push(event));
  await rm(folder, { recursive: true });
  await changed(events);
  await pause(250);
  const settled = events.length;
  await pause(350);
  assert.equal(events.length, settled, 'a deleted file parent must not create an event storm');
  await mkdir(folder);
  await writeFile(file, 'RECREATED');
  await changed(events, settled);
});

test('shared watchers follow the replacement directory inode after a rapid rename and recreation', async (t) => {
  const { project, workspace } = await fixture(t);
  const folder = join(project, 'expanded');
  const file = join(folder, 'opened.txt');
  await mkdir(folder);
  await writeFile(file, 'ORIGINAL');
  const treeEvents = [];
  const fileEvents = [];
  await workspace.watch({ root: project, path: folder, key: 'tree' }, (event) =>
    treeEvents.push(event),
  );
  await workspace.watch({ root: project, path: file, key: 'file' }, (event) =>
    fileEvents.push(event),
  );
  await rename(folder, join(project, 'old-expanded'));
  await mkdir(folder);
  await writeFile(file, 'REPLACEMENT');
  await changed(treeEvents);
  await changed(fileEvents);
  await pause(200);
  const counts = [treeEvents.length, fileEvents.length];
  await writeFile(file, 'CHANGED IN REPLACEMENT');
  await changed(treeEvents, counts[0]);
  await changed(fileEvents, counts[1]);
  await pause(150);
  const settled = [treeEvents.length, fileEvents.length];
  await writeFile(join(project, 'old-expanded/opened.txt'), 'CHANGED IN OLD INODE');
  await pause(200);
  assert.deepEqual(
    [treeEvents.length, fileEvents.length],
    settled,
    'the old inode must no longer be watched',
  );
});

test('replacing a key and unwatching suppresses pending callbacks', async (t) => {
  const { project, workspace } = await fixture(t);
  const first = join(project, 'first');
  const second = join(project, 'second');
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, 'file.txt'), 'A');
  await writeFile(join(second, 'file.txt'), 'B');
  const events = [];
  await workspace.watch({ root: project, path: join(first, 'file.txt'), key: 'same' }, () =>
    events.push('OLD'),
  );
  await writeFile(join(first, 'file.txt'), 'A2');
  await workspace.watch({ root: project, path: join(second, 'file.txt'), key: 'same' }, () =>
    events.push('NEW'),
  );
  await pause(150);
  assert.deepEqual(events, []);
  await writeFile(join(first, 'file.txt'), 'A3');
  await pause(150);
  assert.deepEqual(events, []);
  await writeFile(join(second, 'file.txt'), 'B2');
  await changed(events);
  assert.deepEqual(events, ['NEW']);
  await writeFile(join(second, 'file.txt'), 'B3');
  workspace.unwatch('same');
  await pause(150);
  assert.deepEqual(events, ['NEW']);
});

test('reset and close invalidate in-flight registrations and pending change callbacks', async (t) => {
  const { project, workspace } = await fixture(t);
  const file = join(project, 'opened.txt');
  await writeFile(file, 'BODY');
  const events = [];
  const pending = workspace.watch({ root: project, path: file, key: 'pending' }, (event) =>
    events.push(event),
  );
  workspace.reset();
  await assert.rejects(pending, /失效/);
  await workspace.watch({ root: project, path: file, key: 'active' }, (event) =>
    events.push(event),
  );
  await writeFile(file, 'BODY2');
  workspace.reset();
  await pause(150);
  assert.deepEqual(events, []);
  await workspace.watch({ root: project, path: file, key: 'active' }, (event) =>
    events.push(event),
  );
  await writeFile(file, 'BODY3');
  workspace.close();
  await pause(150);
  assert.deepEqual(events, []);
  await assert.rejects(
    workspace.watch({ root: project, path: file, key: 'closed' }, () => {}),
    /关闭|失效/,
  );
});

test('unwatch invalidates registration that is still resolving its local path', async (t) => {
  const { project, workspace } = await fixture(t);
  const file = join(project, 'opened.txt');
  await writeFile(file, 'BODY');
  const events = [];
  const pending = workspace.watch({ root: project, path: file, key: 'pending' }, (event) =>
    events.push(event),
  );
  workspace.unwatch('pending');
  await assert.rejects(pending, /失效/);
  await writeFile(file, 'CHANGED');
  await pause(150);
  assert.deepEqual(events, []);
});

test('bounds watch subscriptions at 128, including concurrent registrations, and releases capacity', async (t) => {
  const { project, workspace } = await fixture(t);
  const file = join(project, 'opened.txt');
  await writeFile(file, 'BODY');
  await Promise.all(
    Array.from({ length: 128 }, (_, i) =>
      workspace.watch({ root: project, path: file, key: `tab-${i}` }, () => {}),
    ),
  );
  await assert.rejects(
    workspace.watch({ root: project, path: file, key: 'overflow' }, () => {}),
    /128/,
  );
  workspace.unwatch('tab-0');
  await workspace.watch({ root: project, path: file, key: 'replacement' }, () => {});
  workspace.reset();
  await workspace.watch({ root: project, path: file, key: 'after-reset' }, () => {});
});

test('the .local exception permits generated directories, never hidden files', async (t) => {
  const { project, workspace } = await fixture(t);
  await writeFile(join(project, '.local'), 'SECRET');
  assert.deepEqual(await workspace.list({ root: project }), []);
  await assert.rejects(
    workspace.watch({ root: project, path: join(project, '.local'), key: 'hidden' }, () => {}),
    /隐藏/,
  );
});

test('rejects realpath network aliases without attempting to enumerate or watch the share', async (t) => {
  const { project, workspace } = await fixture(t);
  const promises = require('node:fs/promises');
  const original = promises.realpath;
  t.mock.method(promises, 'realpath', async (value) =>
    value === project ? '\\\\server\\share\\project' : original(value),
  );
  await assert.rejects(workspace.list({ root: project }), /本机|网络/);
  await assert.rejects(
    workspace.watch({ root: project, path: project, key: 'network' }, () => {}),
    /本机|网络/,
  );
});

test('notifications do not depend on an OS-provided filename', async (t) => {
  const { project, workspace } = await fixture(t);
  const fs = require('node:fs');
  const original = fs.watch;
  t.mock.method(fs, 'watch', (directory, options, callback) => {
    return original(directory, options, (event) => callback(event, undefined));
  });
  const file = join(project, 'file.txt');
  await writeFile(file, 'PRIVATE');
  const events = [];
  await workspace.watch({ root: project, path: file, key: 'no-filename' }, (event) =>
    events.push(event),
  );
  await writeFile(file, 'PRIVATE CHANGED WITHOUT AN OS FILENAME');
  assert.deepEqual(await changed(events), { key: 'no-filename', path: file });
});

test('bounds native handles as well as keys and closes every handle on reset', async (t) => {
  const { project, workspace } = await fixture(t);
  const fs = require('node:fs');
  const original = fs.watch;
  const active = new Set();
  t.mock.method(fs, 'watch', (...args) => {
    const handle = original(...args);
    active.add(handle);
    const close = handle.close.bind(handle);
    handle.close = () => {
      active.delete(handle);
      return close();
    };
    assert(active.size <= 128);
    return handle;
  });
  const folders = Array.from({ length: 127 }, (_, i) => join(project, `folder-${i}`));
  await Promise.all(
    folders.map(async (folder) => {
      await mkdir(folder);
      await writeFile(join(folder, 'file.txt'), '');
    }),
  );
  await workspace.watch({ root: project, path: project, key: 'root' }, () => {});
  for (let i = 0; i < 126; i++)
    await workspace.watch(
      { root: project, path: join(folders[i], 'file.txt'), key: `file-${i}` },
      () => {},
    );
  assert.equal(active.size, 128);
  await assert.rejects(
    workspace.watch(
      { root: project, path: join(folders[126], 'file.txt'), key: 'overflow' },
      () => {},
    ),
    /128/,
  );
  assert.equal(active.size, 128);
  workspace.unwatch('file-0');
  assert.equal(active.size, 127);
  await workspace.watch(
    { root: project, path: join(folders[126], 'file.txt'), key: 'overflow' },
    () => {},
  );
  workspace.reset();
  assert.equal(active.size, 0);
});

test('shared file watches migrate back from fallback at the 128-handle limit without orphaning a subscriber', async (t) => {
  const { project, workspace } = await fixture(t);
  const fs = require('node:fs');
  const original = fs.watch;
  const active = new Set();
  t.mock.method(fs, 'watch', (...args) => {
    const handle = original(...args);
    active.add(handle);
    assert(active.size <= 128, 'recovery must preserve the native handle limit');
    const close = handle.close.bind(handle);
    handle.close = () => {
      active.delete(handle);
      return close();
    };
    return handle;
  });
  const parent = join(project, 'a/p');
  const first = join(parent, 'first.txt');
  const second = join(parent, 'second.txt');
  await mkdir(parent, { recursive: true });
  await writeFile(first, 'FIRST');
  await writeFile(second, 'SECOND');
  const firstEvents = [];
  const secondEvents = [];
  await workspace.watch({ root: project, path: first, key: 'first' }, (event) =>
    firstEvents.push(event),
  );
  await workspace.watch({ root: project, path: second, key: 'second' }, (event) =>
    secondEvents.push(event),
  );
  for (let i = 0; i < 125; i++) {
    const directory = join(project, `other-${i}`);
    await mkdir(directory);
    await writeFile(join(directory, 'file.txt'), '');
    await workspace.watch(
      { root: project, path: join(directory, 'file.txt'), key: `other-${i}` },
      () => {},
    );
  }
  const expanded = join(project, 'b/q');
  await mkdir(expanded, { recursive: true });
  await workspace.watch({ root: project, path: expanded, key: 'tree' }, () => {});
  assert.equal(active.size, 128);
  await rm(parent, { recursive: true });
  await changed(firstEvents);
  await changed(secondEvents);
  await pause(200);
  assert.equal(active.size, 128, 'both files share the fallback at a');
  const beforeRecreation = [firstEvents.length, secondEvents.length];
  await mkdir(parent);
  await writeFile(first, 'RECREATED FIRST');
  await writeFile(second, 'RECREATED SECOND');
  await changed(firstEvents, beforeRecreation[0]);
  await changed(secondEvents, beforeRecreation[1]);
  await pause(250);
  const beforeEdit = [firstEvents.length, secondEvents.length];
  await writeFile(first, 'EDIT AFTER RECOVERY');
  await writeFile(second, 'EDIT SECOND AFTER RECOVERY');
  await changed(firstEvents, beforeEdit[0]);
  await changed(secondEvents, beforeEdit[1]);
  assert.equal(active.size, 128);
  workspace.reset();
  assert.equal(active.size, 0);
});

test('a later registration for the same key invalidates an earlier in-flight registration', async (t) => {
  const { project, workspace } = await fixture(t);
  const file = join(project, 'file.txt');
  await writeFile(file, 'BODY');
  const events = [];
  const first = workspace.watch({ root: project, path: file, key: 'same' }, () =>
    events.push('STALE'),
  );
  const replacement = workspace.watch({ root: project, path: file, key: 'same' }, () =>
    events.push('CURRENT'),
  );
  await assert.rejects(first, /失效/);
  await replacement;
  await writeFile(file, 'CHANGED');
  await changed(events);
  assert.deepEqual(events, ['CURRENT']);
});

test('reset invalidates a list request still resolving its directory', async (t) => {
  const { project, workspace } = await fixture(t);
  const pending = workspace.list({ root: project });
  workspace.reset();
  await assert.rejects(pending, /失效/);
});

test('a file alias cannot expose a hidden .local file', async (t) => {
  const { project, workspace } = await fixture(t);
  await writeFile(join(project, '.local'), 'SECRET');
  const alias = join(project, 'visible-alias.txt');
  try {
    await symlink(join(project, '.local'), alias, 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    // File symlinks need additional Windows privileges. Still exercise the canonical-path
    // boundary using real files with only the OS alias resolution substituted.
    await writeFile(alias, '');
    const promises = require('node:fs/promises');
    const original = promises.realpath;
    t.mock.method(promises, 'realpath', async (value) =>
      value === alias ? join(project, '.local') : original(value),
    );
  }
  assert.deepEqual(await workspace.list({ root: project }), []);
  await assert.rejects(
    workspace.watch(
      { root: project, path: join(project, 'visible-alias.txt'), key: 'hidden' },
      () => {},
    ),
    /隐藏/,
  );
});
