import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { PasswordAuth } from '../src/password-auth.ts';

const password = '我的管理员密码_2026_secure';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-password-auth-'));
  await mkdir(join(directory, 'private'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private');
  return { path, file: join(path, 'admin-login.json'), auth: new PasswordAuth(path) };
}

test('one-use setup stores only salted password hash and supports Unicode password login', async (t) => {
  const { auth, file, path } = await fixture(t);
  await assert.rejects(auth.login(password), /尚未设置/);
  const code = await auth.issueSetup();
  const first = await readFile(file, 'utf8');
  assert.ok(!first.includes(code));
  await assert.rejects(auth.setup('x'.repeat(43), password), /链接已过期或无效/);
  await assert.rejects(auth.setup(code, '1234567'), /8–128/);
  const session = await auth.setup(code, password);
  assert.equal(auth.accepts(session), true);
  const stored = await readFile(file, 'utf8');
  assert.ok(!stored.includes(password));
  assert.ok(!stored.includes(session));
  assert.equal(JSON.parse(stored).setup, undefined);
  await assert.rejects(auth.setup(code, password), /链接已过期或无效/);
  assert.equal(await auth.login('wrong_password_2026'), undefined);
  assert.ok(auth.accepts((await auth.login(password))!));
  const restarted = new PasswordAuth(path);
  assert.equal(restarted.accepts(session), false);
  assert.ok(restarted.accepts((await restarted.login(password))!));
  auth.logout(session);
  assert.equal(auth.accepts(session), false);
  const expired = (await auth.login(password))!;
  assert.equal(auth.accepts(expired, Date.now() + 8 * 3600000 + 1), false);
});

test('reissuing or expiring setup links rejects old links; resetting revokes sessions and old password', async (t) => {
  const { auth, file } = await fixture(t);
  const replaced = await auth.issueSetup();
  const current = await auth.issueSetup();
  await assert.rejects(auth.setup(replaced, password), /链接已过期或无效/);
  const session = await auth.setup(current, password);
  const reset = await auth.issueSetup();
  const changed = password + '_changed';
  await auth.setup(reset, changed);
  assert.equal(auth.accepts(session), false);
  assert.equal(await auth.login(password), undefined);
  assert.ok(auth.accepts((await auth.login(changed))!));
  const stale = await auth.issueSetup();
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.setup.expiresAt = 0;
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(auth.setup(stale, password), /链接已过期或无效/);
});

test('password derivation concurrency is bounded and does not consume setup token on busy rejection', async (t) => {
  const { auth } = await fixture(t);
  const code = await auth.issueSetup();
  const first = auth.setup(code, password);
  await assert.rejects(auth.setup(code, password), /繁忙/);
  assert.equal(auth.accepts(await first), true);
});

test('eight-character setup/change verifies current password and revokes old sessions and reset links', async (t) => {
  const { auth } = await fixture(t);
  const oldPassword = '旧密码12345';
  const newPassword = '新密码67890';
  assert.equal(oldPassword.length, 8);
  const oldSession = await auth.setup(await auth.issueSetup(), oldPassword);
  const pendingReset = await auth.issueSetup();
  await assert.rejects(auth.changePassword(oldPassword, '1234567'), /8–128/);
  assert.equal(await auth.changePassword('wrong_password', newPassword), undefined);
  assert.equal(auth.accepts(oldSession), true);
  assert.ok(await auth.login(oldPassword));
  const newSession = await auth.changePassword(oldPassword, newPassword);
  assert.ok(newSession && auth.accepts(newSession));
  assert.equal(auth.accepts(oldSession), false);
  assert.equal(await auth.login(oldPassword), undefined);
  assert.ok(await auth.login(newPassword));
  await assert.rejects(auth.setup(pendingReset, 'another_password'), /链接已过期或无效/);
});
