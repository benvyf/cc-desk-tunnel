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
