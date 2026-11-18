import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { markdown } from '../src/exportSession.ts';
import { attachmentMessage, pastedBlock, withPastedText } from '../src/attachments.ts';
import { makeQuote, quoteMessage } from '../src/quotes.ts';

const session = { id: 's', title: '导出', projectPath: 'C:\\项目' } as Session;
const asked = (text: string, sequence: number): SessionEvent =>
  ({
    sessionId: 's',
    runId: `run-${sequence}`,
    sequence,
    createdAt: '2026-11-17T00:00:00.000Z',
    payload: { type: 'message.user', messageId: `m-${sequence}`, text, scenario: 'chat' },
  }) as SessionEvent;

test('an exported question fences its pasted text, keeps file lines and shows quotes as copying does', () => {
  const log = '# not a heading\n- not a list\n```\ncode\n```\n'.repeat(6);
  const block = pastedBlock(log);
  const file = { id: 'f', name: 'a.png', path: 'C:\\图\\a.png', status: 'ready' as const };
  const quote = makeQuote(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '引用的回答',
  );
  const plain = '普通的问题\n- 列表照旧';
  const pasted = attachmentMessage(withPastedText('这是什么？', [block, file]), [block, file]);
  const quoted = quoteMessage(withPastedText('为什么？', [block]), [quote]);
  const text = markdown(session, [asked(plain, 1), asked(pasted, 2), asked(quoted, 3)]);
  // A plain question is written as it was.
  assert.ok(text.includes(`\n\n${plain}\n\n`));
  // No tag and no quote payload reaches the document.
  assert.ok(!text.includes('pasted_text_'));
  assert.ok(!text.includes('CC SPACE 引用消息'));
  // The pasted text is labelled and fenced longer than the backticks inside it.
  assert.ok(
    text.includes(
      `这是什么？\n\n粘贴的文本（30 行 · ${log.length} 字符）：\n\n\`\`\`\`\n${log}\n\`\`\`\`\n"C:\\图\\a.png"`,
    ),
  );
  assert.ok(text.includes('引用：\n引用的回答\n\n为什么？\n\n粘贴的文本'));
});

test('an export lists a subagent’s calls after its own, as before they were placed, and leaves its words out', () => {
  const at = (sequence: number, payload: SessionEvent['payload']): SessionEvent =>
    ({
      sessionId: 's',
      runId: 'run',
      sequence,
      createdAt: '2026-11-17T00:00:00.000Z',
      payload,
    }) as SessionEvent;
  const tool = (sequence: number, toolId: string, parentToolId?: string) =>
    at(sequence, {
      type: 'tool.requested',
      toolId,
      name: toolId,
      input: '{}',
      target: 'Linux',
      ...(parentToolId ? { parentToolId } : {}),
    });
  const head = [at(1, { type: 'message.user', messageId: 'q', text: '问', scenario: 'chat' })];
  const tail = [
    at(9, { type: 'text.delta', messageId: 'a', text: '答' }),
    at(10, { type: 'run.status', status: 'completed', connectionId: 'c' }),
  ];
  const placed = markdown(session, [
    ...head,
    tool(2, 'Agent'),
    at(3, { type: 'text.delta', messageId: 'sub', text: '子代理的话', parentToolId: 'Agent' }),
    tool(4, 'Read', 'Agent'),
    tool(5, 'Grep', 'Agent'),
    ...tail,
  ]);
  const flat = markdown(session, [
    ...head,
    tool(2, 'Agent'),
    tool(4, 'Read'),
    tool(5, 'Grep'),
    ...tail,
  ]);
  const body = (text: string) => text.split('\n').slice(2).join('\n');
  assert.equal(body(placed), body(flat));
  assert.ok(!placed.includes('子代理的话'));
});
