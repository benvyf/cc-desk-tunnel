import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';
import { historyWindow } from '../src/historyWindow.ts';
const event = (sequence: number, runId: string, bytes: number): SessionEvent => ({
  sequence,
  runId,
  sessionId: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-11-08T00:00:00.000Z',
  payload: {
    type: 'text.delta',
    messageId: '00000000-0000-4000-8000-000000000002',
    text: 'x'.repeat(bytes),
  },
});
test('a 6 MB memory history sends only complete tail runs within the soft window', () => {
  const events = Array.from({ length: 30 }, (_, i) =>
    event(i + 1, `run-${Math.floor(i / 2)}`, 200000),
  );
  const tail = historyWindow(events, false)!;
  assert.equal(tail.events[0].runId, 'run-13');
  assert.equal(tail.events.length, 4);
  assert.equal(tail.hasEarlier, true);
  assert.ok(Buffer.byteLength(JSON.stringify(tail)) < 1024 * 1024);
});
test('the latest 1.5 MB run is retained whole above the soft budgets', () => {
  const tail = historyWindow(
    [event(1, 'old', 100), event(2, 'latest', 750000), event(3, 'latest', 750000)],
    false,
  )!;
  assert.deepEqual(
    tail.events.map((e) => e.sequence),
    [2, 3],
  );
  assert.equal(tail.hasEarlier, true);
});
test('only a latest run above 4 MB is skipped; older oversized runs do not prevent caching', () => {
  assert.equal(historyWindow([event(1, 'latest', 4300000)], false), null);
  assert.deepEqual(
    historyWindow([event(1, 'old', 6000000), event(2, 'latest', 10)], false)!.events.map(
      (e) => e.sequence,
    ),
    [2],
  );
});
