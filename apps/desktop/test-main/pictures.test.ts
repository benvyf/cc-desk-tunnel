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

test('a picture says its size in its header, read without decoding it', async () => {
  const { headerSize } = await import('../src/pictures.ts');
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0, 0, 5, 0, 0, 0, 2, 208], 16);
  assert.deepEqual(headerSize(png), { width: 1280, height: 720 });
  const gif = new Uint8Array(10);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xc8, 0x00]);
  assert.deepEqual(headerSize(gif), { width: 320, height: 200 });
  // A JPEG names its size in its frame header, after other segments.
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x04,
    0xb0, 0x03, 0x01, 0x22, 0x00,
  ]);
  assert.deepEqual(headerSize(jpeg), { width: 1200, height: 800 });
  const webp = (kind: string, body: number[]) => {
    const bytes = new Uint8Array(30);
    bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)));
    bytes.set(
      [...'WEBP'].map((c) => c.charCodeAt(0)),
      8,
    );
    bytes.set(
      [...kind].map((c) => c.charCodeAt(0)),
      12,
    );
    bytes.set(body, 20);
    return bytes;
  };
  // VP8X stores width - 1 and height - 1 in 24 bits.
  assert.deepEqual(headerSize(webp('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0, 0xdf, 0x01, 0])), {
    width: 640,
    height: 480,
  });
  assert.deepEqual(headerSize(webp('VP8 ', [0, 0, 0, 0, 0, 0, 0x80, 0x02, 0xe0, 0x01])), {
    width: 640,
    height: 480,
  });
  assert.equal(headerSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), null);
});

test('a step that only looked at pictures is named by them; other calls keep their words and count theirs', async () => {
  const { summarize } = await import('../src/activity.ts');
  const { resultPictures } = await import('../src/pictures.ts');
  const shot = (count: number) =>
    resultPictures({
      output: JSON.stringify([
        { type: 'text', text: 'x' },
        ...Array.from({ length: count }, () => ({
          type: 'image',
          source: { type: 'base64', data: 'AAAA', media_type: 'image/png' },
        })),
      ]),
    });
  const tool = (name: string, pictures?: ReturnType<typeof shot>) => ({
    kind: 'tool',
    id: name + Math.random(),
    runId: 'r',
    name,
    input: '{}',
    target: 'Linux',
    resolved: true,
    status: '已完成',
    state: 'completed',
    at: '2026-11-17T00:00:00.000Z',
    endedAt: '2026-11-17T00:00:01.000Z',
    ...(pictures ? { pictures } : {}),
  });
  const work = (...items: object[]) => ({ kind: 'work', id: 'w', items }) as never;
  assert.equal(
    summarize(work(tool('Read', shot(2)), tool('Read', shot(1))), false, false).label,
    '查看了 3 张图片',
  );
  assert.equal(
    summarize(work(tool('mcp__browser__take_screenshot', shot(2))), false, false).label,
    '截了 2 张图',
  );
  assert.equal(
    summarize(work(tool('Bash', shot(2)), tool('Bash'), tool('Read', shot(1))), false, false).label,
    '运行了 2 条命令，查看了 1 张图片 · 2 张图片',
  );
  // A step without pictures is named as before.
  assert.equal(summarize(work(tool('Read'), tool('Read')), false, false).label, '读取了 2 个文件');
});
