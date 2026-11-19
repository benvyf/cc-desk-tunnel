import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockStarts } from '../src/streaming.ts';

const cuts = (source) => blockStarts(source).map((at) => source.slice(at).split('\n')[0]);

test('a streaming answer is cut only where later text cannot change what is before', () => {
  assert.deepEqual(cuts('# 标题\n\n第一段\n\n第二段\n\n第三'), ['第一段', '第二段']);
  // The line after the blank must be whole: "1" may still become "1. item".
  assert.deepEqual(cuts('a\n\nb'), []);
  assert.deepEqual(cuts('a\n\nb\n'), ['b']);
  // Not inside a fenced block, nor a $$ formula, whatever blank lines they hold.
  assert.deepEqual(cuts('a\n\n```ts\nx\n\ny\n```\n\nb\n'), ['```ts', 'b']);
  assert.deepEqual(cuts('a\n\n~~~\nx\n\ny\n~~~\n\nb\n'), ['~~~', 'b']);
  assert.deepEqual(cuts('a\n\n$$\nx\n\ny\n$$\n\nb\n'), ['$$', 'b']);
  assert.deepEqual(cuts('a\n\n$$ x $$\n\nb\n'), ['$$ x $$', 'b']);
  // An open fence holds everything after it.
  assert.deepEqual(cuts('a\n\n```\nx\n\ny\n'), ['```']);
  // One list stays one list; a continuation stays with its item; a definition may serve text above.
  assert.deepEqual(cuts('- a\n\n- b\n\nc\n'), ['c']);
  assert.deepEqual(cuts('1. a\n\n2) b\n\nc\n'), ['c']);
  assert.deepEqual(cuts('- a\n\n    code in item\n\nc\n'), ['c']);
  assert.deepEqual(cuts('> a\n\n  b\n\nc\n'), ['c']);
  assert.deepEqual(cuts('see [x][1]\n\n[1]: https://example.com\n\nc\n'), ['c']);
  // A table or heading after a blank line starts its own block.
  assert.deepEqual(cuts('a\n\n| a | b |\n| - | - |\n\n## h\n'), ['| a | b |', '## h']);
});

test('the blocks put back together are the answer', () => {
  const source = '# 题\n\n段落 $x$\n\n```js\nlet a;\n\nlet b;\n```\n\n- 一\n\n- 二\n\n结尾\n';
  const starts = [0, ...blockStarts(source), source.length];
  assert.equal(
    starts
      .slice(0, -1)
      .map((from, at) => source.slice(from, starts[at + 1]))
      .join(''),
    source,
  );
});
