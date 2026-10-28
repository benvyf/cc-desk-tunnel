import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
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
