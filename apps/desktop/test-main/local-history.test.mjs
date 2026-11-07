import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const {
  historyOwner,
  readHistoryAttachment,
  allowHistoryPersistence,
} = require('../electron/local-history.cjs');
test('durable storage permission is limited to the owning application main frame', () => {
  const entry = join(tmpdir(), 'cc-history-entry.html');
  const contents = { mainFrame: { url: pathToFileURL(entry).href }, isDestroyed: () => false };
  assert.equal(
    allowHistoryPersistence(contents, 'persistent-storage', { isMainFrame: true }, contents, entry),
    true,
  );
  assert.equal(
    allowHistoryPersistence(
      contents,
      'persistent-storage',
      { isMainFrame: false },
      contents,
      entry,
    ),
    false,
  );
  assert.equal(
    allowHistoryPersistence(contents, 'media', { isMainFrame: true }, contents, entry),
    false,
  );
  assert.equal(
    allowHistoryPersistence(
      contents,
      'persistent-storage',
      { isMainFrame: true },
      { ...contents },
      entry,
    ),
    false,
  );
});
test('history owner is stable across login tickets and isolated by email and service', () => {
  assert.equal(
    historyOwner('https://center', ' Owner@Example.com '),
    historyOwner('https://center', 'owner@example.com'),
  );
  assert.notEqual(
    historyOwner('https://center', 'a@example.com'),
    historyOwner('https://center', 'b@example.com'),
  );
  assert.notEqual(
    historyOwner('https://center', 'a@example.com'),
    historyOwner('https://other', 'a@example.com'),
  );
  assert.equal(historyOwner('https://center', null), null);
});
test('attachment copies are bounded and never archive credential paths, targets or private key content', async (t) => {
  await assert.rejects(
    readHistoryAttachment('\\\\no-network-access.invalid\\share\\file.png'),
    /网络共享/,
  );
  const root = mkdtempSync(join(tmpdir(), 'cc-local-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'notes.txt');
  writeFileSync(file, '用户附件');
  assert.equal(
    await readHistoryAttachment(file),
    'data:application/octet-stream;base64,' + Buffer.from('用户附件').toString('base64'),
  );
  const hidden = join(root, '.ssh');
  mkdirSync(hidden);
  writeFileSync(join(hidden, 'notes.png'), 'dummy');
  await assert.rejects(readHistoryAttachment(join(hidden, 'notes.png')), /敏感/);
  const linked = join(root, 'linked');
  symlinkSync(hidden, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readHistoryAttachment(join(linked, 'notes.png')), /敏感/);
  const key = join(root, 'unusual-name.txt');
  // Build only a dummy header; no private key material or secret-scanner exemption.
  const marker = ['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' ');
  writeFileSync(key, marker + '\nnot-a-key-fixture');
  await assert.rejects(readHistoryAttachment(key), /私钥/);
  const credentials = join(root, 'provider.txt');
  writeFileSync(credentials, '{"access_token":"fixture-not-real"}');
  await assert.rejects(readHistoryAttachment(credentials), /认证/);
  const large = join(root, 'large.bin');
  writeFileSync(large, '');
  truncateSync(large, 20 * 1024 * 1024 + 1);
  await assert.rejects(readHistoryAttachment(large), /20 MB/);
});
