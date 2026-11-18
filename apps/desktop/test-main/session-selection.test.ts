import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruned, ranged, runBatch, toggled } from '../src/sessionSelection.ts';

test('a row is taken in and out; a range runs in the order shown from the anchor', () => {
  assert.deepEqual([...toggled(new Set(['a']), 'b')], ['a', 'b']);
  assert.deepEqual([...toggled(new Set(['a', 'b']), 'a')], ['b']);
  const shown = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual([...ranged(new Set(), shown, 'b', 'd')].sort(), ['b', 'c', 'd']);
  assert.deepEqual([...ranged(new Set(['e']), shown, 'd', 'b')].sort(), ['b', 'c', 'd', 'e']);
  assert.deepEqual([...ranged(new Set(), shown, undefined, 'c')], ['c']);
  assert.deepEqual([...ranged(new Set(), shown, 'gone', 'c')], ['c']);
});

test('what can no longer be chosen drops out, and nothing changes when all still can', () => {
  const chosen = new Set(['a', 'b']);
  assert.equal(pruned(chosen, new Set(['a', 'b', 'c'])), chosen);
  assert.deepEqual([...pruned(chosen, new Set(['b']))], ['b']);
});

test('a batch goes one by one, tells each failure by name, and counts what is already gone as done', async () => {
  const order: string[] = [];
  let running = 0;
  const progress: string[] = [];
  const result = await runBatch(
    [
      { id: 'a', title: '甲' },
      { id: 'b', title: '乙' },
      { id: 'c', title: '丙' },
    ],
    async (id) => {
      running++;
      assert.equal(running, 1, 'side by side');
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (id === 'b') throw Object.assign(new Error('正在运行'), { code: 'run_active' });
      if (id === 'c') throw Object.assign(new Error('不存在'), { code: 'not_found' });
    },
    (done, total) => progress.push(`${done}/${total}`),
  );
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(result.done, ['a', 'c']);
  assert.deepEqual(result.failed, [
    { id: 'b', title: '乙', code: 'run_active', message: '正在运行' },
  ]);
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
});
