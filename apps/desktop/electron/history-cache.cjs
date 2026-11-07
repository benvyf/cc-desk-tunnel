const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setImmediate: pause } = require('node:timers/promises');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownerHash = /^[0-9a-f]{64}$/;
const inputLimit = 4 * 1024 * 1024;
const activeTemporaryFiles = new Set();
const runHash = (id) => createHash('sha256').update(id).digest('hex');
function cacheTemporary(name) {
  if (!name.endsWith('.tmp')) return false;
  const stem = name.slice(0, -4),
    target = stem.slice(0, -37);
  return (
    uuid.test(stem.slice(-36)) &&
    (target === 'meta.json' || (target.endsWith('.jsonl') && uuid.test(target.slice(0, -6))))
  );
}
function sessionId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Invalid history session ID');
  return id;
}
function validEvent(event, id) {
  return (
    event &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    typeof event.runId === 'string' &&
    event.sessionId === id &&
    event.payload?.type !== 'native.progress'
  );
}
async function encode(events, id, limit = inputLimit) {
  if (!Array.isArray(events)) throw new Error('Invalid history events');
  const lines = [];
  let bytes = 0;
  for (let i = 0; i < events.length; i++) {
    if (!validEvent(events[i], id)) throw new Error('Invalid history event');
    const line = JSON.stringify(events[i]) + '\n';
    bytes += Buffer.byteLength(line);
    if (bytes > limit) throw new Error('History input exceeds 4 MB');
    lines.push(line);
    if (i % 32 === 31) await pause();
  }
  return lines;
}
async function atomic(target, text) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  activeTemporaryFiles.add(temporary);
  try {
    const file = await fs.open(temporary, 'w', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, target);
        break;
      } catch (error) {
        if (attempt === 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await pause();
      }
    }
  } finally {
    try {
      await fs.rm(temporary, { force: true });
    } finally {
      activeTemporaryFiles.delete(temporary);
    }
  }
}

function createHistoryCache(root, options = {}) {
  const maxEvents = options.maxEvents ?? 2000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 200 * 1024 * 1024;
  const meta = { format: 1, protocol: 24 };
  let selected = Promise.resolve(null);
  let barrier = Promise.resolve();
  const chains = new Map();
  const protectedIds = new Map();
  let maintenance = Promise.resolve();
  let maintenanceQueued = false;
  const fileFor = (owner, id) => path.join(owner, `${sessionId(id)}.jsonl`);
  const list = async (directory) => {
    try {
      return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  // Capture owner at invocation: work queued by the old renderer connection stays in its directory.
  function operation(id, action, owner = selected) {
    const before = barrier;
    const task = (async () => {
      sessionId(id);
      const directory = await owner;
      await before;
      if (!directory) throw new Error('History cache is not open');
      const key = fileFor(directory, id);
      const prior = chains.get(key) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(() => action(directory, key));
      chains.set(key, next);
      try {
        return await next;
      } finally {
        if (chains.get(key) === next) chains.delete(key);
      }
    })();
    return task;
  }
  async function readFile(file, id) {
    try {
      const info = await fs.stat(file);
      if (info.size > inputLimit) throw new Error('Oversized history file');
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      const header = JSON.parse(lines.shift());
      if (
        header.format !== 1 ||
        header.sessionId !== id ||
        !Number.isSafeInteger(header.firstSequence) ||
        header.firstSequence < 0 ||
        typeof header.hasEarlier !== 'boolean'
      )
        throw new Error('Invalid history header');
      if (
        header.discardedRun !== undefined &&
        (typeof header.discardedRun !== 'string' || !ownerHash.test(header.discardedRun))
      )
        throw new Error('Invalid discarded run');
      const events = [];
      // A crash may leave a complete JSON value but omit its record separator.
      // It is readable, but the next append must first restore the trailing newline.
      let torn = !text.endsWith('\n');
      for (let i = 0; i < lines.length; i++) {
        let event;
        try {
          event = JSON.parse(lines[i]);
        } catch (error) {
          if (i !== lines.length - 1) throw error;
          torn = true;
          break;
        }
        if (!validEvent(event, id) || event.sequence <= (events.at(-1)?.sequence ?? 0))
          throw new Error('Invalid history sequence');
        events.push(event);
        if (i % 32 === 31) await pause();
      }
      if (header.firstSequence !== (events[0]?.sequence ?? 0))
        throw new Error('Invalid first sequence');
      if (header.discardedRun && (events.length || !header.hasEarlier))
        throw new Error('Invalid discarded run window');
      return {
        firstSequence: header.firstSequence,
        hasEarlier: header.hasEarlier,
        events,
        torn,
        ...(header.discardedRun ? { discardedRun: header.discardedRun } : {}),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') await fs.rm(file, { force: true });
      return null;
    }
  }
  async function rewrite(file, id, value, lines) {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = path.join(directory, 'meta.json');
    try {
      await fs.access(metadata);
    } catch {
      await atomic(metadata, JSON.stringify(meta));
    }
    let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
    let start = 0;
    let discardedRun;
    while (value.events.length - start > maxEvents || bytes > maxBytes) {
      const run = value.events[start]?.runId;
      if (run === undefined) break;
      discardedRun = runHash(run);
      do {
        bytes -= Buffer.byteLength(lines[start++]);
      } while (start < value.events.length && value.events[start].runId === run);
    }
    const header = {
      format: 1,
      sessionId: id,
      firstSequence: value.events[start]?.sequence ?? 0,
      hasEarlier: value.hasEarlier || start > 0,
      ...(start === value.events.length && discardedRun ? { discardedRun } : {}),
    };
    await atomic(file, JSON.stringify(header) + '\n' + lines.slice(start).join(''));
    scheduleMaintenance();
  }
  async function inventory() {
    const files = [];
    for (const owner of await list(root)) {
      if (!owner.isDirectory() || !ownerHash.test(owner.name)) continue;
      const directory = path.join(root, owner.name);
      for (const entry of await list(directory)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(directory, entry.name);
        try {
          const info = await fs.stat(file);
          files.push({
            file,
            directory,
            id: entry.name.slice(0, -6),
            bytes: info.size,
            mtime: info.mtimeMs,
          });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    return files;
  }
  function scheduleMaintenance() {
    // At most one further scan waits behind the current scan, even with many live panes.
    if (maintenanceQueued) return;
    maintenanceQueued = true;
    maintenance = maintenance
      .catch(() => {})
      .then(async () => {
        maintenanceQueued = false;
        await pause();
        for (const owner of await list(root)) {
          if (!owner.isDirectory() || !ownerHash.test(owner.name)) continue;
          const directory = path.join(root, owner.name);
          for (const entry of await list(directory)) {
            const file = path.join(directory, entry.name);
            if (entry.isFile() && cacheTemporary(entry.name) && !activeTemporaryFiles.has(file))
              await fs.rm(file, { force: true });
          }
          if (Date.now() - (await fs.stat(directory)).mtimeMs > 90 * 86400000)
            await fs.rm(directory, { recursive: true, force: true });
        }
        const files = await inventory();
        let total = files.reduce((sum, entry) => sum + entry.bytes, 0);
        for (const entry of files.sort((a, b) => a.mtime - b.mtime)) {
          if (total <= maxTotalBytes) break;
          if (protectedIds.get(entry.directory)?.has(entry.id) || chains.has(entry.file)) continue;
          await fs.rm(entry.file, { force: true });
          total -= entry.bytes;
        }
      });
    // Background eviction must not turn a successful history read into a rejection.
    void maintenance.catch(() => {});
  }
  const api = {
    open(owner) {
      protectedIds.clear();
      const pending = (async () => {
        if (typeof owner !== 'string' || !owner || owner.length > 4096)
          throw new Error('Invalid history owner');
        await barrier;
        const directory = path.join(root, createHash('sha256').update(owner).digest('hex'));
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') {
          await fs.chmod(root, 0o700);
          await fs.chmod(directory, 0o700);
        }
        let saved;
        try {
          saved = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
        } catch {}
        if (saved?.format !== meta.format || saved?.protocol !== meta.protocol) {
          await fs.rm(directory, { recursive: true, force: true });
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          await atomic(path.join(directory, 'meta.json'), JSON.stringify(meta));
        }
        const now = new Date();
        await fs.utimes(directory, now, now);
        scheduleMaintenance();
        return directory;
      })();
      selected = pending;
      return pending.then(() => {});
    },
    read(id) {
      return operation(id, async (_owner, file) => {
        const value = await readFile(file, id);
        if (!value) return null;
        const { torn: _torn, discardedRun: _discardedRun, ...result } = value;
        return result;
      });
    },
    replace(id, value) {
      return operation(id, async (_owner, file) => {
        if (!value || typeof value.hasEarlier !== 'boolean')
          throw new Error('Invalid history window');
        const lines = await encode(value.events, id);
        if (
          value.firstSequence !== (value.events[0]?.sequence ?? 0) ||
          value.events.some((event, i) => i > 0 && event.sequence <= value.events[i - 1].sequence)
        )
          throw new Error('Invalid history window sequence');
        await rewrite(file, id, value, lines);
      });
    },
    append(id, events) {
      return operation(id, async (_owner, file) => {
        await encode(events, id);
        const old = await readFile(file, id);
        if (!old) throw new Error('Missing history window');
        let last = old.events.at(-1)?.sequence ?? 0;
        let discardedRun = old.discardedRun,
          excludedId;
        const added = events.filter((event) => {
          if (event.sequence <= last) return false;
          last = event.sequence;
          if (discardedRun) {
            if (excludedId === event.runId || runHash(event.runId) === discardedRun) {
              excludedId = event.runId;
              return false;
            }
            discardedRun = undefined;
          }
          return true;
        });
        if (!added.length) return;
        const combined = { ...old, events: [...old.events, ...added] };
        // The 4 MB bound applies to this IPC call, not the old validated window as well.
        const lines = await encode(combined.events, id, inputLimit + maxBytes);
        if (
          old.torn ||
          !old.events.length ||
          combined.events.length > maxEvents ||
          lines.reduce((n, line) => n + Buffer.byteLength(line), 0) > maxBytes
        )
          await rewrite(file, id, combined, lines);
        else {
          await fs.appendFile(file, lines.slice(old.events.length).join(''), { mode: 0o600 });
          scheduleMaintenance();
        }
      });
    },
    remove(id) {
      return operation(id, (_owner, file) => fs.rm(file, { force: true }));
    },
    async protect(ids) {
      if (!Array.isArray(ids)) throw new Error('Invalid protected sessions');
      ids.forEach(sessionId);
      const selection = selected;
      const owner = await selection;
      if (owner && selection === selected) protectedIds.set(owner, new Set(ids));
    },
    async retain(ids) {
      if (!Array.isArray(ids)) throw new Error('Invalid retained sessions');
      ids.forEach(sessionId);
      const owner = await selected;
      if (!owner) return;
      const keep = new Set(ids);
      await Promise.all(
        (await list(owner))
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && !keep.has(e.name.slice(0, -6)))
          .map((e) =>
            operation(
              e.name.slice(0, -6),
              (_owner, file) => fs.rm(file, { force: true }),
              Promise.resolve(owner),
            ),
          ),
      );
    },
    async usage() {
      await barrier;
      return (await inventory()).reduce((n, e) => n + e.bytes, 0);
    },
    clear() {
      const prior = barrier;
      const owner = selected;
      const task = (async () => {
        await prior;
        await owner.catch(() => {});
        await Promise.allSettled([...chains.values()]);
        await maintenance.catch(() => {});
        const bytes = (await inventory()).reduce((n, e) => n + e.bytes, 0);
        await fs.rm(root, { recursive: true, force: true });
        return bytes;
      })();
      barrier = task.catch(() => {});
      return task;
    },
    async idle() {
      await barrier;
      await selected.catch(() => {});
      await Promise.allSettled([...chains.values()]);
      await maintenance.catch(() => {});
    },
  };
  return api;
}
module.exports = { createHistoryCache };
