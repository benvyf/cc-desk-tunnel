import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pictureUrl, picturesOf, resultPictures, toolPictures } from '../src/pictures.ts';

const output = (data: string) =>
  JSON.stringify([
    { type: 'text', text: 'Read image' },
    { type: 'image', source: { type: 'base64', data, media_type: 'image/png' } },
  ]);

test('a result is read once: the same pictures, and the same address, at every drawing', () => {
  const result = { output: output('AAAA') };
  const first = resultPictures(result);
  assert.equal(first?.text, 'Read image');
  assert.equal(first?.pictures.length, 1);
  assert.equal(resultPictures(result), first);
  // Another result with the same words is its own.
  assert.notEqual(resultPictures({ output: output('AAAA') }), first);
  const picture = first!.pictures[0];
  assert.equal(pictureUrl(picture), 'data:image/png;base64,AAAA');
  assert.equal(pictureUrl(picture), pictureUrl(picture));
  // Output without pictures, or not JSON, has none.
  assert.equal(resultPictures({ output: 'plain text' }), null);
  assert.equal(toolPictures('[not json'), null);
});

test('the pictures of a step are those its tools were given, in order, and nothing else is read', () => {
  const a = resultPictures({ output: output('AAAA') })!;
  const b = resultPictures({ output: output('BBBB') })!;
  const items = [
    { kind: 'tool', pictures: a },
    { kind: 'text' },
    { kind: 'tool' },
    { kind: 'tool', pictures: null },
    { kind: 'tool', pictures: b },
  ];
  assert.deepEqual(picturesOf(items), [a.pictures[0], b.pictures[0]]);
  assert.equal(picturesOf(items)[0], a.pictures[0]);
});
