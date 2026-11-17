import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentKind, attachmentMessage, splitAttachmentMessage } from '../src/attachments.ts';

test('attachment references round-trip spaces, Unicode, UNC and POSIX paths without hiding ordinary prose', () => {
  const paths = ['C:\\工作 文件\\截图.png', '\\\\host\\share\\schema.json', '/tmp/方案.pdf'];
  const items = paths.map((path, index) => ({
    id: String(index),
    name: path,
    path,
    status: 'ready',
  }));
  const sent = attachmentMessage('帮我看看', items);
  const restored = splitAttachmentMessage(sent);
  assert.equal(restored.text, '帮我看看');
  assert.deepEqual(
    restored.files.map((item) => item.path),
    paths,
  );
  assert.equal(attachmentMessage(restored.text, restored.files), sent);
  for (const text of [
    'inline "C:\\work\\pic.png"',
    '"relative.png"',
    '```\n"C:\\work\\pic.png"\n```',
    '普通消息',
  ]) {
    assert.deepEqual(splitAttachmentMessage(text), { text, files: [] });
  }
  assert.equal(attachmentKind('photo.PNG'), 'IMAGE');
  assert.equal(attachmentKind('config.json'), 'CODE');
  assert.equal(attachmentKind('LICENSE'), 'FILE');
});

test('long pasted text becomes a block that is sent tagged after the typed text and before file references', async () => {
  const {
    isPastedBlock,
    pastedBlock,
    pastedSummary,
    withPastedText,
    splitPastedText,
    plainPastedText,
  } = await import('../src/attachments.ts');
  assert.equal(isPastedBlock('short'), false);
  assert.equal(isPastedBlock('x'.repeat(1999)), false);
  assert.equal(isPastedBlock('x'.repeat(2000)), true);
  assert.equal(isPastedBlock(Array.from({ length: 19 }, () => 'a').join('\n')), false);
  assert.equal(isPastedBlock(Array.from({ length: 20 }, () => 'a').join('\n')), true);
  const log = '\n  PS C:\\> git log\nfatal: not a git repository\nline 3\n';
  const block = pastedBlock(log);
  assert.match(block.id, /:[a-z0-9]{6}$/);
  assert.equal(block.name, 'PS C:\\> git log');
  assert.equal(block.status, 'ready');
  assert.equal(block.path, undefined);
  assert.equal(pastedSummary(log), `4 行 · ${log.length} 字符`);
  assert.equal(pastedSummary('a\nb\n'), '2 行 · 4 字符');
  assert.equal(pastedSummary('x'.repeat(12345)), '1 行 · 12,345 字符');
  const tag = `pasted_text_${block.id.slice(-6)}`;
  const file = { id: 'f', name: 'a.png', path: 'C:\\图\\a.png', status: 'ready' };
  const body = withPastedText('这是什么错误？', [block, file]);
  assert.equal(body, `这是什么错误？\n\n<${tag}>\n${log}\n</${tag}>`);
  assert.equal(withPastedText('只有文字', [file]), '只有文字');
  // Blocks never become path lines, and path lines stay last so they still parse.
  assert.equal(attachmentMessage('x', [block]), 'x');
  const sent = attachmentMessage(body, [block, file]);
  const restored = splitAttachmentMessage(sent);
  assert.deepEqual(
    restored.files.map((item) => item.path),
    ['C:\\图\\a.png'],
  );
  assert.equal(restored.text, body);
  // Read back: the typed text, and the block exactly as pasted (a final line break included).
  const read = splitPastedText(restored.text);
  assert.equal(read.text, '这是什么错误？');
  assert.equal(read.blocks.length, 1);
  assert.equal(read.blocks[0].text, log);
  assert.equal(read.blocks[0].name, 'PS C:\\> git log');
  assert.equal(read.blocks[0].id.slice(-6), block.id.slice(-6));
  assert.deepEqual(splitPastedText(restored.text), read, 'the same ids on every read');
  assert.equal(plainPastedText(restored.text), `这是什么错误？\n\n${log}`);
});

test('several blocks read back in order; tags inside pasted text and look-alikes in typed text stay text', async () => {
  const { pastedBlock, withPastedText, splitPastedText } = await import('../src/attachments.ts');
  const tricky = pastedBlock(
    'a\n</pasted_text_zzzzzz>\n<pasted_text_yyyyyy>\nb\n'.repeat(5),
    'abc123',
  );
  const second = pastedBlock('第二段\n'.repeat(25), 'def456');
  const only = splitPastedText(withPastedText('', [tricky, second]));
  assert.equal(only.text, '');
  assert.deepEqual(
    only.blocks.map((item) => item.text),
    [tricky.text, second.text],
  );
  // Blocks are only read at the end of a question; one written in the middle is the user's own text.
  const middle = `前面\n\n<pasted_text_abc123>\nx\n</pasted_text_abc123>\n\n后面`;
  assert.deepEqual(splitPastedText(middle), { text: middle, blocks: [] });
  // Mismatched tags are not a block.
  const mismatched = '<pasted_text_abc123>\nx\n</pasted_text_def456>';
  assert.deepEqual(splitPastedText(mismatched), { text: mismatched, blocks: [] });
  assert.deepEqual(splitPastedText('普通问题'), { text: '普通问题', blocks: [] });
});

test('a pasted block is part of the quoted question, so the quote payload still parses', async () => {
  const { pastedBlock, withPastedText, splitPastedText } = await import('../src/attachments.ts');
  const { makeQuote, quoteMessage, splitQuoteMessage } = await import('../src/quotes.ts');
  const quote = makeQuote(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '引用的回答',
  );
  const block = pastedBlock('a\n'.repeat(30));
  const file = { id: 'f', name: 'a.png', path: 'C:\\图\\a.png', status: 'ready' };
  const sent = attachmentMessage(quoteMessage(withPastedText('为什么？', [block, file]), [quote]), [
    block,
    file,
  ]);
  const attached = splitAttachmentMessage(sent);
  assert.deepEqual(
    attached.files.map((item) => item.path),
    ['C:\\图\\a.png'],
  );
  const quoted = splitQuoteMessage(attached.text);
  assert.equal(quoted.quotes.length, 1);
  const read = splitPastedText(quoted.text);
  assert.equal(read.text, '为什么？');
  assert.deepEqual(
    read.blocks.map((item) => item.text),
    [block.text],
  );
});
