import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewPersistence } from '../src/previewPersistence.ts';
import { emptyBoard, openTab, closeTab } from '../src/previewLayout.ts';

const layout = () => ({
  width: 440,
  boards: { session: openTab(emptyBoard(), { id: 'a', kind: 'file', target: 'C:\\a.txt' }) },
});

test('reading updates coalesce with the latest layout without changing its identity', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const writes: string[] = [];
  const owner = createPreviewPersistence('scope', layout(), null, {
    setItem: (_key, value) => writes.push(value),
  });
  const board = owner.layout.boards;
  owner.set('session', 'a', { kind: 'text', top: 700, left: 30 });
  t.mock.timers.tick(400);
  owner.updateLayout({ ...owner.layout, width: 600 });
  t.mock.timers.tick(499);
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(writes.length, 1);
  assert.equal(owner.layout.boards, board);
  const saved = JSON.parse(writes[0]);
  assert.equal(saved.width, 600);
  assert.equal(saved.reading.sessions.session.a.top, 700);
  owner.close();
});

test('continuous scrolling flushes at the maximum wait and stale owners cannot write', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const writes: string[] = [];
  const owner = createPreviewPersistence('old-scope', layout(), null, {
    setItem: (key, value) => writes.push(key + ':' + value),
  });
  for (let index = 0; index < 20; index++) {
    owner.set('session', 'a', { kind: 'text', top: index + 1, left: 0 });
    t.mock.timers.tick(100);
  }
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith('old-scope:'));
  owner.set('session', 'a', { kind: 'text', top: 900, left: 0 });
  owner.close();
  assert.equal(writes.length, 2);
  owner.set('session', 'a', { kind: 'text', top: 1000, left: 0 });
  t.mock.timers.tick(3000);
  owner.flush();
  assert.equal(writes.length, 2);
});

test('closing tabs prunes positions and rejects late unmount writes', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const owner = createPreviewPersistence('scope', layout(), null, { setItem() {} });
  owner.set('session', 'a', { kind: 'text', top: 700, left: 0 });
  owner.updateLayout({
    ...owner.layout,
    boards: { session: closeTab(owner.layout.boards.session, 'a') },
  });
  owner.set('session', 'a', { kind: 'text', top: 800, left: 0 });
  assert.equal(owner.get('session', 'a'), undefined);
  assert.equal(Object.keys(owner.reading).length, 0);
  owner.close();
});

test('unwritable local storage preserves current in-memory reading and never throws', () => {
  const owner = createPreviewPersistence('scope', layout(), null, {
    setItem() {
      throw new Error('quota');
    },
  });
  owner.set('session', 'a', { kind: 'text', top: 700, left: 0 });
  assert.doesNotThrow(() => owner.flush());
  const saved = owner.get('session', 'a');
  assert.equal(saved?.kind, 'text');
  if (saved?.kind === 'text') assert.equal(saved.top, 700);
  assert.doesNotThrow(() => owner.close());
});

test('dangerous tab identifiers cannot create or read inherited reading entries', () => {
  const input = layout();
  input.boards.session = openTab(input.boards.session, {
    id: '__proto__',
    kind: 'file',
    target: 'C:\\unsafe.txt',
  });
  const owner = createPreviewPersistence('scope', input, null, { setItem() {} });
  owner.set('session', 'a', { kind: 'text', top: 700, left: 0 });
  assert.equal(owner.get('session', '__proto__'), undefined);
  owner.set('session', '__proto__', { kind: 'text', top: 900, left: 0 });
  assert.equal(owner.get('session', '__proto__'), undefined);
  owner.close();
});

test('valid identifiers matching Object prototype names keep their own dictionaries', (t) => {
  t.after(() => {
    delete (Object.prototype.toString as unknown as Record<string, unknown>).a;
  });
  const input = layout();
  const owner = createPreviewPersistence(
    'scope',
    {
      ...input,
      boards: { toString: input.boards.session },
    },
    null,
    { setItem() {} },
  );
  owner.set('toString', 'a', { kind: 'text', top: 70, left: 0 });
  assert.equal(Object.hasOwn(owner.reading, 'toString'), true);
  assert.equal(Object.hasOwn(Object.prototype.toString, 'a'), false);
  assert.deepEqual(owner.get('toString', 'a'), { kind: 'text', top: 70, left: 0 });
  owner.close();
});

test('flush samples the latest DOM position before serialization, independent of event listener order', () => {
  const writes: string[] = [];
  const owner = createPreviewPersistence('scope', layout(), null, {
    setItem: (_key, value) => writes.push(value),
  });
  let top = 700;
  const remove = owner.beforeFlush(() => owner.set('session', 'a', { kind: 'text', top, left: 0 }));
  owner.flush();
  top = 1700;
  owner.flush();
  assert.equal(JSON.parse(writes[1]).reading.sessions.session.a.top, 1700);
  remove();
  top = 2300;
  owner.close();
  assert.equal(writes.length, 2);
});
