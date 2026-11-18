import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { knownRecent, matchScore, pushRecent, rank } from '../src/palette.ts';
import type { PaletteItem } from '../src/palette.ts';
import { keyFor } from '../src/shortcuts.ts';
import type { Prefs } from '../src/prefs.ts';

const item = (id: string, group: PaletteItem['group'], label: string, extra = {}): PaletteItem => ({
  id,
  group,
  label,
  run: () => {},
  ...extra,
});
const ids = (sections: ReturnType<typeof rank>) =>
  sections.map((section) => [section.group, section.items.map((entry) => entry.id)]);

test('a query ranks a label’s start before a word’s, before anywhere, before letters in order', () => {
  const items = [
    item('a', 'session', 'my report'),
    item('b', 'session', 'report draft'),
    item('c', 'session', 'misreported'),
    item('d', 'session', 'r-e-p-o-r-t'),
    item('e', 'session', '无关'),
  ];
  assert.deepEqual(ids(rank(items, 'report', [])), [['session', ['b', 'a', 'c', 'd']]]);
  assert.equal(matchScore(item('x', 'setting', '设置：快捷键', { keywords: 'kjj' }), 'kjj'), 1);
  // Every word must match.
  assert.deepEqual(ids(rank(items, 'report draft', [])), [['session', ['b']]]);
});

test('groups come in order with their limits; a slash looks among slash commands alone', () => {
  const items = [
    ...Array.from({ length: 12 }, (_, index) =>
      item(`s${index}`, 'session', `会话 ${index}`, { updatedAt: `2026-11-${10 + index}` }),
    ),
    item('p', 'project', '项目'),
    item('set', 'setting', '设置：通知'),
    item('cmd', 'command', '/review'),
    item('act', 'action', '新建会话'),
  ];
  const sections = rank(items, '', []);
  assert.deepEqual(
    sections.map((section) => section.group),
    ['session', 'project', 'action', 'setting', 'command'],
  );
  // Newest first among equals, eight at most.
  assert.deepEqual(sections[0].items.map((entry) => entry.id).slice(0, 2), ['s11', 's10']);
  assert.equal(sections[0].items.length, 8);
  assert.deepEqual(ids(rank(items, '/rev', [])), [['command', ['cmd']]]);
  assert.deepEqual(ids(rank(items, '/', [])), [['command', ['cmd']]]);
});

test('what was used lately leads with nothing typed, and counts among equals when something is', () => {
  const items = [
    item('x', 'session', '甲'),
    item('y', 'session', '甲乙'),
    item('z', 'setting', '设置'),
  ];
  assert.deepEqual(ids(rank(items, '', ['z', 'gone'])), [
    ['recent', ['z']],
    ['session', ['x', 'y']],
  ]);
  assert.deepEqual(
    ids(rank([item('m', 'session', 'ab'), item('n', 'session', 'ab')], 'ab', ['n'])),
    [['session', ['n', 'm']]],
  );
  assert.deepEqual(pushRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.equal(
    pushRecent(
      Array.from({ length: 8 }, (_, index) => `${index}`),
      'new',
    ).length,
    8,
  );
  assert.deepEqual(knownRecent(['a', 3, null, 'b']), ['a', 'b']);
  assert.deepEqual(knownRecent('nope'), []);
});

test('Ctrl+K is the palette’s unless the user gave it to something else; the search keeps what it was given', () => {
  const prefs = (keys: Record<string, string>) =>
    ({ shortcuts: { enabled: true, keys } }) as unknown as Prefs;
  const cases: [Record<string, string>, string, string][] = [
    [{}, 'Ctrl+KeyK', ''],
    [{ search: 'Ctrl+KeyJ' }, 'Ctrl+KeyK', 'Ctrl+KeyJ'],
    [{ search: 'Ctrl+KeyK' }, '', 'Ctrl+KeyK'],
    [{ search: '' }, 'Ctrl+KeyK', ''],
    [{ find: 'Ctrl+KeyK' }, '', ''],
    [{ palette: 'Ctrl+KeyP' }, 'Ctrl+KeyP', ''],
  ];
  for (const [keys, palette, search] of cases) {
    assert.equal(keyFor(prefs(keys), 'palette'), palette, JSON.stringify(keys));
    assert.equal(keyFor(prefs(keys), 'search'), search, JSON.stringify(keys));
  }
  // Defaults stand where nothing was set.
  assert.equal(keyFor(prefs({}), 'newSession'), 'Ctrl+KeyN');
});

test('the palette asks the service nothing: its modules reach no network or client', () => {
  for (const file of ['palette.ts', 'CommandPalette.tsx']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const banned of [
      /from '\.\/client\.ts'/,
      /\bfetch\(/,
      /WebSocket/,
      /window\.desktop/,
      /XMLHttpRequest/,
      /\.request\(/,
    ])
      assert.ok(!banned.test(source), `${file}: ${banned}`);
  }
});

test('a session put away is found by a query only, not listed nor recalled with nothing typed', () => {
  const items = [
    item('session:a', 'session', '归档的报告', { onlyWhenTyped: true }),
    item('session:b', 'session', '活跃的报告'),
  ];
  assert.deepEqual(ids(rank(items, '', ['session:a'])), [['session', ['session:b']]]);
  assert.deepEqual(ids(rank(items, '报告', [])), [['session', ['session:a', 'session:b']]]);
});
