const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setImmediate: pause } = require('node:timers/promises');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ownerHash = /^[0-9a-f]{64}$/;
const inputLimit = 4 * 1024 * 1024;
const activeTemporaryFiles = new Set();
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
  const now = options.now ?? Date.now;
  const protocols = new Map();
  const states = new Map();
  let lastMaintenance = -Infinity;
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
  function remember(file, value, lines) {
    let latestRunBytes = 0,
      latestRunCount = 0;
    const latestRun = value.events.at(-1)?.runId;
    for (let i = value.events.length - 1; i >= 0 && value.events[i].runId === latestRun; i--) {
      latestRunBytes += Buffer.byteLength(lines[i]);
      latestRunCount++;
    }
    const state = {
      lastSequence: value.events.at(-1)?.sequence ?? 0,
      bytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0),
      count: value.events.length,
      latestRun,
      latestRunBytes,
      latestRunCount,
      torn: value.torn ?? false,
    };
    states.set(file, state);
    return state;
  }
  async function removeFile(file) {
    states.delete(file);
    await fs.rm(file, { force: true });
  }
  function forgetOwner(directory) {
    for (const file of states.keys()) if (path.dirname(file) === directory) states.delete(file);
  }
  async function readFile(file, id) {
    let text;
    try {
      const info = await fs.stat(file);
      if (info.size > inputLimit + 4096) {
        await removeFile(file);
        return null;
      }
      text = await fs.readFile(file, 'utf8');
    } catch {
      states.delete(file);
      return null;
    }
    try {
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
      const events = [];
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
      const value = {
        firstSequence: header.firstSequence,
        hasEarlier: header.hasEarlier,
        events,
        torn,
      };
      remember(
        file,
        value,
        lines.slice(0, events.length).map((line) => line + '\n'),
      );
      return value;
    } catch {
      await removeFile(file);
      return null;
    }
  }
  async function rewrite(file, id, value, lines) {
    let bytes = lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
    let latestStart = value.events.length - 1;
    while (latestStart > 0 && value.events[latestStart - 1].runId === value.events.at(-1).runId)
      latestStart--;
    const latestBytes = lines
      .slice(Math.max(0, latestStart))
      .reduce((total, line) => total + Buffer.byteLength(line), 0);
    if (latestBytes > inputLimit) {
      await removeFile(file);
      return;
    }
    let start = 0;
    while (start < latestStart && (value.events.length - start > maxEvents || bytes > maxBytes)) {
      const run = value.events[start].runId;
      do {
        bytes -= Buffer.byteLength(lines[start++]);
      } while (start < latestStart && value.events[start].runId === run);
    }
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = path.join(directory, 'meta.json');
    try {
      await fs.access(metadata);
    } catch {
      await atomic(metadata, JSON.stringify({ format: 1, protocol: protocols.get(directory) }));
    }
    const kept = {
      firstSequence: value.events[start]?.sequence ?? 0,
      hasEarlier: value.hasEarlier || start > 0,
      events: value.events.slice(start),
    };
    const header = {
      format: 1,
      sessionId: id,
      firstSequence: kept.firstSequence,
      hasEarlier: kept.hasEarlier,
    };
    await atomic(file, JSON.stringify(header) + '\n' + lines.slice(start).join(''));
    remember(file, kept, lines.slice(start));
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
    if (maintenanceQueued || now() - lastMaintenance < 60000) return;
    maintenanceQueued = true;
    maintenance = maintenance
      .catch(() => {})
      .then(async () => {
        maintenanceQueued = false;
        lastMaintenance = now();
        await pause();
        for (const owner of await list(root)) {
          if (!owner.isDirectory() || !ownerHash.test(owner.name)) continue;
          const directory = path.join(root, owner.name);
          for (const entry of await list(directory)) {
            const file = path.join(directory, entry.name);
            if (entry.isFile() && cacheTemporary(entry.name) && !activeTemporaryFiles.has(file))
              await fs.rm(file, { force: true });
          }
          if (now() - (await fs.stat(directory)).mtimeMs > 90 * 86400000) {
            forgetOwner(directory);
            await fs.rm(directory, { recursive: true, force: true });
          }
        }
        const files = await inventory();
        let total = files.reduce((sum, entry) => sum + entry.bytes, 0);
        for (const entry of files.sort((a, b) => a.mtime - b.mtime)) {
          if (total <= maxTotalBytes) break;
          if (protectedIds.get(entry.directory)?.has(entry.id) || chains.has(entry.file)) continue;
          await removeFile(entry.file);
          total -= entry.bytes;
        }
      });
    // Background eviction must not turn a successful history read into a rejection.
    void maintenance.catch(() => {});
  }
  const api = {
    open(owner, protocol) {
      protectedIds.clear();
      const pending = (async () => {
        if (typeof owner !== 'string' || !owner || owner.length > 4096)
          throw new Error('Invalid history owner');
        if (!Number.isSafeInteger(protocol) || protocol <= 0)
          throw new Error('Invalid history protocol');
        const meta = { format: 1, protocol };
        await barrier;
        const directory = path.join(root, createHash('sha256').update(owner).digest('hex'));
        protocols.set(directory, protocol);
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
          forgetOwner(directory);
          await fs.rm(directory, { recursive: true, force: true });
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          await atomic(path.join(directory, 'meta.json'), JSON.stringify(meta));
        }
        const touched = new Date(now());
        await fs.utimes(directory, touched, touched);
        return directory;
      })();
      selected = pending;
      return pending.then(() => {});
    },
    read(id) {
      return operation(id, async (_owner, file) => {
        const value = await readFile(file, id);
        if (!value) return null;
        const { torn: _torn, ...result } = value;
        return result;
      });
    },
    replace(id, value) {
      return operation(id, async (_owner, file) => {
        if (!value || typeof value.hasEarlier !== 'boolean')
          throw new Error('Invalid history window');
        const lines = await encode(value.events, id, Infinity);
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
        const lines = await encode(events, id);
        let state = states.get(file);
        let old;
        if (!state) {
          old = await readFile(file, id);
          state = states.get(file);
        }
        if (!state) throw new Error('Missing history window');
        let last = state.lastSequence;
        const added = [],
          addedLines = [];
        for (let i = 0; i < events.length; i++) {
          if (events[i].sequence <= last) continue;
          last = events[i].sequence;
          added.push(events[i]);
          addedLines.push(lines[i]);
        }
        if (!added.length) return;
        const next = { ...state, lastSequence: last, count: state.count + added.length };
        for (let i = 0; i < added.length; i++) {
          const bytes = Buffer.byteLength(addedLines[i]);
          next.bytes += bytes;
          if (next.latestRun !== added[i].runId) {
            next.latestRun = added[i].runId;
            next.latestRunBytes = 0;
            next.latestRunCount = 0;
          }
          next.latestRunBytes += bytes;
          next.latestRunCount++;
        }
        if (next.latestRunBytes > inputLimit) {
          await removeFile(file);
          return;
        }
        if (
          state.torn ||
          !state.count ||
          ((next.count > maxEvents || next.bytes > maxBytes) && next.count > next.latestRunCount)
        ) {
          old ??= await readFile(file, id);
          if (!old) throw new Error('Missing history window');
          const combined = { ...old, events: [...old.events, ...added] };
          await rewrite(file, id, combined, await encode(combined.events, id, Infinity));
        } else {
          await fs.appendFile(file, addedLines.join(''), { mode: 0o600 });
          states.set(file, next);
        }
      });
    },
    remove(id) {
      return operation(id, (_owner, file) => removeFile(file));
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
              (_owner, file) => removeFile(file),
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
        states.clear();
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
