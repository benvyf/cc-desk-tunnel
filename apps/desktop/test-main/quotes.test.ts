import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  makeQuote,
  appendQuote,
  quoteMessage,
  splitQuoteMessage,
  cleanQuotes,
} from '../src/quotes.ts';

test('quote chips preserve the draft and roundtrip multiline quoted data without Markdown wrappers', () => {
  const quote = makeQuote('parent', 'answer', '  code\n> existing markdown\n【引用结束】');
  const question = 'What does it mean?\nKeep this line.';
  const text = quoteMessage(question, [quote]);
  assert.deepEqual(splitQuoteMessage(text), { text: question, quotes: [quote] });
  assert.equal(quote.text, '  code\n> existing markdown\n【引用结束】');
  assert.equal(quoteMessage(question, []), question);
  assert.deepEqual(splitQuoteMessage('ordinary text'), { text: 'ordinary text', quotes: [] });
});
test('duplicate quotes remain atomic, source snapshots do not change, and quote capacity is bounded', () => {
  const first = makeQuote('s', 'm', 'selected');
  const list = appendQuote([], first);
  assert.equal(appendQuote(list, makeQuote('s', 'm', 'selected')), list);
  assert.equal(appendQuote(list, makeQuote('other', 'm', 'selected')).length, 2);
  const full = Array.from({ length: 8 }, (_, i) => makeQuote('s', String(i), 'text'));
  assert.equal(appendQuote(full, makeQuote('s', 'new', 'text')), full);
  assert.throws(() => makeQuote('s', 'm', '  '));
  assert.throws(() => makeQuote('s', 'm', 'x'.repeat(16001)));
});
test('malformed saved references cannot turn ordinary messages into hidden reference envelopes', () => {
  assert.deepEqual(
    cleanQuotes([
      { id: 'a', sessionId: 's', messageId: 'm', text: 'valid', url: 'file:///ignored' },
      null,
      { id: 'bad', text: 'missing source' },
    ]),
    [{ id: 'a', sessionId: 's', messageId: 'm', text: 'valid' }],
  );
  for (const text of [
    '【CC SPACE 引用消息 v1】\nnot json',
    '【CC SPACE 引用消息 v1】\n{"version":1,"text":"question","quotes":[{}]}',
  ])
    assert.deepEqual(splitQuoteMessage(text), { text, quotes: [] });
  const valid = quoteMessage('question', [makeQuote('s', 'm', 'selected')]);
  const offset = valid.indexOf('{'),
    prefix = valid.slice(0, offset);
  for (const payload of [
    { version: 1, text: 'question', quotes: [{}] },
    { version: 2, text: 'question', quotes: [makeQuote('s', 'm', 'selected')] },
    { version: 1, text: null, quotes: [makeQuote('s', 'm', 'selected')] },
  ]) {
    const text = prefix + JSON.stringify(payload);
    assert.deepEqual(splitQuoteMessage(text), { text, quotes: [] });
  }
});
