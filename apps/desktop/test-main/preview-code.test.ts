import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeLineStarts, codePosition, requestedLine } from '../src/previewCode.ts';

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
