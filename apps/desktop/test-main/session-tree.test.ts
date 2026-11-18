import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@cc-desk-tunnel/protocol';
import { forkRows, withAncestors } from '../src/sessionTree.ts';

let clock = 0;
const session = (id: string, forkedFromSessionId?: string): Session =>
  ({
    id,
    title: `t-${id}`,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, clock++)).toISOString(),
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
  }) as Session;
const shape = (rows: ReturnType<typeof forkRows>) =>
  rows.map((row) => `${'  '.repeat(row.depth)}${row.session.id}${row.last ? '.' : ''}`);

test('a list without forks is as it was', () => {
  const list = ['c', 'a', 'b'].map((id) => session(id));
  assert.deepEqual(shape(forkRows(list)), ['c', 'a', 'b']);
});

test('forks go under their source, in the list’s order, at any depth', () => {
  // Newest first, as the sidebar lists them: a fork worked on lately brings its family up.
  const list = [
    session('grandchild', 'child'),
    session('other'),
    session('child', 'root'),
    session('root'),
    session('second', 'root'),
  ];
  assert.deepEqual(shape(forkRows(list)), [
    'root',
    '  child',
    '    grandchild.',
    '  second.',
    'other',
  ]);
  assert.equal(forkRows(list)[1].parentTitle, 't-root');
});

test('a fork whose source is not in the list stands at the top; one of itself is no fork', () => {
  const list = [session('orphan', 'gone'), session('self', 'self'), session('x')];
  assert.deepEqual(shape(forkRows(list)), ['orphan', 'self', 'x']);
});

test('a loop is broken at its oldest member, and no row is lost', () => {
  const a = session('a', 'c');
  const b = session('b', 'a');
  const c = session('c', 'b');
  const rows = forkRows([c, b, a]);
  assert.deepEqual(shape(rows), ['a', '  b.', '    c.']);
  const two = forkRows([session('p', 'q'), session('q', 'p')]);
  assert.equal(two.length, 2);
  assert.equal(two[0].depth, 0);
});

test('depth is not cut, however deep', () => {
  const list = [session('l0')];
  for (let level = 1; level <= 7; level++) list.push(session(`l${level}`, `l${level - 1}`));
  assert.deepEqual(
    forkRows(list).map((row) => row.depth),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

test('a shortened list keeps the sources of the forks it keeps', () => {
  const root = session('root');
  const child = session('child', 'root');
  const members = [child, session('m1'), session('m2'), root];
  assert.deepEqual(
    withAncestors([child], members).map((item) => item.id),
    ['child', 'root'],
  );
});

test('a line goes on through a fork’s forks to a later fork of the same source', () => {
  const list = [
    session('root'),
    session('a', 'root'),
    session('g', 'a'),
    session('gg', 'g'),
    session('b', 'root'),
  ];
  const rows = forkRows(list);
  assert.deepEqual(
    rows.map((row) => [row.session.id, row.rails]),
    [
      ['root', []],
      ['a', []],
      ['g', [true]],
      ['gg', [true, false]],
      ['b', []],
    ],
  );
  // Past the last fork, nothing goes on.
  const tail = forkRows([session('r'), session('x', 'r'), session('y', 'x')]);
  assert.deepEqual(
    tail.map((row) => row.rails),
    [[], [], [false]],
  );
});

test('a loop with a tail keeps the tail under it', () => {
  const t1 = session('a', 'c');
  const t2 = session('b', 'a');
  const t3 = session('c', 'b');
  const tail = session('t', 'a');
  assert.deepEqual(shape(forkRows([tail, t3, t2, t1])), ['a', '  t', '  b.', '    c.']);
});
