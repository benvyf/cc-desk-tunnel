const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { localPath } = require('./file-links.cjs');

const entryLimit = 2000;
const watchLimit = 128;
const debounceMs = 75;
const credentialDirectories = new Set(['.git', '.ssh', '.claude', '.codex']);
// Folders the quick-open index never enters: dependencies, build output and caches, which hold many files that are
// rarely the ones looked for. Hidden folders (.git, .next, .venv and the like) are skipped as hidden.
const indexSkipped = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  '__pycache__',
  '.venv',
]);
// Names in natural order (file2 before file10), the same letters in either case as one, directories first.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function local(value) {
  if (typeof value !== 'string' || !localPath(value, path.isAbsolute))
    throw new Error('请选择本机绝对路径，不支持网络共享。');
  return path.resolve(value);
}
function permitted(root, file) {
  if (!inside(root, file)) throw new Error('文件不在原预览工作区内。');
  if (file.split(/[\\/]/).some((part) => credentialDirectories.has(part.toLowerCase())))
    throw new Error('文件位于预览工作区的私有目录。');
  const parts = [path.basename(root), ...path.relative(root, file).split(path.sep)];
  if (parts.some((part) => part.startsWith('.') && part.toLowerCase() !== '.local'))
    throw new Error('不支持预览隐藏文件或目录。');
}
async function resolveTarget(input, missingFile = false) {
  const writtenRoot = local(input?.root);
  const writtenPath = input?.path === undefined ? writtenRoot : local(input.path);
  permitted(writtenRoot, writtenPath);
  const root = local(await files.realpath(writtenRoot));
  permitted(root, root);
  const target = local(
    await files.realpath(writtenPath).catch((error) => {
      if (!missingFile || error.code !== 'ENOENT') throw error;
      return path.resolve(root, path.relative(writtenRoot, writtenPath));
    }),
  );
  permitted(root, target);
  const stat = await files.stat(target).catch((error) => {
    if (missingFile && error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isFile() && !stat.isDirectory()) throw new Error('请选择普通文件或目录。');
  if (
    !stat?.isDirectory() &&
    [writtenPath, target].some((file) => path.basename(file).startsWith('.'))
  )
    throw new Error('不支持预览隐藏文件。');
  return { root, target, directory: stat?.isDirectory() ?? false };
}

async function fileVersion(record) {
  try {
    const canonical = local(await files.realpath(record.path));
    permitted(record.root, canonical);
    if (path.basename(canonical).startsWith('.')) return null;
    const stat = await files.stat(canonical, { bigint: true });
    if (!stat.isFile()) return null;
    return `${canonical}\0${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  } catch {
    return null;
  }
}

// Only local path metadata leaves this controller. It never reads file contents, starts a server,
// or connects to an agent. Each tree expansion lists one bounded directory on explicit request.
// The quick-open index (index below) stops at `indexFileLimit` files or after `indexTimeMs`, whichever comes
// first; tests give smaller bounds.
function createPreviewWorkspace({ indexFileLimit = 20000, indexTimeMs = 1500 } = {}) {
  const subscriptions = new Map();
  const directories = new Map();
  const recovering = new Set();
  let generation = 0;
  let closed = false;

  const current = (record) =>
    !closed && record.generation === generation && subscriptions.get(record.key) === record;

  function wakeRecovering() {
    for (const record of recovering) schedule(record);
  }

  function detach(record, directory) {
    const shared = directories.get(directory);
    if (!shared) return;
    shared.records.delete(record);
    if (shared.records.size === 0) {
      directories.delete(directory);
      shared.watcher.close();
      wakeRecovering();
    }
    record.directories.delete(directory);
  }

  function dispose(record) {
    recovering.delete(record);
    clearTimeout(record.timer);
    for (const directory of record.directories) detach(record, directory);
  }

  function unwatch(key) {
    const record = subscriptions.get(key);
    if (!record) return;
    subscriptions.delete(key);
    dispose(record);
  }

  function discard(directory, shared) {
    if (!shared || directories.get(directory) !== shared) return;
    directories.delete(directory);
    shared.watcher.close();
    for (const subscriber of shared.records) {
      subscriber.directories.delete(directory);
      schedule(subscriber);
    }
    wakeRecovering();
  }

  function attach(record, directory, identity) {
    if (!current(record)) return false;
    let shared = directories.get(directory);
    if (!shared) {
      if (directories.size >= watchLimit) return false;
      shared = { records: new Set(), watcher: null, identity };
      // Ignore the optional filename: operating systems can omit it, and atomic saves replace
      // the original inode. Watching the parent keeps file deletion/recreation observable.
      shared.watcher = fs.watch(directory, { persistent: false }, () => {
        if (directories.get(directory) !== shared) return;
        for (const subscriber of shared.records) schedule(subscriber);
      });
      shared.watcher.on('error', () => {
        discard(directory, shared);
      });
      directories.set(directory, shared);
    }
    shared.records.add(record);
    record.directories.add(directory);
    return true;
  }

  async function reachableDirectory(record, requested) {
    const boundary = path.dirname(record.root);
    let candidate = requested;
    while (current(record) && (inside(record.root, candidate) || candidate === boundary)) {
      const shared = directories.get(candidate);
      try {
        const resolved = local(await files.realpath(candidate));
        if (candidate !== boundary) permitted(record.root, resolved);
        if (resolved !== candidate) throw new Error('预览目录已改变。');
        const stat = await files.stat(resolved, { bigint: true });
        if (!stat.isDirectory()) throw new Error('预览目录已删除。');
        const identity = `${stat.dev}:${stat.ino}`;
        if (shared && shared.identity !== identity) discard(candidate, shared);
        return { directory: candidate, identity };
      } catch {
        // A stale native handle is shared by tree and file subscriptions. Invalidate it
        // for every subscriber; detaching only one record leaves Windows emitting forever.
        discard(candidate, shared);
      }
      if (candidate === boundary) break;
      candidate = path.dirname(candidate);
    }
    return null;
  }

  async function refreshDirectories(record, strict = false) {
    const desired = new Map();
    const requested = [path.dirname(record.path)];
    if (record.directory) requested.push(record.path);
    for (const directory of requested) {
      const reachable = await reachableDirectory(record, directory);
      if (reachable) desired.set(reachable.directory, reachable.identity);
    }
    if (!current(record)) return;
    record.desired = desired;
    // If a parent disappears, temporarily watch its nearest safe existing ancestor. This
    // observes recreation even when no directory-tree subscription accompanies an open tab.
    // Retire a fallback as a group once none of its subscribers still needs it. At the
    // handle limit, this frees the slot needed by their shared replacement directory.
    for (const directory of record.directories) {
      const shared = directories.get(directory);
      if (
        !desired.has(directory) &&
        shared &&
        [...shared.records].every(
          (subscriber) => subscriber.desired && !subscriber.desired.has(directory),
        )
      )
        discard(directory, shared);
    }
    for (const [directory, identity] of desired) {
      if (attach(record, directory, identity)) continue;
      if (strict) throw new Error('本机目录监听最多支持 128 个目录。');
      // Keep any existing fallback until migration succeeds. A released handle wakes these
      // bounded pending subscriptions; no polling loop or extra native handles are created.
      recovering.add(record);
      return;
    }
    recovering.delete(record);
    for (const directory of record.directories)
      if (!desired.has(directory)) detach(record, directory);
  }

  function schedule(record) {
    if (!current(record) || record.timer) return;
    // Windows can continuously report a deleted watched directory. A bounded coalescing
    // window ensures those events cannot postpone cleanup and notification indefinitely.
    record.timer = setTimeout(() => {
      record.timer = null;
      if (!current(record)) return;
      void refreshDirectories(record)
        .catch(() => {})
        .then(async () => {
          if (!current(record)) return;
          if (!record.directory) {
            // Parent events may describe siblings. Compare only metadata so an unrelated
            // write does not cause a document reload or an expensive Office conversion.
            const version = await fileVersion(record);
            if (!current(record) || version === record.version) return;
            record.version = version;
          }
          record.callback({ key: record.key, path: record.path });
        });
    }, debounceMs);
  }

  function reset() {
    generation++;
    recovering.clear();
    for (const record of subscriptions.values()) dispose(record);
    subscriptions.clear();
  }

  return {
    async list(input) {
      if (closed) throw new Error('预览工作区已关闭。');
      const openedAt = generation;
      const { root, target, directory } = await resolveTarget(input);
      if (!directory) throw new Error('请选择目录。');
      const entries = [];
      // Past the first 2000 shown entries, the rest are only counted, by name, for the tree to say how many
      // there are; none of them is resolved or exposed.
      let total = 0;
      const handle = await files.opendir(target);
      for await (const entry of handle) {
        if (entries.length >= entryLimit) {
          if (!entry.name.startsWith('.')) total++;
          continue;
        }
        const entryPath = path.join(target, entry.name);
        try {
          permitted(root, entryPath);
          const canonical = local(await files.realpath(entryPath));
          permitted(root, canonical);
          const stat = await files.stat(canonical);
          if (
            !stat.isDirectory() &&
            (entry.name.startsWith('.') || path.basename(canonical).startsWith('.'))
          )
            continue;
          if (stat.isDirectory() || stat.isFile()) {
            entries.push({
              name: entry.name,
              path: entryPath,
              kind: stat.isDirectory() ? 'directory' : 'file',
            });
            total++;
          }
        } catch {
          // Hidden, unsafe, dangling or concurrently removed entries are never exposed.
        }
      }
      if (closed || openedAt !== generation) throw new Error('预览来源已失效，请重新打开工作区。');
      // `total` exceeds the entries' count when the folder holds more than the 2000 shown (the tree says so).
      return {
        entries: entries.sort((a, b) =>
          a.kind === b.kind ? byName(a.name, b.name) : a.kind === 'directory' ? -1 : 1,
        ),
        total,
      };
    },

    // The files of the whole workspace, for opening one by name: paths relative to the root, '/' between their
    // parts. Bounded in count and time; past either, what was found so far comes back with `truncated`. Hidden
    // and private folders, dependencies and build output are not entered, and a link is followed only to a file
    // inside the root, never into a directory, so nothing outside the root is listed and no cycle is walked.
    async index(input) {
      if (closed) throw new Error('预览工作区已关闭。');
      const openedAt = generation;
      const { root, directory } = await resolveTarget({ root: input?.root });
      if (!directory) throw new Error('请选择目录。');
      const started = Date.now();
      const found = [];
      let truncated = false;
      // Iterative, so a deep tree cannot exhaust the stack; every read is asynchronous.
      const pending = [''];
      walk: while (pending.length) {
        const relative = pending.shift();
        let entries;
        try {
          entries = await files.readdir(path.join(root, relative), { withFileTypes: true });
        } catch {
          // An unreadable or concurrently removed folder is left out.
          continue;
        }
        if (closed || openedAt !== generation)
          throw new Error('预览来源已失效，请重新打开工作区。');
        entries.sort((a, b) => byName(a.name, b.name));
        for (const entry of entries) {
          if (found.length >= indexFileLimit || Date.now() - started > indexTimeMs) {
            truncated = true;
            break walk;
          }
          const name = entry.name;
          const lower = name.toLowerCase();
          if (name.startsWith('.') || credentialDirectories.has(lower)) continue;
          const child = relative ? `${relative}/${name}` : name;
          if (entry.isDirectory()) {
            if (!indexSkipped.has(lower)) pending.push(child);
          } else if (entry.isFile()) {
            found.push(child);
          } else if (entry.isSymbolicLink()) {
            // Windows junctions are links too. Only a link to a file inside the root, outside private
            // folders, is listed, under its own name.
            try {
              const canonical = local(await files.realpath(path.join(root, child)));
              permitted(root, canonical);
              if (path.basename(canonical).startsWith('.')) continue;
              if ((await files.stat(canonical)).isFile()) found.push(child);
            } catch {
              // Dangling, outside the root or private: not listed.
            }
          }
        }
      }
      if (closed || openedAt !== generation) throw new Error('预览来源已失效，请重新打开工作区。');
      return { files: found, truncated };
    },

    async watch(input, callback) {
      if (closed) throw new Error('预览工作区已关闭。');
      if (
        typeof input?.key !== 'string' ||
        !input.key ||
        input.key.length > 256 ||
        typeof callback !== 'function'
      )
        throw new Error('无效的预览监听参数。');
      unwatch(input.key);
      if (subscriptions.size >= watchLimit) throw new Error('本机预览最多支持 128 个监听。');
      const record = {
        key: input.key,
        callback,
        generation,
        directories: new Set(),
        timer: null,
      };
      // Reserve before asynchronous validation so concurrent requests share the same limit,
      // and unwatch/reset can invalidate registrations that have not reached fs.watch yet.
      subscriptions.set(record.key, record);
      try {
        const { root, target, directory } = await resolveTarget(input, input.file === true);
        if (!current(record)) throw new Error('预览来源已失效，请重新打开工作区。');
        Object.assign(record, { root, path: target, directory });
        if (!directory) record.version = await fileVersion(record);
        await refreshDirectories(record, true);
        if (!current(record)) throw new Error('预览来源已失效，请重新打开工作区。');
      } catch (error) {
        if (subscriptions.get(record.key) === record) unwatch(record.key);
        throw error;
      }
    },

    unwatch,
    reset,
    close() {
      closed = true;
      reset();
    },
  };
}

module.exports = { createPreviewWorkspace };
