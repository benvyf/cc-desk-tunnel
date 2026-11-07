import { createHook } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate as pause } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const { createHistoryCache } = createRequire(import.meta.url)(
  '../apps/desktop/electron/history-cache.cjs',
);
const root = await mkdtemp(join(tmpdir(), 'cc-cache-benchmark-'));
const cache = createHistoryCache(root);
const sessionId = randomUUID();
const events = Array.from({ length: 2000 }, (_, i) => ({
  sessionId,
  sequence: i + 1,
  runId: `run-${Math.floor(i / 10)}`,
  createdAt: '2026-11-08T00:00:00.000Z',
  payload: { type: 'text.delta', messageId: sessionId, text: '本机历史性能验收'.repeat(8) },
}));
const stack = [];
let maxSynchronousMs = 0,
  callbacks = 0;
const hook = createHook({
  before() {
    stack.push(performance.now());
  },
  after() {
    const start = stack.pop();
    if (start !== undefined) {
      maxSynchronousMs = Math.max(maxSynchronousMs, performance.now() - start);
      callbacks++;
    }
  },
});
const durations = [];
try {
  await cache.open('local|benchmark', PROTOCOL_VERSION);
  // Warm the runtime before sampling filesystem work and JSON callbacks.
  await cache.replace(sessionId, { firstSequence: 1, hasEarlier: false, events });
  await cache.read(sessionId);
  await cache.idle();
  hook.enable();
  for (let i = 0; i < 10; i++) {
    await pause();
    const start = performance.now();
    await cache.replace(sessionId, { firstSequence: 1, hasEarlier: false, events });
    const read = await cache.read(sessionId);
    if (read.events.length !== 2000) throw Error('Incomplete benchmark window');
    await cache.append(sessionId, [{ ...events.at(-1), sequence: 2001, runId: 'next' }]);
    await cache.idle();
    durations.push(performance.now() - start);
  }
  hook.disable();
  const result = {
    node: process.version,
    platform: process.platform,
    events: 2000,
    iterations: 10,
    fixtureBytes: Buffer.byteLength(JSON.stringify(events)),
    callbacks,
    maxSynchronousCallbackMs: Number(maxSynchronousMs.toFixed(3)),
    maxReplaceReadAppendWallMs: Number(Math.max(...durations).toFixed(3)),
    method:
      'async_hooks before/after measures uninterrupted JavaScript callback wall time; asynchronous filesystem waits excluded',
  };
  await mkdir(resolve('.local'), { recursive: true });
  await writeFile(
    resolve('.local/local-history-main-performance.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
  if (maxSynchronousMs > 8) process.exitCode = 1;
} finally {
  hook.disable();
  await cache.idle();
  await rm(root, { recursive: true, force: true });
}
