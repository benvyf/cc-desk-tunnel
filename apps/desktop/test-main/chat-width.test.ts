import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChatWidth, readChatWidth, saveChatWidth, chatWidthKey } from '../src/chatWidth.ts';

test('preferred width fits a changing column without overwriting the larger preference', () => {
  assert.equal(resolveChatWidth(1600, null), 768);
  assert.equal(resolveChatWidth(1000, 1200), 880);
  assert.equal(resolveChatWidth(1600, 1200), 1200);
  assert.equal(resolveChatWidth(800, 300), 640);
  // CSS fits narrow columns; the layout cap must never become negative.
  assert.equal(resolveChatWidth(300, 1200), 640);
});

test('width preference accepts only finite numeric widths and safely handles unavailable storage', () => {
  for (const value of [null, '', 'null', 'NaN', 'Infinity', '-1', '0', 'abc', '"900"'])
    assert.equal(readChatWidth({ getItem: () => value }), null);
  assert.equal(readChatWidth({ getItem: () => '912.7' }), 913);
  assert.equal(readChatWidth({ getItem: () => '100' }), 640);
  assert.equal(
    readChatWidth({
      getItem: () => {
        throw Error('blocked');
      },
    }),
    null,
  );
  assert.equal(
    saveChatWidth(900, {
      setItem: () => {
        throw Error('full');
      },
      removeItem() {},
    }),
    false,
  );
});

test('saving and resetting touches only the local width key', () => {
  const calls: unknown[][] = [];
  const storage = {
    setItem: (...args: string[]) => {
      calls.push(args);
    },
    removeItem: (key: string) => {
      calls.push([key]);
    },
  };
  assert.equal(saveChatWidth(912.7, storage), true);
  assert.equal(saveChatWidth(null, storage), true);
  assert.deepEqual(calls, [[chatWidthKey, '913'], [chatWidthKey]]);
});
