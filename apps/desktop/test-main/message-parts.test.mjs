import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinMessage, messageParts } from '../src/messageParts.ts';
import { quoteMessage } from '../src/quotes.ts';
import { attachmentMessage, pastedBlock, withPastedText } from '../src/attachments.ts';

test('a sent question comes apart for editing and goes back together as it was', () => {
  const quote = {
    id: 'q1',
    sessionId: 's1',
    messageId: 'm1',
    text: '引用的回答',
  };
  const block = pastedBlock('很长的一段粘贴\n'.repeat(40));
  const file = { id: 'f1', name: 'a.png', path: 'C:\\pics\\a.png', status: 'ready' };
  for (const sent of [
    '只有文字\n第二行 👋',
    attachmentMessage(quoteMessage(withPastedText('看看这个', [block]), [quote]), [file]),
    attachmentMessage('', [file]),
  ]) {
    const parts = messageParts(sent);
    assert.equal(joinMessage(parts), sent);
  }
  const parts = messageParts(
    attachmentMessage(quoteMessage(withPastedText('正文', [block]), [quote]), [file]),
  );
  assert.equal(parts.body, '正文');
  assert.equal(parts.blocks.length, 1);
  assert.equal(parts.quotes.length, 1);
  assert.deepEqual(
    parts.files.map((item) => item.path),
    ['C:\\pics\\a.png'],
  );
  // What is removed while editing is not sent.
  assert.equal(joinMessage({ ...parts, blocks: [], quotes: [], files: [] }), '正文');
});
