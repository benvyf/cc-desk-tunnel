import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('the actual image runtime callback admits the packaged runtime marker and rejects incompatible metadata', () => {
  const source = readFileSync(new URL('../src/managed-server-main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('runtimeCheck: () => {'),
    end = source.indexOf('\n  launch:', start);
  assert.ok(start >= 0 && end > start);
  const callback = source.slice(start + 'runtimeCheck: '.length, end).replace(/,\s*$/, '');
  const level = readFileSync(
    new URL('../../../deploy/docker/runtime-level', import.meta.url),
    'utf8',
  );
  const check = (marker: string, platform = 'linux', mode = 0o100755) =>
    runInNewContext('(' + callback + ')()', {
      process: { platform, arch: 'x64', versions: { node: '24.22.2' } },
      readFileSync: () => marker,
      statSync: () => ({ uid: 0, mode, isFile: () => true }),
    });
  assert.equal(check(level), true);
  assert.equal(check('unexpected-runtime'), false);
  assert.equal(check(level, 'win32'), false);
  assert.equal(check(level, 'linux', 0o100777), false);
});
