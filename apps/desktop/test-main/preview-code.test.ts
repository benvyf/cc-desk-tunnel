import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codeLineStarts,
  codePosition,
  editTargets,
  foundLine,
  requestedLine,
} from '../src/previewCode.ts';
import { diffLines } from '../src/lineDiff.ts';

// An edit's place in its file, as a tool card's path finds it (ToolInput.tsx).
const editLine = (file: string, before: string, after: string, longest?: number) =>
  foundLine(file, editTargets(before, after, diffLines(before, after), longest));

test('an edit is found at its first changed line, past the lines it shares with the old text', () => {
  // The first line is in the file twice; the whole new text is not.
  const file = 'top\nfunction x() {\n  return 1;\n}\nfunction x() {\n  return 2;\n}';
  assert.equal(editLine(file, 'function x() {\n  return 9;', 'function x() {\n  return 2;'), 6);
  // Its lines may end in \r\n in the file, or in a lone \r, which is a line of its own too.
  assert.equal(editLine(file.replaceAll('\n', '\r\n'), 'x', 'function x() {\n  return 2;'), 5);
  assert.equal(foundLine('a\rb\r\nc\nd', [{ text: 'c\nd', offset: 0 }]), 3);
  // New text starting with empty lines leads to the first of them.
  assert.equal(editLine('x\n\n\nconst value = 1;', '', '\n\nconst value = 1;'), 2);
  // A deletion leads to where the lines were.
  assert.equal(
    editLine(
      'header\nkeep line one\nkeep line three',
      'keep line one\nremove me please\nkeep line three',
      'keep line one\nkeep line three',
    ),
    3,
  );
  // An edit not made yet is found by its old text.
  assert.equal(editLine('a\nold value here\n', 'old value here', 'new value here'), 2);
  // A long text is looked for by its start.
  const long = 'unique start of a long text\n' + 'filler line\n'.repeat(400);
  const targets = editTargets('', long, diffLines('', long), 50);
  assert.ok(targets.every((target) => target.text.length <= 50));
  assert.equal(foundLine('first\n' + long.slice(0, 100), targets), 2);
  // Nothing found: no line, so the view stays where it is.
  assert.equal(editLine('nothing alike', 'something else entirely', 'and another text'), undefined);
});

test('source line offsets retain blank lines, CRLF and the final newline', () => {
  assert.deepEqual(Array.from(codeLineStarts('a\r\n\n😀\n')), [0, 3, 4, 7]);
  assert.deepEqual(Array.from(codeLineStarts('')), [0]);
  assert.equal(codePosition('a\r\n\n😀\n', 3, 1).offset, 4);
  assert.equal(codePosition('a\r\n\n😀\n', 999, 40).offset, 7);
  assert.equal(codePosition('alpha\nbeta', 2, 999).offset, 10);
  assert.deepEqual(Array.from(codeLineStarts('a\rb\r\nc\n')), [0, 2, 5, 7]);
});

test('navigation accepts only positive finite integer lines without interpreting expressions', () => {
  for (const value of ['12', ' 12 ', 12]) assert.equal(requestedLine(value), 12);
  for (const value of ['', '0', '-1', '2.5', '1e3', 'Infinity', '12x', NaN, Infinity, 2.5])
    assert.equal(requestedLine(value), undefined);
});
