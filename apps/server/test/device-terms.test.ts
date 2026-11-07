import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceTerms } from '../src/device-terms.ts';

test('Windows transfer paths are absolute for sftp as well as scp', () => {
  assert.ok(deviceTerms('win32', 'C:\\项目 甲').command.includes('device:/C:/项目 甲'));
  assert.ok(deviceTerms('win32', '/C:/项目').command.includes('device:/C:/项目'));
  assert.ok(deviceTerms('linux', '/home/me/项目', true).command.includes('device:/home/me/项目'));
});
