import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

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
  await cache.open('email|user@example.org|one');
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
  await cache.open('email|user@example.org|two');
  assert.equal(await cache.read(id), null);
  await replace([event(2)]);
  await cache.open('email|user@example.org|one');
  assert.equal((await cache.read(id)).events[0].sequence, 1);
  await cache.open('email|user@example.org|two');
  assert.equal((await cache.read(id)).events[0].sequence, 2);
});
for (const key of ['format', 'protocol'])
  test(`${key} mismatch clears only the selected owner`, async (t) => {
    const { cache, root, replace } = await fixture(t);
    await replace([event(1)]);
    await cache.open('local|other');
    await replace([event(2)]);
    await writeFile(
      path.join(root, hash('local|other'), 'meta.json'),
      JSON.stringify({ format: 1, protocol: 24, [key]: -1 }),
    );
    await cache.open('local|other');
    assert.equal(await cache.read(id), null);
    await cache.open('email|user@example.org|one');
    assert.equal((await cache.read(id)).events.length, 1);
  });
test('rejects unsafe identifiers, malformed events and calls over 4 MB', async (t) => {
  const { cache, replace } = await fixture(t);
  await assert.rejects(cache.read('../escape'));
  await assert.rejects(cache.append(id, [{ sequence: 0, runId: 'x' }]));
  await assert.rejects(cache.append(id, [{ sequence: 1, runId: 1 }]));
  await assert.rejects(replace([{ ...event(1), payload: { text: 'x'.repeat(4 * 1024 * 1024) } }]));
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
  const { cache, root, file, replace } = await fixture(t, { maxTotalBytes: 1300 });
  await cache.protect([id]);
  await replace([event(1)]);
  const otherId = randomUUID();
  await cache.replace(otherId, {
    firstSequence: 1,
    hasEarlier: false,
    events: [{ ...event(1), sessionId: otherId, payload: { text: 'x'.repeat(900) } }],
  });
  await cache.idle();
  assert.ok(await stat(file));
  assert.equal(await cache.read(otherId), null);
  await cache.open('local|other');
  await cache.idle();
  const ownerDir = path.join(root, hash('local|other'));
  const old = new Date(Date.now() - 91 * 86400000);
  await utimes(ownerDir, old, old);
  await cache.open('local|new');
  await cache.idle();
  assert.ok(!(await readdir(root)).includes(hash('local|other')));
});
test('retain reconciles the active owner, clear and usage cover every owner', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([event(1)]);
  await cache.open('local|other');
  await replace([event(2)]);
  await cache.retain([]);
  assert.equal(await cache.read(id), null);
  assert.ok((await cache.usage()) > 0);
  const freed = await cache.clear();
  assert.ok(freed > 0);
  await cache.open('email|user@example.org|one');
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
  await cache.open('local|other');
  await replace([event(2)]);
  await retaining;
  assert.equal((await cache.read(id)).events[0].sequence, 2);
  await cache.open('email|user@example.org|one');
  assert.equal(await cache.read(id), null);
});

test('switching owner releases obsolete LRU protection', async (t) => {
  const { cache, replace, file } = await fixture(t, { maxTotalBytes: 1300 });
  await replace([{ ...event(1), payload: { text: 'x'.repeat(900) } }]);
  await cache.protect([id]);
  await cache.open('local|other');
  await cache.protect([id]);
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

test('appending after an oversized run was entirely trimmed updates the empty window header', async (t) => {
  const { cache, replace } = await fixture(t, { maxBytes: 1024 });
  await replace([{ ...event(1, 'large'), payload: { text: 'x'.repeat(1200) } }]);
  assert.deepEqual((await cache.read(id)).events, []);
  await cache.append(id, [event(2, 'next')]);
  assert.equal((await cache.read(id))?.firstSequence, 2);
});

test('a valid append under 4 MB can exceed the cap together with the old window and is still trimmed', async (t) => {
  const { cache, replace } = await fixture(t);
  await replace([{ ...event(1, 'old'), payload: { text: 'a'.repeat(900000) } }]);
  await cache.append(id, [{ ...event(2, 'large'), payload: { text: 'b'.repeat(3400000) } }]);
  assert.deepEqual((await cache.read(id)).events, []);
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
