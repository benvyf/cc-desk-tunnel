import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { openClientBrowser } = createRequire(import.meta.url)('../electron/client-browser.cjs');

test('client browser handoff rejects management URLs before opening a browser', async () => {
  const calls = [];
  for (const target of [
    'https://api.ghostapi.org/cc-updates/admin',
    'https://api.ghostapi.org/cc-updates/admin/updates?x=1',
    'https://API.GHOSTAPI.ORG/cc-updates/%61dmin/api/status',
    'https://api.ghostapi.org/cc-updates/./admin/updates',
    'https://api.ghostapi.org./cc-updates/admin/updates',
    'https://api.ghostapi.org/cc-updates/x%2f..%2fadmin/updates',
    'https://api.ghostapi.org/cc-updates%2f.%2fadmin/updates',
  ]) {
    await assert.rejects(async () => openClientBrowser(target, (url) => calls.push(url)), /管理员/);
  }
  assert.deepEqual(calls, []);
});

test('public installers and ordinary web links still open without administration access', async () => {
  const calls = [];
  for (const target of [
    'https://api.ghostapi.org/cc-updates/v1/artifacts/26/win32-x64/CC-Space-Setup-0.3.9-x64.exe',
    'https://example.com/docs',
    'mailto:help@example.com',
  ])
    await openClientBrowser(target, (url) => calls.push(url));
  assert.equal(calls.length, 3);
});
