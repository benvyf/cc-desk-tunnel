import test from 'node:test';
import assert from 'node:assert/strict';
import { addedRows, diffRows } from '../src/gitChanges.ts';

const shown = (text: string) =>
  diffRows(text).rows.map((row) => `${row.kind}${row.old ?? '.'}:${row.new ?? '.'} ${row.text}`);

test('a diff’s rows carry each side’s line numbers, and its hunks are found', () => {
  const text = [
    'diff --git a/a.ts b/a.ts',
    'index 1..2 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -3,4 +3,5 @@ function a() {',
    ' keep',
    '-old',
    '+new',
    '+more',
    ' keep',
    ' end',
    '@@ -20 +21 @@',
    '-x',
    '+y',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  assert.deepEqual(shown(text), [
    '@.:. @@ -3,4 +3,5 @@ function a() {',
    ' 3:3 keep',
    '-4:. old',
    '+.:4 new',
    '+.:5 more',
    ' 5:6 keep',
    ' 6:7 end',
    '@.:. @@ -20 +21 @@',
    '-20:. x',
    '+.:21 y',
    '\\.:. No newline at end of file',
  ]);
  assert.deepEqual(diffRows(text).hunks, [0, 7]);
});

test('a side without lines, carriage returns and a diff cut short are taken as they come', () => {
  assert.deepEqual(shown('@@ -0,0 +1,2 @@\n+a\r\n+b\r\n'), [
    '@.:. @@ -0,0 +1,2 @@',
    '+.:1 a',
    '+.:2 b',
  ]);
  assert.deepEqual(shown('@@ -1,2 +0,0 @@\n-a\n-b\n'), [
    '@.:. @@ -1,2 +0,0 @@',
    '-1:. a',
    '-2:. b',
  ]);
  // Cut in its middle: what there is of it.
  assert.deepEqual(shown('@@ -1,9 +1,9 @@\n same\n-gone'), [
    '@.:. @@ -1,9 +1,9 @@',
    ' 1:1 same',
    '-2:. gone',
  ]);
  // Headers after a hunk's last line (a second file's) are not rows.
  assert.deepEqual(shown('@@ -1 +1 @@\n-a\n+b\ndiff --git a/c b/c\n--- a/c\n+++ b/c\n'), [
    '@.:. @@ -1 +1 @@',
    '-1:. a',
    '+.:1 b',
  ]);
  assert.deepEqual(diffRows('Binary files a/x and b/x differ\n'), { rows: [], hunks: [] });
});

test('an untracked file is one hunk of added lines', () => {
  assert.deepEqual(addedRows('a\nb\n'), {
    rows: [
      { kind: '@', text: '@@ -0,0 +1,2 @@' },
      { kind: '+', text: 'a', new: 1 },
      { kind: '+', text: 'b', new: 2 },
    ],
    hunks: [0],
  });
  assert.deepEqual(addedRows(''), { rows: [], hunks: [] });
});

test('a change of line endings alone is told as such', () => {
  assert.equal(diffRows('@@ -1,2 +1,2 @@\n-a\n-b\n+a\r\n+b\r\n').endings, true);
  assert.equal(diffRows('@@ -1 +1 @@\n-a\n+b\r\n').endings, undefined);
  assert.equal(diffRows('@@ -1 +1 @@\n-a\n+a\n').endings, undefined);
});
