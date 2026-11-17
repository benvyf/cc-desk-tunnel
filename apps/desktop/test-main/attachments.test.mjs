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
  const { isPastedBlock, pastedBlock, pastedSummary } = await import('../src/attachments.ts');
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
  assert.equal(pastedSummary(log), '4 行 · ' + log.length + ' 字');
  const file = { id: 'f', name: 'a.png', path: 'C:\\图\\a.png', status: 'ready' };
  const sent = attachmentMessage('这是什么错误？', [block, file]);
  assert.equal(sent, `这是什么错误？\n\n${log}\n"C:\\图\\a.png"`);
  assert.equal(attachmentMessage('', [block]), log);
  const restored = splitAttachmentMessage(sent);
  assert.deepEqual(
    restored.files.map((item) => item.path),
    ['C:\\图\\a.png'],
  );
  assert.equal(restored.text, `这是什么错误？\n\n${log}`);
});
