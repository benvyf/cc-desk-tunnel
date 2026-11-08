import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createInstallerCleanup, registerInstallerCleanup } = createRequire(import.meta.url)(
  '../electron/installer-cleanup.cjs',
);

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cc-space-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "下载=文件's");
  await mkdir(directory);
  const installDirectory = join(root, 'installed');
  await mkdir(installDirectory);
  const target = join(directory, '自定义安装包 (1).exe');
  const marker = join(root, 'cc-space-install.ini');
  const bytes = Buffer.alloc(160);
  bytes.write('MZ');
  bytes.write('NullsoftInst', 80);
  await writeFile(target, bytes);
  let acknowledged = {};
  let trashError = false;
  const calls = [];
  const id = '{' + randomUUID() + '}';
  const record = async (change = {}) => {
    const info = await stat(target, { bigint: true });
    const value = {
      Id: id,
      Version: '0.3.9',
      Path: target,
      Size: String(info.size),
      WriteTime: String((info.mtimeNs + 11644473600000000000n) / 100n),
      ...change,
    };
    await writeFile(
      marker,
      Buffer.from(
        '\ufeff[CCSpaceInstall]\r\n' +
          Object.entries(value)
            .map(([k, v]) => `${k}=${v}`)
            .join('\r\n') +
          '\r\n',
        'utf16le',
      ),
    );
  };
  await record();
  const create = (overrides = {}) =>
    createInstallerCleanup({
      enabled: true,
      markerPath: marker,
      installDirectory,
      version: '0.3.9',
      read: () => acknowledged,
      write: (value) => {
        acknowledged = value;
      },
      lock: (action) => action(),
      trash: async (path) => {
        calls.push(path);
        if (trashError) throw Error('file is locked');
        await rename(path, join(root, 'recycled.exe'));
      },
      ...options,
      ...overrides,
    });
  return {
    root,
    directory,
    installDirectory,
    target,
    marker,
    id,
    calls,
    record,
    create,
    controller: create(),
    failTrash: (value) => {
      trashError = value;
    },
    ack: (value) => {
      acknowledged = value;
    },
  };
}

test('reads the exact Unicode installer handoff without selecting other downloads', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.create({ enabled: false }).inspect(), null);
  const other = join(f.directory, 'other.exe');
  await writeFile(other, 'unrelated download');
  assert.deepEqual(await f.controller.inspect(), {
    name: '自定义安装包 (1).exe',
    path: f.target,
    size: 160,
  });
  assert.deepEqual(f.calls, []);
  assert.equal((await readFile(other)).toString(), 'unrelated download');
});

test('keep acknowledges the installation without deleting and survives another app launch', async (t) => {
  const f = await fixture(t);
  await f.controller.inspect();
  await f.controller.keep();
  assert.equal(await f.create().inspect(), null);
  assert.equal((await stat(f.target)).size, 160);
  assert.deepEqual(f.calls, []);
  await f.record({ Id: '{' + randomUUID() + '}' });
  assert.notEqual(await f.create().inspect(), null);
});

test('only explicit confirmation sends the captured installer to the recycle operation', async (t) => {
  const f = await fixture(t);
  await f.controller.inspect();
  await f.controller.remove();
  assert.deepEqual(f.calls, [f.target]);
  assert.equal(await f.create().inspect(), null);
  await assert.rejects(f.controller.remove());
});

test('an installer cache replaced before the first app launch is never offered for cleanup', async (t) => {
  const f = await fixture(t);
  await appendFile(f.target, 'a later installer download');
  assert.equal(await f.controller.inspect(), null);
  assert.deepEqual(f.calls, []);
});

test('a changed file or replaced installation marker cannot authorize cleanup', async (t) => {
  const f = await fixture(t);
  await f.controller.inspect();
  await appendFile(f.target, 'changed');
  await assert.rejects(f.controller.remove(), /变化/);
  assert.deepEqual(f.calls, []);
  await f.controller.inspect();
  await f.record({ Id: '{' + randomUUID() + '}' });
  await assert.rejects(f.controller.remove(), /变化/);
  assert.deepEqual(f.calls, []);
});

test('a manually removed installer completes without touching another file', async (t) => {
  const f = await fixture(t);
  await f.controller.inspect();
  await rm(f.target);
  await f.controller.remove();
  assert.deepEqual(f.calls, []);
  assert.equal(await f.create().inspect(), null);
});

test('a locked installer stays available for retry and never falls back to permanent deletion', async (t) => {
  const f = await fixture(t);
  await f.controller.inspect();
  f.failTrash(true);
  await assert.rejects(f.controller.remove(), /回收站/);
  assert.equal((await stat(f.target)).size, 160);
  f.failTrash(false);
  await f.controller.remove();
  assert.equal(f.calls.length, 2);
});

test('missing, old, malformed, remote and non-installer records do not prompt', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { Version: '0.3.7' },
    { Id: 'bad' },
    { Path: 'relative.exe' },
    { Path: '\\\\server\\download.exe' },
    { Path: f.directory },
  ]) {
    await f.record(change);
    assert.equal(await f.create().inspect(), null);
  }
  await f.record();
  await writeFile(f.target, 'not a Windows installer');
  assert.equal(await f.create().inspect(), null);
  await rm(f.marker);
  assert.equal(await f.create().inspect(), null);
});

test('an acknowledgement made during inspection cannot recreate a dismissed prompt', async (t) => {
  const f = await fixture(t);
  const pending = f.controller.inspect();
  f.ack({ id: f.id });
  assert.equal(await pending, null);
});

test('installed programs and uninstallers are outside the cleanup scope', async (t) => {
  const f = await fixture(t);
  const uninstaller = join(f.installDirectory, 'Uninstall CC Space.exe');
  await writeFile(uninstaller, await readFile(f.target));
  await f.record({ Path: uninstaller });
  assert.equal(await f.controller.inspect(), null);
  assert.deepEqual(f.calls, []);
});

test('cleanup IPC never accepts a renderer-selected path', async () => {
  const handlers = new Map();
  const calls = [];
  registerInstallerCleanup(
    (name, fn) => handlers.set(name, fn),
    Object.fromEntries(
      ['inspect', 'keep', 'remove'].map((name) => [
        name,
        () => {
          calls.push(name);
        },
      ]),
    ),
  );
  assert.equal(handlers.size, 3);
  for (const [name, handle] of handlers) {
    await assert.rejects(async () => handle({}, 'C:\\arbitrary.exe'));
    await handle({});
  }
  assert.deepEqual(calls, ['inspect', 'keep', 'remove']);
});
