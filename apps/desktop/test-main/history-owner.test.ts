import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyOwner } from '../src/historyOwner.ts';

test('email owners use reliable service email and workspace node, independent of ticket rotation', () => {
  assert.equal(
    historyOwner({ mode: 'email', email: 'User@Example.org', nodeId: 'one' }),
    'email|user@example.org|one',
  );
  assert.notEqual(
    historyOwner({ mode: 'email', email: 'User@Example.org', nodeId: 'one' }),
    historyOwner({ mode: 'email', email: 'User@Example.org', nodeId: 'two' }),
  );
  assert.equal(historyOwner({ mode: 'email', email: '', nodeId: 'one' }), undefined);
  assert.equal(historyOwner({ mode: 'email', email: 'User@Example.org', nodeId: '' }), undefined);
  assert.equal(historyOwner({ mode: 'email', nodeId: 'one' }), undefined);
});
test('manual and local identities match the secret-free specification exactly', () => {
  assert.equal(
    historyOwner({ mode: 'remote', url: 'wss://one/ws', fingerprint: 'SHA256:x' }),
    'manual|wss://one/ws|SHA256:x',
  );
  assert.equal(
    historyOwner({ mode: 'local', url: 'ws://localhost/ws' }),
    'local|ws://localhost/ws',
  );
});
