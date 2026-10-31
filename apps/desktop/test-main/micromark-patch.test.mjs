import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const patch = await import('../../../scripts/patch-micromark.mjs').catch(() => ({}));
const installed = fileURLToPath(new URL('../../../node_modules/micromark/', import.meta.url));
const hash = (source) => createHash('sha256').update(source).digest('hex');

function api() {
  assert.equal(typeof patch.applyMicromarkPatch, 'function', 'guarded patch API exists');
  assert.equal(typeof patch.patchMicromarkSource, 'function', 'pure source transform exists');
  return patch;
}

async function originals() {
  const { micromarkSourceVariants } = api();
  return Promise.all(
    micromarkSourceVariants.map(async (variant) => {
      let source = await readFile(join(installed, variant.path), 'utf8');
      if (hash(source) === variant.patchedSha256) {
        source = source.replace(variant.replacement, variant.original);
      }
      assert.equal(hash(source), variant.originalSha256);
      return { ...variant, source };
    }),
  );
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-micromark-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'micromark', version: '4.0.3' }),
  );
  const files = await originals();
  for (const variant of files) {
    await mkdir(dirname(join(directory, variant.path)), { recursive: true });
    await writeFile(join(directory, variant.path), variant.source);
  }
  return { directory, files };
}

function resolver(source) {
  const start = source.indexOf('function createResolver(extraResolver)');
  const end = source.indexOf('/**\n * A rather ugly', start);
  assert.ok(start >= 0 && end > start);
  return new Function('types', `${source.slice(start, end)}\nreturn createResolver;`)({
    data: 'data',
  });
}

function eventsFor(kinds) {
  const context = { name: 'tokenizer' };
  return kinds.flatMap((type, i) => {
    const token = { type, start: { offset: i }, end: { offset: i + 1 }, custom: i };
    return [
      ['enter', token, context],
      ['exit', token, context],
    ];
  });
}

test('patches both pinned sources and is idempotent', async (t) => {
  const { applyMicromarkPatch } = api();
  const { directory, files } = await fixture(t);
  assert.equal(applyMicromarkPatch(directory).changed.length, 2);
  for (const variant of files) {
    assert.equal(hash(await readFile(join(directory, variant.path))), variant.patchedSha256);
  }
  assert.deepEqual(applyMicromarkPatch(directory), { version: '4.0.3', changed: [] });
});

test('rejects unknown versions before touching sources', async (t) => {
  const { applyMicromarkPatch } = api();
  const { directory, files } = await fixture(t);
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'micromark', version: '4.0.4' }),
  );
  assert.throws(() => applyMicromarkPatch(directory), /micromark.*4\.0\.4.*4\.0\.3/i);
  for (const variant of files)
    assert.equal(await readFile(join(directory, variant.path), 'utf8'), variant.source);
});

test('validates the whole second file before writing the first', async (t) => {
  const { applyMicromarkPatch, patchMicromarkSource } = api();
  const { directory, files } = await fixture(t);
  await writeFile(join(directory, files[1].path), `${files[1].source}\n// unknown change\n`);
  assert.throws(
    () => applyMicromarkPatch(directory),
    /micromark.*source.*dev\/lib\/initialize\/text\.js/i,
  );
  assert.equal(await readFile(join(directory, files[0].path), 'utf8'), files[0].source);
  assert.throws(() => patchMicromarkSource(`${files[0].source}\n`, files[0].path), /source/i);
  assert.throws(() => patchMicromarkSource(files[0].source, 'unrecognized.js'), /unsupported/i);
});

test('pure transformations preserve resolver behavior and every retained identity for 2047 patterns', async () => {
  const { patchMicromarkSource } = api();
  for (const variant of await originals()) {
    const original = resolver(variant.source)();
    const transformed = patchMicromarkSource(variant.source, variant.path);
    assert.equal(hash(transformed), variant.patchedSha256);
    assert.equal(patchMicromarkSource(transformed, variant.path), transformed);
    const compacted = resolver(transformed)();
    let patterns = 0;
    for (let width = 0; width <= 10; width++) {
      for (let mask = 0; mask < 2 ** width; mask++) {
        const kinds = Array.from({ length: width }, (_, i) =>
          mask & (1 << i) ? 'data' : 'lineEnding',
        );
        const before = eventsFor(kinds);
        const after = eventsFor(kinds);
        const beforeIds = new Map(before.map((event, i) => [event, i]));
        const afterIds = new Map(after.map((event, i) => [event, i]));
        const tokens = after.map((event) => event[1]);
        const ends = after.map((event) => event[1].end);
        assert.equal(original(before, {}), before);
        assert.equal(compacted(after, {}), after);
        assert.deepEqual(after, before);
        assert.deepEqual(
          after.map((event) => afterIds.get(event)),
          before.map((event) => beforeIds.get(event)),
        );
        for (const event of after) {
          const id = afterIds.get(event);
          assert.equal(event[1], tokens[id]);
          assert.ok(ends.includes(event[1].end));
        }
        patterns++;
      }
    }
    assert.equal(patterns, 2047);
  }
});

test('retains standalone nondata events and delegates line suffixes after compaction', async () => {
  const { patchMicromarkSource } = api();
  for (const variant of await originals()) {
    const context = { suffix: true };
    const events = eventsFor(['data', 'data']);
    const first = events[0];
    const exit = events[1];
    const finalEnd = events[3][1].end;
    const wrapper = ['enter', { type: 'paragraph' }, context];
    events.unshift(wrapper);
    events.push(['exit', wrapper[1], context]);
    const output = [];
    let calls = 0;
    const resolve = resolver(patchMicromarkSource(variant.source, variant.path))((
      resolved,
      received,
    ) => {
      calls++;
      assert.equal(resolved, events);
      assert.equal(received, context);
      assert.equal(resolved[0], wrapper);
      assert.equal(resolved[1], first);
      assert.equal(resolved[2], exit);
      assert.equal(first[1].end, finalEnd);
      assert.equal(resolved.length, 4);
      return output;
    });
    assert.equal(resolve(events, context), output);
    assert.equal(calls, 1);
  }
});

test('tracks upstream provenance and preserves the complete MIT license', async () => {
  api();
  const notice = await readFile(
    new URL('../../../patches/micromark-4.0.3.md', import.meta.url),
    'utf8',
  );
  const license = await readFile(join(installed, 'license'), 'utf8');
  assert.ok(notice.includes(license.trim()));
  assert.match(notice, /https:\/\/github\.com\/micromark\/micromark\/pull\/233/);
  assert.match(notice, /a35dc80be379e8d6075426c76bbcbb4931e23bb6/);
  assert.match(notice, /unmerged/i);
});
