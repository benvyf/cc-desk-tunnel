import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionStore } from '../src/store.ts';
import { pathKey } from '@cc-desk-tunnel/protocol';

test('terminal creation saves settings atomically and survives restart without reinterpreting its source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-terminal-create-'));
  let store = new SessionStore(directory);
  try {
    const device = { id: randomUUID(), name: 'fixture', platform: 'linux' as const };
    const settings = {
      permissionMode: 'default' as const,
      model: 'fixture-model',
      effort: 'high' as const,
    };
    const session = store.createTerminal(
      'request',
      'original-source-signature',
      'terminal',
      '/fixture',
      device,
      settings,
    );
    assert.equal(store.get(session.id).session.permissionMode, 'default');
    assert.equal(store.get(session.id).session.model, 'fixture-model');
    assert.equal(store.get(session.id).session.effort, 'high');
    store.close();
    store = new SessionStore(directory);
    assert.equal(store.terminalCreated('request', 'original-source-signature')?.id, session.id);
    assert.throws(() => store.terminalCreated('request', 'different-source'), {
      code: 'request_conflict',
    });
    assert.equal(store.list().length, 1);
    // Failure after inserting the session rolls back both the settings and creation receipt.
    store.database.exec(
      "CREATE TRIGGER fixture_fail BEFORE INSERT ON terminal_creations BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
    );
    assert.throws(() =>
      store.createTerminal('failed', 'signature', 'terminal', '/fixture', device, settings),
    );
    assert.equal(store.created('failed'), undefined);
    assert.equal(store.terminalCreated('failed', 'signature'), undefined);
    assert.equal(store.list().length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('continuation preserves a legacy history root instead of replacing it with the current project root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-terminal-legacy-'));
  const store = new SessionStore(directory);
  try {
    const device = { id: randomUUID(), name: 'fixture', platform: 'linux' as const };
    const original = store.create('old', 'old', '/project', device);
    const now = new Date().toISOString();
    const binding = {
      sessionId: original.id,
      nativeId: randomUUID(),
      root: randomUUID(),
      deviceId: device.id,
      pathKey: pathKey(original.projectPath),
      configKey: 'fixture',
      mode: 'new' as const,
      createdAt: now,
      updatedAt: now,
    };
    const resumed = store.createTerminal(
      'resume',
      'resume-signature',
      'resume',
      '/project',
      device,
      original,
      binding,
    );
    assert.equal(resumed.nativeRoot, binding.root);
    assert.equal(store.get(resumed.id).session.nativeRoot, binding.root);
    assert.equal(store.terminalHistory(resumed.id)?.root, binding.root);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
