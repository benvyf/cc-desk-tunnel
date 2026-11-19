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
  // A definition reaches across blocks: the answer is not cut at all.
  assert.deepEqual(cuts('see [x][1]\n\nmiddle\n\n[1]: https://example.com\n\nc\n'), []);
  assert.deepEqual(cuts('a[^1]\n\nb\n\n[^1]: note\n\nc\n'), []);
  // Nothing after the start of an HTML block that blank lines do not end.
  assert.deepEqual(cuts('a\n\n<!-- note\n\nhidden\n\n-->\n\nb\n'), ['<!-- note']);
  assert.deepEqual(cuts('a\n\n<pre>\n\nfoo\n\n</pre>\n\nb\n'), ['<pre>']);
  // In code, HTML and definitions are only text: the cutting goes on.
  assert.deepEqual(
    cuts(
      'a\n\n```vue\n<script setup>\n\nx\n</script>\n```\n\n```html\n<!DOCTYPE html>\n```\n\n```md\n[1]: x\n```\n\nb\n',
    ),
    ['```vue', '```html', '```md', 'b'],
  );
  assert.deepEqual(cuts('a\n\n<div>\n\nb\n'), ['<div>', 'b']);
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

test('a fence closes only as CommonMark closes it, and code spans hold no math', () => {
  // An indented fence line, or one with an info string, does not close; a longer fence holds a shorter one.
  assert.deepEqual(cuts('a\n\n```sh\ncat <<EOF\n    ```\n\nstill code\nEOF\n```\n\nb\n'), [
    '```sh',
    'b',
  ]);
  assert.deepEqual(cuts('a\n\n````md\n```js\n\nconst a = 1;\n```\n\nmore code\n````\n\nb\n'), [
    '````md',
    'b',
  ]);
  assert.deepEqual(cuts('a\n\n```\nx\n\n~~~\n\ny\n```\n\nb\n'), ['```', 'b']);
  // ```x``` at the start of a line is code in a line, not a fence.
  assert.deepEqual(cuts('```x``` here\n\nb\n\nc\n'), ['b', 'c']);
  // $$ in a code span is not a formula.
  assert.deepEqual(cuts('run `echo $$` now\n\np2\n\n$$\na = 1\n\nb = 1\n$$\n\np3\n'), [
    'p2',
    '$$',
    'p3',
  ]);
});

// The property the cuts must keep: each falls between top-level blocks of the whole document, as the Markdown
// parser the answers are drawn with sees them, for every length the answer passes through while it streams.
test('every cut falls between top-level blocks of the whole answer, at every length', async () => {
  const { fromMarkdown } = await import('mdast-util-from-markdown');
  const { gfm } = await import('micromark-extension-gfm');
  const { gfmFromMarkdown } = await import('mdast-util-gfm');
  const { math } = await import('micromark-extension-math');
  const { mathFromMarkdown } = await import('mdast-util-math');
  const parse = (text) =>
    fromMarkdown(text, {
      extensions: [gfm(), math()],
      mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
    });
  const answers = [
    '# 标题\n\n段落一，带 $x$ 与 **强调**。\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- 一\n- 二\n\n  续行\n\n- 三\n\n1. 甲\n\n2. 乙\n\n> 引用\n\n  续\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$$\n\\int_0^1 x\\,dx\n\n= \\frac12\n$$\n\n结尾。\n',
    'a\n\n```sh\ncat <<EOF\n    ```\n\nstill\nEOF\n```\n\nb\n\n````md\n```js\n\nx\n```\n````\n\nc\n',
    'Title\n=====\n\ntext\n\n    indented code\n\n    more\n\nafter\n\n* * *\n\n~~~\n\n~~~\n\nend\n',
    'run `echo $$` now\n\np2\n\n$$\na = 1\n\nb = 1\n$$\n\n```x``` inline\n\np3\n\n\tTabbed\n\nlast\n',
    '第一段\r\n\r\n第二段\r\n\r\n```\r\ncode\r\n\r\nmore\r\n```\r\n\r\n第三段\r\n',
    'a\n\n<pre>\n\nfoo\n\n</pre>\n\nb\n',
    'a\n\n<script>\nx\n\ny\n</script>\n\nb\n',
    'a\n\n<!DOCTYPE html>\n\nb\n',
  ];
  for (const answer of answers)
    for (let length = 1; length <= answer.length; length++) {
      const text = answer.slice(0, length);
      const tree = parse(text);
      const bounds = new Set(tree.children.map((node) => node.position.start.offset));
      for (const at of blockStarts(text))
        assert.ok(
          bounds.has(at),
          `cut at ${at} is inside a block of ${JSON.stringify(text)}: ${JSON.stringify(text.slice(at, at + 20))}`,
        );
    }
});
