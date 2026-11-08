import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

test('all update IPC channels refuse even valid renderer requests', async () => {
  const require = createRequire(import.meta.url);
  const { registerManagedUpdates } = require('../electron/managed-updates.cjs');
  const handlers = new Map();
  registerManagedUpdates((channel, listener) => handlers.set(channel, listener));
  assert.deepEqual([...handlers.keys()].sort(), [
    'release:notes',
    'service:upgrade',
    'update:install',
  ]);
  for (const handler of handlers.values()) {
    await assert.rejects(
      async () => handler({ senderFrame: { url: 'file:///index.html' } }, '99.0.0'),
      /管理员/,
    );
  }
});
