import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StopSequence } from '../src/stopSequence.ts';

test('requires two presses within500ms on the same live run and consumes the pair', () => {
  const sequence = new StopSequence();
  assert.equal(sequence.press('main:run', 0), false);
  assert.equal(sequence.press('main:run', 500), true);
  assert.equal(sequence.press('main:run', 501), false);
  assert.equal(sequence.press('main:run', 1002), false);
  assert.equal(sequence.press('main:run', 1100), true);
});
test('does not combine sessions, turns, backwards clocks or reset interactions', () => {
  const sequence = new StopSequence();
  for (const key of ['main:1', 'side:1', 'side:2']) assert.equal(sequence.press(key, 10), false);
  sequence.reset();
  assert.equal(sequence.press('side:2', 11), false);
  assert.equal(sequence.press('side:2', 9), false);
  assert.equal(sequence.press('side:2', 12), true);
});
