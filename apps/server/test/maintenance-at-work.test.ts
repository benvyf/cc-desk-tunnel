import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ManagedBackend } from '../src/managed-server-http.ts';
import { atWork, createProxyServer } from '../src/server.ts';

test('what holds a server update back: work, not a terminal at rest or background tasks', () => {
  const run = (fields: Record<string, unknown>) =>
    ({ id: randomUUID(), connectionId: randomUUID(), status: 'running', ...fields }) as never;
  assert.equal(atWork(null), false);
  assert.equal(atWork(run({})), true, 'a turn under way');
  assert.equal(atWork(run({ status: 'awaiting_approval', waiting: 'approval' })), true);
  assert.equal(atWork(run({ status: 'awaiting_approval', waiting: 'question' })), true);
  assert.equal(atWork(run({ waiting: 'background' })), false, 'only background tasks go on');
  assert.equal(atWork(run({ surface: 'terminal' })), false, 'a terminal nothing was asked of');
  assert.equal(atWork(run({ surface: 'terminal', activity: 'idle' })), false);
  assert.equal(atWork(run({ surface: 'terminal', activity: 'working' })), true);
  assert.equal(atWork(run({ surface: 'terminal', activity: 'waiting' })), true);
});

test('the maintenance report counts only sessions at work, under the keys the center accepts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-at-work-'));
  const server = createProxyServer({
    token: 'maintenance-at-work-credential-1234567890',
    dataDir: root,
    managed: { backend: {} as ManagedBackend },
  });
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  await server.listen(0);
  const maintenance = server.managedMaintenance!;
  maintenance.release();
  const device = { id: randomUUID(), name: 'fixture', platform: 'linux' as const };
  const status = (sessionId: string, fields: Record<string, unknown>) =>
    server.store.append(sessionId, randomUUID(), {
      type: 'run.status',
      connectionId: randomUUID(),
      status: 'running',
      ...fields,
    } as never);
  const terminal = server.store.create(randomUUID(), 'terminal', root, device);
  const chat = server.store.create(randomUUID(), 'chat', root, device);

  status(terminal.id, { surface: 'terminal' });
  status(chat.id, { waiting: 'background' });
  assert.deepEqual(Object.keys(maintenance.activity()).sort(), [
    'connections',
    'pending',
    'registering',
    'reviews',
    'tasks',
    'terminals',
  ]);
  assert.equal(maintenance.activity().tasks, 0);
  assert.equal(maintenance.busy(), false, 'a terminal at rest and background tasks do not hold it');

  status(terminal.id, { surface: 'terminal', activity: 'working' });
  assert.equal(maintenance.activity().tasks, 1);
  assert.equal(maintenance.busy(), true, 'a terminal whose CLI works holds it');
  status(terminal.id, { surface: 'terminal', activity: 'idle' });
  assert.equal(maintenance.busy(), false);

  status(chat.id, {});
  assert.equal(maintenance.busy(), true, 'a turn under way holds it');
  status(chat.id, { status: 'awaiting_approval', waiting: 'question' });
  assert.equal(maintenance.busy(), true, 'a question waiting on the user holds it');
  status(chat.id, { status: 'completed' });
  assert.equal(maintenance.busy(), false);
  assert.equal(maintenance.enter(true), true, 'and the update may begin');
  maintenance.leave();
});
