import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@cc-desk-tunnel/protocol';
import {
  projectIdentity,
  projectPreferenceKey,
  terminalProjects,
} from '../src/developmentProjects.ts';
const session = (
  id: string,
  deviceId: string,
  path = '/work/app',
  updatedAt = '2026-11-05T10:00:00Z',
) =>
  ({
    id,
    title: id,
    device: { id: deviceId, name: deviceId, viaSsh: true },
    projectPath: path,
    updatedAt,
    createdAt: updatedAt,
    activeRun: null,
    permissionMode: 'default',
    model: null,
    effort: null,
  }) as Session;
test('project identity isolates service, device and case-sensitive POSIX directories', () => {
  const key = projectIdentity('service', '01', '/work/app/');
  assert.equal(key, projectIdentity('service', '01', '/work/app'));
  assert.notEqual(key, projectIdentity('other', '01', '/work/app'));
  assert.notEqual(key, projectIdentity('service', '02', '/work/app'));
  assert.notEqual(key, projectIdentity('service', '01', '/work/App'));
});
test('local preferences retain old path keys while remote keys include scope and device', () => {
  assert.equal(projectPreferenceKey('service', undefined, 'D:\\work\\App'), 'd:\\work\\app');
  assert.notEqual(
    projectPreferenceKey('service', '01', '/work/app'),
    projectPreferenceKey('service', '02', '/work/app'),
  );
  assert.notEqual(
    projectPreferenceKey('service', '01', '/work/app'),
    projectPreferenceKey('other', '01', '/work/app'),
  );
});
test('terminal projects deduplicate device/path and prefer active source then newest stable source', () => {
  const a = session('a', '01');
  const b = session('b', '01', '/work/app', '2026-11-05T11:00:00Z');
  const c = session('c', '02');
  const sameTime = session('aa', '01', '/work/app', '2026-11-05T11:00:00Z');
  const entries = terminalProjects([a, b, c, sameTime], 'service');
  assert.equal(entries.length, 2);
  assert.equal(entries.find((p) => p.deviceId === '01')?.source.id, 'aa');
  assert.equal(terminalProjects([b, a, c], 'service', a)[0].source.id, 'a');
  assert.equal(terminalProjects([a, b, c], 'service', a)[0].deviceName, '01');
});
