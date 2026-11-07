import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const hash = (owner) => createHash('sha256').update(owner).digest('hex');
const id = randomUUID();
const event = (sequence, runId = `run-${sequence}`) => ({
  sessionId: id,
  sequence,
  runId,
  createdAt: '2026-11-08T00:00:00.000Z',
  payload: { type: 'text.delta', messageId: id, text: `event ${sequence}` },
});
async function fixture(t, options = {}) {
  const { createHistoryCache } = require('../electron/history-cache.cjs');
  const root = await mkdtemp(path.join(tmpdir(), 'cc-history-'));
  const cache = createHistoryCache(root, options);
  t.after(async () => {
    await cache.idle();
    await import('node:fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true }));
  });
  await cache.open('email|user@example.org|one', 24);
  const file = path.join(root, hash('email|user@example.org|one'), `${id}.jsonl`);
  const replace = (events, hasEarlier = false) =>
    cache.replace(id, { firstSequence: events[0]?.sequence ?? 0, hasEarlier, events });
  return { cache, root, file, replace };
}
test('appends increasing sequences, rewrites and serializes concurrent session writes', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([event(2)]);
  await Promise.all([
    cache.append(id, [event(1), event(3)]),
    cache.append(id, [event(3), event(7)]),
  ]);
  assert.deepEqual(
    (await cache.read(id)).events.map((e) => e.sequence),
    [2, 3, 7],
  );
  await replace([event(9)], true);
  assert.deepEqual(await cache.read(id), {
    firstSequence: 9,
    hasEarlier: true,
    events: [event(9)],
  });
});
test('ignores a torn final line and repairs it before appending; middle corruption deletes the file', async (t) => {
  const { cache, file, replace } = await fixture(t);
  await replace([event(1)]);
  await writeFile(file, (await readFile(file, 'utf8')) + '{"sequence":');
  assert.equal((await cache.read(id)).events.length, 1);
  await cache.append(id, [event(2)]);
  assert.equal((await cache.read(id)).events.length, 2);
  await writeFile(file, (await readFile(file, 'utf8')).replace(JSON.stringify(event(1)), '{bad'));
  assert.equal(await cache.read(id), null);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});
test('owner directories isolate the same session and survive switching back and forth', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.open('email|user@example.org|two', 24);
  assert.equal(await cache.read(id), null);
  await replace([event(2)]);
  await cache.open('email|user@example.org|one', 24);
  assert.equal((await cache.read(id)).events[0].sequence, 1);
  await cache.open('email|user@example.org|two', 24);
  assert.equal((await cache.read(id)).events[0].sequence, 2);
});
for (const key of ['format', 'protocol'])
  test(`${key} mismatch clears only the selected owner`, async (t) => {
    const { cache, root, replace } = await fixture(t);
    await replace([event(1)]);
    await cache.open('local|other', 24);
    await replace([event(2)]);
    await writeFile(
      path.join(root, hash('local|other'), 'meta.json'),
      JSON.stringify({ format: 1, protocol: 24, [key]: -1 }),
    );
    await cache.open('local|other', 24);
    assert.equal(await cache.read(id), null);
    await cache.open('email|user@example.org|one', 24);
    assert.equal((await cache.read(id)).events.length, 1);
  });
test('rejects unsafe identifiers, malformed events and calls over 4 MB', async (t) => {
  const { cache, replace } = await fixture(t);
  await assert.rejects(cache.read('../escape'));
  await assert.rejects(cache.append(id, [{ sequence: 0, runId: 'x' }]));
  await assert.rejects(cache.append(id, [{ sequence: 1, runId: 1 }]));
  await assert.rejects(
    cache.append(id, [{ ...event(1), payload: { text: 'x'.repeat(4 * 1024 * 1024) } }]),
  );
});
test('trims whole runs by event count and byte size', async (t) => {
  const { cache, replace } = await fixture(t, { maxEvents: 3, maxBytes: 1024 });
  await replace([event(1, 'a'), event(2, 'a'), event(3, 'b'), event(4, 'b')]);
  assert.deepEqual(
    (await cache.read(id)).events.map((e) => e.sequence),
    [3, 4],
  );
  assert.equal((await cache.read(id)).hasEarlier, true);
  await replace([{ ...event(1), payload: { text: 'x'.repeat(1100) } }, event(2)]);
  assert.deepEqual(
    (await cache.read(id)).events.map((e) => e.sequence),
    [2],
  );
});
test('global LRU skips protected sessions across owners and expires unused owners after 90 days', async (t) => {
  let now = Date.now();
  const { cache, root, file, replace } = await fixture(t, { maxTotalBytes: 1300, now: () => now });
  await cache.idle();
  now += 60000;
  await cache.protect([id]);
  await replace([event(1)]);
  await cache.idle();
  now += 60000;
  const otherId = randomUUID();
  await cache.replace(otherId, {
    firstSequence: 1,
    hasEarlier: false,
    events: [{ ...event(1), sessionId: otherId, payload: { text: 'x'.repeat(900) } }],
  });
  await cache.idle();
  assert.ok(await stat(file));
  assert.equal(await cache.read(otherId), null);
  await cache.open('local|other', 24);
  await cache.idle();
  const ownerDir = path.join(root, hash('local|other'));
  const old = new Date(Date.now() - 91 * 86400000);
  await utimes(ownerDir, old, old);
  now += 60000;
  await cache.open('local|new', 24);
  await replace([event(3)]);
  await cache.idle();
  assert.ok(!(await readdir(root)).includes(hash('local|other')));
});
test('retain reconciles the active owner, clear and usage cover every owner', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.open('local|other', 24);
  await replace([event(2)]);
  await cache.retain([]);
  assert.equal(await cache.read(id), null);
  assert.ok((await cache.usage()) > 0);
  const freed = await cache.clear();
  assert.ok(freed > 0);
  await cache.open('email|user@example.org|one', 24);
  assert.equal(await cache.read(id), null);
});

test('clear waits for submitted writes and concurrent reads do not resurrect deleted records', async (t) => {
  const { cache, replace } = await fixture(t);
  const writing = replace(Array.from({ length: 2000 }, (_, i) => event(i + 1)));
  const clearing = cache.clear();
  await Promise.all([writing, clearing]);
  assert.equal(await cache.read(id), null);
});
test('owner switches bind pending reconciliation to the original directory', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([event(1)]);
  const retaining = cache.retain([]);
  await cache.open('local|other', 24);
  await replace([event(2)]);
  await retaining;
  assert.equal((await cache.read(id)).events[0].sequence, 2);
  await cache.open('email|user@example.org|one', 24);
  assert.equal(await cache.read(id), null);
});

test('switching owner releases obsolete LRU protection', async (t) => {
  let now = Date.now();
  const { cache, replace, file } = await fixture(t, { maxTotalBytes: 1300, now: () => now });
  await replace([{ ...event(1), payload: { text: 'x'.repeat(900) } }]);
  await cache.protect([id]);
  await cache.open('local|other', 24);
  await cache.protect([id]);
  await cache.idle();
  now += 60000;
  await replace([{ ...event(2), payload: { text: 'y'.repeat(900) } }]);
  await cache.idle();
  assert.equal((await cache.read(id)).events[0].sequence, 2);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('clear removes the directory entirely and a later proven replacement recreates its metadata', async (t) => {
  const { cache, root, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.clear();
  await assert.rejects(stat(root), { code: 'ENOENT' });
  await replace([event(2)]);
  assert.equal((await cache.read(id)).events[0].sequence, 2);
});

test('retains the newest whole run above both soft caps', async (t) => {
  const { cache, replace } = await fixture(t, { maxEvents: 2, maxBytes: 1024 });
  const events = [
    event(1, 'a'),
    event(2, 'b'),
    event(3, 'b'),
    { ...event(4, 'b'), payload: { text: 'x'.repeat(1200) } },
  ];
  await replace(events);
  assert.deepEqual((await cache.read(id)).events, events.slice(1));
  await cache.append(id, [event(5, 'b')]);
  assert.equal((await cache.read(id)).events.length, 4);
});

test('replace trims a 6 MB input and skips only a newest run above 4 MiB', async (t) => {
  const { cache, replace } = await fixture(t);
  const large = (sequence, runId, size) => ({
    ...event(sequence, runId),
    payload: { text: 'x'.repeat(size) },
  });
  await replace([large(1, 'a', 3000000), large(2, 'b', 3000000)]);
  assert.deepEqual(
    (await cache.read(id)).events.map((e) => e.sequence),
    [2],
  );
  await cache.append(id, [large(3, 'b', 1300000)]);
  assert.equal(await cache.read(id), null);
  await replace([large(4, 'c', 4300000)]);
  assert.equal(await cache.read(id), null);
  await replace([event(5)]);
  assert.equal((await cache.read(id)).firstSequence, 5);
});

test('a complete final JSON record without newline remains separated from a later append', async (t) => {
  const { cache, file, replace } = await fixture(t);
  await replace([event(1)]);
  await writeFile(file, (await readFile(file, 'utf8')).trimEnd());
  assert.equal((await cache.read(id)).events.length, 1);
  await cache.append(id, [event(2)]);
  assert.deepEqual(
    (await cache.read(id))?.events.map((e) => e.sequence),
    [1, 2],
  );
});

test('normal appends neither read the window nor scan directories; rewrite scans are throttled', async (t) => {
  let now = Date.now();
  const { cache, replace, file } = await fixture(t, { now: () => now, maxEvents: 4 });
  await cache.idle();
  const fs = require('node:fs/promises');
  const reading = t.mock.method(fs, 'readFile');
  const scanning = t.mock.method(fs, 'readdir');
  await replace([event(1)]);
  await cache.idle();
  reading.mock.resetCalls();
  scanning.mock.resetCalls();
  await cache.append(id, [event(2)]);
  await cache.append(id, [event(3)]);
  await cache.idle();
  assert.equal(reading.mock.callCount(), 0);
  assert.equal(scanning.mock.callCount(), 0);
  await replace([event(4)]);
  await cache.idle();
  assert.equal(scanning.mock.callCount(), 0);
  now += 60000;
  await replace([event(5)]);
  await cache.idle();
  assert.ok(scanning.mock.callCount() > 0);
  reading.mock.resetCalls();
  scanning.mock.resetCalls();
  await replace([event(6)]);
  await cache.idle();
  assert.equal(scanning.mock.callCount(), 0);
  assert.ok(await stat(file));
});

test('a reopened session reads once lazily, then appends using remembered state', async (t) => {
  const { cache, root, file, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.idle();
  const reopened = require('../electron/history-cache.cjs').createHistoryCache(root);
  await reopened.open('email|user@example.org|one', 24);
  await reopened.idle();
  const fs = require('node:fs/promises');
  const reads = t.mock.method(fs, 'readFile');
  await reopened.append(id, [event(2)]);
  await reopened.append(id, [event(3)]);
  await reopened.idle();
  assert.equal(reads.mock.calls.filter((call) => call.arguments[0] === file).length, 1);
  assert.deepEqual(
    (await reopened.read(id)).events.map((e) => e.sequence),
    [1, 2, 3],
  );
});

test('an oversized latest run removes only its session and preserves another session', async (t) => {
  const { cache, replace } = await fixture(t);
  const other = randomUUID();
  await cache.replace(other, {
    firstSequence: 1,
    hasEarlier: false,
    events: [{ ...event(1), sessionId: other }],
  });
  await replace([{ ...event(1, 'large'), payload: { text: 'x'.repeat(3000000) } }]);
  await cache.append(id, [{ ...event(2, 'large'), payload: { text: 'x'.repeat(1300000) } }]);
  assert.equal(await cache.read(id), null);
  await cache.append(other, [{ ...event(2), sessionId: other }]);
  assert.equal((await cache.read(other)).events.length, 2);
});

test('protocol is required, validated, and invalidates only the changed owner', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.open('local|other', 25);
  await replace([event(2)]);
  await cache.open('email|user@example.org|one', 25);
  assert.equal(await cache.read(id), null);
  await cache.open('local|other', 25);
  assert.equal((await cache.read(id)).firstSequence, 2);
  for (const protocol of [undefined, 0, -1, 1.5, '24', Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(cache.open('invalid', protocol), /protocol/i);
});

for (const code of ['EBUSY', 'EPERM'])
  test(`transient ${code} read failures preserve the file`, async (t) => {
    const { cache, file, replace } = await fixture(t);
    await replace([event(1)]);
    await cache.idle();
    const fs = require('node:fs/promises'),
      original = fs.readFile;
    const mocked = t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === file) throw Object.assign(new Error('locked'), { code });
      return original(target, ...args);
    });
    assert.equal(await cache.read(id), null);
    mocked.mock.restore();
    assert.ok(await stat(file));
    assert.equal((await cache.read(id)).firstSequence, 1);
  });

test('a parse failure still returns null if removing the damaged file is temporarily denied', async (t) => {
  const { cache, file, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.idle();
  await writeFile(file, '{bad');
  const fs = require('node:fs/promises'),
    remove = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === file) throw Object.assign(Error('locked'), { code: 'EPERM' });
    return remove(target, ...args);
  });
  assert.equal(await cache.read(id), null);
  mocked.mock.restore();
  assert.ok(await stat(file));
});

for (const code of ['EBUSY', 'EPERM'])
  test(`transient ${code} metadata reads cannot erase an owner`, async (t) => {
    const { cache, file, replace } = await fixture(t);
    await replace([event(1)]);
    await cache.idle();
    const fs = require('node:fs/promises'),
      read = fs.readFile,
      meta = path.join(path.dirname(file), 'meta.json');
    const mocked = t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === meta) throw Object.assign(Error('locked'), { code });
      return read(target, ...args);
    });
    await assert.rejects(cache.open('email|user@example.org|one', 24), { code });
    mocked.mock.restore();
    assert.ok(await stat(file));
    await cache.open('email|user@example.org|one', 24);
    assert.deepEqual((await cache.read(id)).events, [event(1)]);
  });

test('protocol invalidation waits for earlier owner writes and cannot resurrect old events', async (t) => {
  const { cache, root, file, replace } = await fixture(t),
    directory = path.dirname(file),
    meta = path.join(directory, 'meta.json');
  const fs = require('node:fs/promises'),
    access = fs.access,
    mkdir = fs.mkdir,
    read = fs.readFile,
    remove = fs.rm,
    chmod = fs.chmod;
  let release,
    arrive,
    held = true,
    firstDirectory = true,
    invalidatedWhileWriting = false;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    arrived = new Promise((resolve) => {
      arrive = resolve;
    });
  t.mock.method(fs, 'access', async (target, ...args) => {
    if (target === meta && held) {
      arrive();
      await waiting;
    }
    return access(target, ...args);
  });
  const writing = replace([event(1)]);
  await arrived;
  // Resolve harmless metadata reads immediately so the old implementation reaches
  // invalidation before the next turn, without a timing-dependent sleep.
  t.mock.method(fs, 'mkdir', async (target, ...args) => {
    if (held && target === directory && firstDirectory) {
      firstDirectory = false;
      return;
    }
    return mkdir(target, ...args);
  });
  t.mock.method(fs, 'chmod', async (target, ...args) => {
    if (held && (target === directory || target === root)) return;
    return chmod(target, ...args);
  });
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (held && target === meta) return JSON.stringify({ format: 1, protocol: 24 });
    return read(target, ...args);
  });
  t.mock.method(fs, 'rm', async (target, ...args) => {
    if (target === directory && held) invalidatedWhileWriting = true;
    return remove(target, ...args);
  });
  const opening = cache.open('email|user@example.org|one', 25);
  await new Promise((resolve) => setImmediate(resolve));
  held = false;
  release();
  const results = await Promise.allSettled([writing, opening]);
  assert.equal(invalidatedWhileWriting, false);
  for (const result of results) assert.equal(result.status, 'fulfilled');
  assert.equal(await cache.read(id), null);
  assert.equal(JSON.parse(await read(meta, 'utf8')).protocol, 25);
});

test('rewrite maintenance reclaims a flushed atomic temporary left by abrupt process exit', async (t) => {
  const { cache, root, file } = await fixture(t);
  await cache.idle();
  const modulePath = require.resolve('../electron/history-cache.cjs');
  const script = `(async()=>{const fs=require('node:fs/promises');const {createHistoryCache}=require(${JSON.stringify(modulePath)});const cache=createHistoryCache(${JSON.stringify(root)});await cache.open('email|user@example.org|one', 24);await cache.idle();const rename=fs.rename;fs.rename=async(from,to)=>{if(to===${JSON.stringify(file)})process.exit(77);return rename(from,to);};await cache.replace(${JSON.stringify(id)},{firstSequence:1,hasEarlier:false,events:[${JSON.stringify(event(1))}]});})().catch(()=>process.exit(1));`;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(child.status, 77, child.stderr);
  assert.ok((await readdir(path.dirname(file))).some((name) => name.endsWith('.tmp')));
  const restarted = require('../electron/history-cache.cjs').createHistoryCache(root);
  await restarted.open('email|user@example.org|one', 24);
  const other = randomUUID();
  await restarted.replace(other, {
    firstSequence: 1,
    hasEarlier: false,
    events: [{ ...event(1), sessionId: other }],
  });
  await restarted.idle();
  assert.ok(!(await readdir(path.dirname(file))).some((name) => name.endsWith('.tmp')));
});

test('orphan cleanup never removes an atomic temporary file still being written', async (t) => {
  const { cache, root, file, replace } = await fixture(t);
  await cache.idle();
  const fs = require('node:fs/promises'),
    rename = fs.rename;
  let release, arrive;
  const waiting = new Promise((resolve) => {
      release = resolve;
    }),
    arrived = new Promise((resolve) => {
      arrive = resolve;
    });
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === file) {
      arrive(from);
      await waiting;
    }
    return rename(from, to);
  });
  const writing = replace([event(1)]);
  const temporary = await arrived;
  try {
    const other = require('../electron/history-cache.cjs').createHistoryCache(root);
    await other.open('local|maintenance', 24);
    const otherId = randomUUID();
    await other.replace(otherId, {
      firstSequence: 1,
      hasEarlier: false,
      events: [{ ...event(1), sessionId: otherId }],
    });
    await other.idle();
    assert.ok(await stat(temporary));
  } finally {
    release();
    await writing;
  }
  assert.equal((await cache.read(id)).events.length, 1);
});
