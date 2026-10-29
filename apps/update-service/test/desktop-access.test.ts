import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DesktopAccess } from '../src/desktop-access.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cc-access-'));
  await mkdir(join(root, 'private'));
  const store = new DesktopAccess(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const nodes = ['ubuntu-cc', 'other'];
  store.saveNode(
    nodes[0]!,
    {
      name: '开发空间',
      url: 'wss://example.test/ws',
      credential: 'never-send-permanent-credential',
    },
    nodes,
  );
  const input = {
    email: 'Benben@example.com',
    password: 'personal-test-password',
    enabled: true,
    nodes: ['ubuntu-cc'],
  };
  const id = await store.saveUser(undefined, input, nodes);
  return { root, store, nodes, input, id };
}
test('email login issues scoped expiring tickets; resets and disabling revoke sessions', async (t) => {
  const { store, nodes, input, id } = await fixture(t);
  const now = Date.now();
  const login = await store.login(
    { email: 'benben@example.com', password: input.password, remember: true },
    'one',
    now,
  );
  assert.equal(login.email, 'benben@example.com');
  assert.deepEqual(
    login.workspaces.map((x) => x.id),
    ['ubuntu-cc'],
  );
  const ticket = store.connect(login.token, 'ubuntu-cc', now);
  assert.ok(!JSON.stringify(ticket).includes('never-send'));
  assert.throws(() => store.connect(login.token, 'other', now), /未分配/);
  assert.throws(() => store.validate(ticket.token, 'other', false, now), /失效/);
  assert.throws(() => store.validate(ticket.token + 'x', 'ubuntu-cc', false, now), /失效/);
  assert.throws(() => store.validate(ticket.token, 'ubuntu-cc', false, now + 120001), /失效/);
  assert.equal(store.validate(ticket.token, 'ubuntu-cc', true, now + 120001).userId, id);
  await store.saveUser(id, { ...input, password: 'changed-password' }, nodes);
  assert.throws(() => store.workspaces(login.token), /失效/);
  assert.throws(() => store.validate(ticket.token, 'ubuntu-cc', true), /失效/);
  const next = await store.login({ email: input.email, password: 'changed-password' }, 'one');
  await store.saveUser(id, { ...input, password: '', enabled: false }, nodes);
  assert.throws(() => store.workspaces(next.token), /失效/);
  await assert.rejects(
    store.login({ email: input.email, password: 'changed-password' }, 'one'),
    /邮箱或密码/,
  );
});
test('credentials are redacted, remembered login persists, logout revokes, failures are throttled', async (t) => {
  const { root, store, input } = await fixture(t);
  const login = await store.login(input, 'one');
  const bytes = await readFile(join(root, 'private', 'desktop-access.sqlite'));
  assert.ok(!bytes.includes(Buffer.from(input.password)));
  assert.ok(!bytes.includes(Buffer.from(login.token)));
  assert.ok(!bytes.includes(Buffer.from('never-send-permanent-credential')));
  assert.ok(!JSON.stringify(store.status(['ubuntu-cc'])).includes('never-send'));
  const restarted = new DesktopAccess(root);
  assert.equal(restarted.workspaces(login.token).length, 1);
  restarted.logout(login.token);
  restarted.close();
  assert.throws(() => store.workspaces(login.token), /失效/);
  for (let i = 0; i < 10; i++)
    await assert.rejects(
      store.login({ email: input.email, password: 'incorrect' }, 'failure'),
      /邮箱或密码/,
    );
  await assert.rejects(store.login(input, 'failure'), /一分钟/);
});

test('a password reset in flight cannot undo a newer disable or grant revocation', async (t) => {
  const { store, nodes, input, id } = await fixture(t);
  const reset = store.saveUser(id, { ...input, password: 'replacement-password' }, nodes);
  const rejected = assert.rejects(reset, /已被修改/);
  await store.saveUser(id, { ...input, password: '', enabled: false, nodes: [] }, nodes);
  await rejected;
  const user = store.status(nodes).users.find((user) => user.id === id)!;
  assert.equal(user.enabled, false);
  assert.deepEqual(user.nodes, []);
});

test('ticket replacement, grant revocation and exact session expiry reject old authorization', async (t) => {
  const { store, nodes, input, id } = await fixture(t);
  const now = Date.now();
  const login = await store.login(input, 'expiry-test', now);
  const old = store.connect(login.token, 'ubuntu-cc', now);
  const next = store.connect(login.token, 'ubuntu-cc', now + 1);
  assert.throws(() => store.validate(old.token, 'ubuntu-cc', true, now + 2), /失效/);
  assert.equal(store.validate(next.token, 'ubuntu-cc', false, now + 2).userId, id);
  assert.throws(() => store.workspaces(login.token, login.expiresAt), /失效/);
  assert.throws(() => store.validate(next.token, 'ubuntu-cc', true, login.expiresAt), /失效/);
  await store.saveUser(id, { ...input, password: '', nodes: [] }, nodes);
  assert.throws(() => store.validate(next.token, 'ubuntu-cc', true, now + 3), /失效/);
  const renewedLogin = await store.login(input, 'expiry-test');
  assert.deepEqual(renewedLogin.workspaces, []);
  assert.throws(() => store.connect(renewedLogin.token, 'ubuntu-cc'), /未分配/);
});

test('only the latest computer remains authorized; same-computer windows coexist and bad passwords cannot evict', async (t) => {
  const { root, store, input } = await fixture(t);
  const deviceA = '11111111-1111-4111-8111-111111111111';
  const deviceB = '22222222-2222-4222-8222-222222222222';
  const first = await store.login({ ...input, deviceId: deviceA, remember: true }, 'same-nat');
  const firstTicket = store.connect(first.token, 'ubuntu-cc');
  const anotherWindow = await store.login({ ...input, deviceId: deviceA }, 'same-nat');
  const otherTicket = store.connect(anotherWindow.token, 'ubuntu-cc');
  assert.equal(store.workspaces(first.token).length, 1);
  assert.ok(store.validate(firstTicket.token, 'ubuntu-cc', true));
  await assert.rejects(
    store.login({ ...input, password: 'wrong-password', deviceId: deviceB }, 'same-nat'),
    /邮箱或密码/,
  );
  assert.equal(store.workspaces(first.token).length, 1);
  const latest = await store.login({ ...input, deviceId: deviceB }, 'same-nat');
  for (const old of [first, anotherWindow]) {
    assert.throws(() => store.workspaces(old.token), /失效/);
    assert.throws(() => store.connect(old.token, 'ubuntu-cc'), /失效/);
    store.logout(old.token); // A late logout from the evicted computer cannot log out the winner.
  }
  for (const old of [firstTicket, otherTicket]) {
    assert.throws(() => store.validate(old.token, 'ubuntu-cc', false), /失效/);
    assert.throws(() => store.validate(old.token, 'ubuntu-cc', true), /失效/);
  }
  const reopened = new DesktopAccess(root);
  try {
    assert.equal(reopened.workspaces(latest.token).length, 1);
    assert.throws(() => reopened.workspaces(first.token), /失效/);
  } finally {
    reopened.close();
  }
  const legacy = await store.login(input, 'legacy-client');
  assert.throws(() => store.workspaces(latest.token), /失效/);
  assert.equal(store.workspaces(legacy.token).length, 1);
  await store.login({ ...input, deviceId: deviceA }, 'same-nat');
  assert.throws(() => store.workspaces(legacy.token), /失效/);
});

test('existing session databases migrate without invalidating login until the next computer signs in', async (t) => {
  const { root, store, input } = await fixture(t);
  const before = await store.login(input, 'old-client');
  const db = new DatabaseSync(join(root, 'private', 'desktop-access.sqlite'));
  db.exec('DROP TABLE session_devices');
  db.exec('DROP TABLE remembered_sessions');
  db.close();
  const migrated = new DesktopAccess(root);
  try {
    assert.equal(migrated.workspaces(before.token).length, 1);
    const after = await migrated.login(
      { ...input, deviceId: '33333333-3333-4333-8333-333333333333' },
      'new-client',
    );
    assert.throws(() => migrated.workspaces(before.token), /失效/);
    assert.equal(migrated.workspaces(after.token).length, 1);
  } finally {
    migrated.close();
  }
});

test('renaming an email while its password is being verified rejects the stale login', async (t) => {
  const { store, input, nodes, id } = await fixture(t);
  const pending = store.login(input, 'old-computer');
  const refused = assert.rejects(pending, /邮箱或密码/);
  await store.saveUser(id, { ...input, email: 'renamed@example.com', password: '' }, nodes);
  await refused;
  const next = await store.login({ ...input, email: 'renamed@example.com' }, 'new-computer');
  assert.equal(next.email, 'renamed@example.com');
  assert.equal(store.workspaces(next.token).length, 1);
});

test('a failed computer replacement rolls back old sessions, tickets and device mappings', async (t) => {
  const { root, store, input } = await fixture(t);
  const first = await store.login(
    { ...input, deviceId: '11111111-1111-4111-8111-111111111111' },
    'a',
  );
  const ticket = store.connect(first.token, 'ubuntu-cc');
  const db = new DatabaseSync(join(root, 'private', 'desktop-access.sqlite'));
  try {
    db.exec(
      "CREATE TRIGGER fail_device_insert BEFORE INSERT ON session_devices BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
    );
    await assert.rejects(
      store.login({ ...input, deviceId: '22222222-2222-4222-8222-222222222222' }, 'b'),
      /simulated write failure/,
    );
    assert.equal(store.workspaces(first.token).length, 1);
    assert.ok(store.validate(ticket.token, 'ubuntu-cc', true));
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_devices').get()!.n, 1);
    db.exec('DROP TRIGGER fail_device_insert');
    const next = await store.login(
      { ...input, deviceId: '22222222-2222-4222-8222-222222222222' },
      'b',
    );
    assert.throws(() => store.workspaces(first.token), /失效/);
    assert.equal(store.workspaces(next.token).length, 1);
  } finally {
    db.close();
  }
});

test('remembered sessions survive overnight and renew during use, while idle and ordinary sessions expire', async (t) => {
  const { store, input } = await fixture(t);
  const now = Date.now(),
    day = 86400_000;
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const remembered = await store.login({ ...input, deviceId, remember: true }, 'remembered', now);
  const ordinary = await store.login({ ...input, deviceId }, 'ordinary', now);
  assert.equal(store.workspaces(remembered.token, now + day / 2).length, 1);
  assert.throws(() => store.workspaces(ordinary.token, now + 8 * 3600_000), /失效/);
  assert.equal(store.workspaces(remembered.token, now + 2 * day).length, 1);
  assert.equal(store.workspaces(remembered.token, now + 31 * day).length, 1);
  assert.throws(() => store.workspaces(remembered.token, now + 61 * day), /失效/);
});
