import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { inputHistory } from '../src/inputHistory.ts';
import { attachmentMessage } from '../src/attachments.ts';
import { quoteMessage } from '../src/quotes.ts';

const user = (text: string) => ({
  payload: {
    type: 'message.user',
    text,
    messageId: crypto.randomUUID(),
    scenario: 'chat',
  } as EventPayload,
});

test('history uses only current user messages and preserves original whitespace', () => {
  const events = [
    user('  中文指令\n保留格式  '),
    {
      payload: {
        type: 'text.delta',
        messageId: 'assistant',
        text: 'not a command',
      } as EventPayload,
    },
    user('second'),
  ];
  assert.deepEqual(inputHistory(events), ['  中文指令\n保留格式  ', 'second']);
  assert.deepEqual(inputHistory([]), []);
});

test('continuation markers cannot expose an internal prompt as a user command', () => {
  const continued = user('internal continuation instruction');
  if (continued.payload.type === 'message.user') continued.payload.continued = true;
  assert.deepEqual(inputHistory([user('actual command'), continued]), ['actual command']);
});

test('blank, too-long and consecutive duplicate prompts do not clutter history', () => {
  assert.deepEqual(
    inputHistory([
      user('one'),
      user('one'),
      user(' \n '),
      user('x'.repeat(16001)),
      user('two'),
      user('one'),
    ]),
    ['one', 'two', 'one'],
  );
});

test('recall strips attachment and quote envelopes without restoring their hidden data', () => {
  const text = attachmentMessage(
    quoteMessage('actual question', [
      { id: 'q', sessionId: 's', messageId: 'm', text: 'quoted answer' },
    ]),
    [{ id: 'a', name: 'file.txt', path: '/file.txt', status: 'ready' }],
  );
  assert.deepEqual(inputHistory([user(text)]), ['actual question']);
  assert.deepEqual(
    inputHistory([
      user(
        attachmentMessage('', [{ id: 'a', name: 'file.txt', path: '/file.txt', status: 'ready' }]),
      ),
    ]),
    [],
  );
});

test('queued messages are available after sent messages, with adjacent duplicates removed', () => {
  assert.deepEqual(inputHistory([user('sent')], [{ text: 'sent' }, { text: 'queued' }]), [
    'sent',
    'queued',
  ]);
});

test('an acknowledged queue item is recalled once even before its delivery response arrives', () => {
  const recorded = user('B');
  if (recorded.payload.type === 'message.user') recorded.payload.messageId = 'queued-b';
  assert.deepEqual(
    inputHistory(
      [recorded],
      [
        { id: 'queued-a', text: 'A' },
        { id: 'queued-b', text: 'B' },
      ],
    ),
    ['B', 'A'],
  );
});

test('only the latest 200 useful entries are offered to keyboard navigation', () => {
  const events = Array.from({ length: 250 }, (_, index) => user(String(index)));
  const result = inputHistory(events);
  assert.equal(result.length, 200);
  assert.equal(result[0], '50');
  assert.equal(result.at(-1), '249');
});
