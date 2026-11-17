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

test('long pasted text becomes a block that is sent after the typed text and before file references', async () => {
  const { isPastedBlock, pastedBlock, pastedSummary, withPastedText } =
    await import('../src/attachments.ts');
  assert.equal(isPastedBlock('short'), false);
  assert.equal(isPastedBlock('x'.repeat(1999)), false);
  assert.equal(isPastedBlock('x'.repeat(2000)), true);
  assert.equal(isPastedBlock(Array.from({ length: 19 }, () => 'a').join('\n')), false);
  assert.equal(isPastedBlock(Array.from({ length: 20 }, () => 'a').join('\n')), true);
  const log = '\n  PS C:\\> git log\nfatal: not a git repository\nline 3';
  const block = pastedBlock(log);
  assert.equal(block.name, 'PS C:\\> git log');
  assert.equal(block.status, 'ready');
  assert.equal(block.path, undefined);
  assert.equal(pastedSummary(log), `4 行 · ${log.length} 字符`);
  // A final line break starts no line of its own.
  assert.equal(pastedSummary('a\nb\n'), '2 行 · 4 字符');
  assert.equal(pastedSummary('x'.repeat(12345)), '1 行 · 12,345 字符');
  const file = { id: 'f', name: 'a.png', path: 'C:\\图\\a.png', status: 'ready' };
  const body = withPastedText('这是什么错误？', [block, file]);
  assert.equal(body, `这是什么错误？\n\n${log}`);
  assert.equal(withPastedText('', [block]), log);
  assert.equal(withPastedText('只有文字', [file]), '只有文字');
  // Blocks never become path lines, and path lines stay last so they still parse.
  assert.equal(attachmentMessage('x', [block]), 'x');
  const sent = attachmentMessage(body, [block, file]);
  assert.equal(sent, `这是什么错误？\n\n${log}\n"C:\\图\\a.png"`);
  const restored = splitAttachmentMessage(sent);
  assert.deepEqual(
    restored.files.map((item) => item.path),
    ['C:\\图\\a.png'],
  );
  assert.equal(restored.text, body);
});

test('a pasted block is part of the quoted question, so the quote payload still parses', async () => {
  const { pastedBlock, withPastedText } = await import('../src/attachments.ts');
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
  assert.equal(quoted.text, `为什么？\n\n${block.text}`);
  // With only a block and no typed text, the quote still has a question.
  assert.equal(
    splitQuoteMessage(quoteMessage(withPastedText('', [block]), [quote])).text,
    block.text,
  );
});
