import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeService } from '../electron/service-upgrade.mjs';

test('a managed client refuses server upgrade before opening any connection', async () => {
  for (const service of ['0.1.0', '0.3.2', '0.3.6']) {
    let connections = 0;
    await assert.rejects(
      async () =>
        upgradeService(
          { url: 'ws://127.0.0.1:1/ws', token: 'test', deviceName: 'test', service },
          {
            open: () => {
              connections++;
              throw new Error('must not connect');
            },
          },
        ),
      /管理员/,
    );
    assert.equal(connections, 0);
  }
});
