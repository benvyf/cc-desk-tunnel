import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { clearPastedPictures } = createRequire(import.meta.url)('../electron/pasted-images.cjs');

test('clipboard expiry keeps old and structured draft references and only removes expired unused images', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cc-pasted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (name, old = true) => {
    const target = join(root, name);
    writeFileSync(target, 'image');
    if (old) {
      const at = new Date(Date.now() - 8 * 24 * 3600 * 1000);
      utimesSync(target, at, at);
    }
    return target;
  };
  const legacy = file('旧草稿.png');
  const body = file('复合正文.png');
  const attached = file('附件.png');
  const unused = file('过期未用.png');
  const recent = file('刚粘贴.png', false);
  await clearPastedPictures(root, {
    old: `看看这张图 "${legacy}"`,
    structured: { text: `"${body}"`, attachments: [{ path: attached }] },
    malformed: null,
  });
  for (const target of [legacy, body, attached, recent]) assert.equal(existsSync(target), true);
  assert.equal(existsSync(unused), false);
  await clearPastedPictures(root, null);
  for (const target of [legacy, body, attached]) assert.equal(existsSync(target), false);
  assert.equal(existsSync(recent), true);
  await clearPastedPictures(join(root, 'missing'), {});
});
