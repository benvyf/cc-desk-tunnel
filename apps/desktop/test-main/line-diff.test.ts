import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, lineChanges } from '../src/lineDiff.ts';

const shown = (before: string, after: string) =>
  diffLines(before, after).map((line) => `${line.kind}${line.text}`);

test('a change to a file keeps shared lines and marks what went out and came in', () => {
  assert.deepEqual(shown('a\nb\nc', 'a\nB\nc'), [' a', '-b', '+B', ' c']);
  assert.deepEqual(shown('', 'x\ny'), ['+x', '+y']);
  assert.deepEqual(shown('x\ny', ''), ['-x', '-y']);
  assert.deepEqual(shown('class A {\n  user = null;\n}', 'function a() {\n  return 1;\n}'), [
    '-class A {',
    '-  user = null;',
    '+function a() {',
    '+  return 1;',
    ' }',
  ]);
  assert.deepEqual(lineChanges('a', 'a\nb\nc'), { added: 2, removed: 0 });
  assert.deepEqual(lineChanges('a\nb', 'a\nb'), { added: 0, removed: 0 });
});

test('a change too large to compare line by line is shown whole, out then in', () => {
  const before = Array.from({ length: 600 }, (_, index) => `old ${index}`).join('\n');
  const after = Array.from({ length: 600 }, (_, index) => `new ${index}`).join('\n');
  const lines = diffLines(`head\n${before}\ntail`, `head\n${after}\ntail`);
  assert.equal(lines.length, 1202);
  assert.deepEqual(lines[0], { kind: ' ', text: 'head' });
  assert.equal(lines[1].kind, '-');
  assert.equal(lines[601].kind, '+');
  assert.deepEqual(lines.at(-1), { kind: ' ', text: 'tail' });
});
