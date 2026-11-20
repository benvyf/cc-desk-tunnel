import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { decodeText, textLimit } = require('../electron/text-decode.cjs');
const { createPreviewFiles } = require('../electron/preview-files.cjs');

// "中文测试" in GBK.
const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);

test('byte order marks select UTF-8 or UTF-16 and are not part of the text', () => {
  const sample = 'Write-Output 中文\r\n';
  assert.deepEqual(
    decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sample, 'utf16le')])),
    { text: sample, encoding: 'utf-16le' },
  );
  const big = Buffer.from(sample, 'utf16le').swap16();
  assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), big])), {
    text: sample,
    encoding: 'utf-16be',
  });
  assert.deepEqual(
    decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample)])),
    {
      text: sample,
      encoding: 'utf-8',
    },
  );
  assert.deepEqual(decodeText(Buffer.alloc(0)), { text: '', encoding: 'utf-8' });
});

test('UTF-16LE without a byte order mark is recognised only when it clearly looks like it', () => {
  const text = 'Name    Value\r\n----    -----\r\nPath    C:\\工作\r\n';
  assert.deepEqual(decodeText(Buffer.from(text, 'utf16le')), { text, encoding: 'utf-16le' });
  // A few zero bytes in an otherwise binary file are not UTF-16.
  assert.throws(() => decodeText(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0])), /不支持/);
});

test('text that is not UTF-8 falls back to GB18030, and binaries are still refused', () => {
  assert.deepEqual(decodeText(gbk), { text: '中文测试', encoding: 'gb18030' });
  assert.deepEqual(decodeText(Buffer.concat([Buffer.from('标题 '), Buffer.from('ok\n')])), {
    text: '标题 ok\n',
    encoding: 'utf-8',
  });
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00, 0x5c, 0x72, 0xa8,
  ]);
  assert.throws(() => decodeText(png), /不支持/);
  // Bytes GB18030 cannot decode keep the original answer.
  assert.throws(() => decodeText(Buffer.from([0x80, 0xff, 0x80, 0xff])), /不是 UTF-8/);
  // Bytes GB18030 accepts but that decode to control characters are not text either.
  assert.throws(
    () => decodeText(Buffer.concat([gbk, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4])])),
    /不是 UTF-8/,
  );
});

test('a cut file ends on a line, or at least a character, boundary', () => {
  const line = '第 0000 行：CC Space 预览大文件。\n';
  const whole = Buffer.from(line.repeat(Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(line))));
  assert(whole.length > 5 * 1024 * 1024);
  const { text, encoding } = decodeText(whole.subarray(0, textLimit), { cut: true });
  assert.equal(encoding, 'utf-8');
  assert(text.endsWith('\n'));
  assert(Buffer.byteLength(text) <= textLimit);
  assert(whole.toString().startsWith(text));

  // No line break: the character that straddles the cut is left out rather than mangled.
  const single = Buffer.from('a'.repeat(textLimit - 1) + '中');
  assert.equal(
    decodeText(single.subarray(0, textLimit), { cut: true }).text,
    'a'.repeat(textLimit - 1),
  );

  const gbkLong = Buffer.concat([gbk, Buffer.alloc(textLimit - gbk.length - 1, 0x61), gbk]);
  const cutGbk = decodeText(gbkLong.subarray(0, textLimit), { cut: true });
  assert.equal(cutGbk.encoding, 'gb18030');
  assert.equal(cutGbk.text, '中文测试' + 'a'.repeat(textLimit - gbk.length - 1));

  // UTF-16 keeps an even byte count and never ends between the halves of a surrogate pair.
  const wide = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('b'.repeat(textLimit / 2 - 2) + '😀', 'utf16le'),
  ]);
  const cutWide = decodeText(wide.subarray(0, textLimit - 1), { cut: true });
  assert.equal(cutWide.encoding, 'utf-16le');
  assert.equal(cutWide.text, 'b'.repeat(textLimit / 2 - 2));
  // Without the cut flag a broken end is an error, not silently dropped.
  assert.throws(() => decodeText(single.subarray(0, textLimit)), /UTF-8/);
});

test('reading a large text file returns its beginning with its size; Markdown and HTML as source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-preview-decode-'));
  const files = createPreviewFiles();
  t.after(async () => {
    await files.close();
    await rm(root, { recursive: true, force: true });
  });
  const body = Buffer.from('# 标题\n\n' + '内容 content\n'.repeat(400_000));
  assert(body.length > textLimit);
  for (const name of ['large.txt', 'large.md', 'large.html']) {
    await writeFile(join(root, name), body);
    const result = await files.read({ path: join(root, name), root });
    assert.equal(result.kind, 'text');
    assert.equal(result.truncated, true);
    assert.equal(result.size, body.length);
    assert.equal(result.url, undefined);
    assert.equal(result.encoding, undefined);
    assert(result.text.endsWith('\n'));
    assert(body.toString().startsWith(result.text));
  }
  await writeFile(join(root, 'gbk.txt'), gbk);
  assert.deepEqual(
    { ...(await files.read({ path: join(root, 'gbk.txt'), root })), path: undefined },
    { path: undefined, kind: 'text', text: '中文测试', encoding: 'gb18030' },
  );
  await writeFile(join(root, 'small.md'), '# 小');
  const markdown = await files.read({ path: join(root, 'small.md'), root });
  assert.equal(markdown.kind, 'markdown');
  assert.equal(markdown.truncated, undefined);
});
