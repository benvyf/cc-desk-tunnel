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

test('device labels are visible only for remote devices', async () => {
  const { deviceLabel } = await import('../src/developmentProjects.ts');
  assert.equal(typeof deviceLabel, 'function');
  assert.equal(deviceLabel(undefined, 'local'), '');
  assert.equal(deviceLabel({ id: 'local', name: 'My PC' }, 'local'), '');
  assert.equal(deviceLabel({ id: '01', name: '51' }, 'local'), '51');
});

test('terminal choices exclude ordinary sessions, other computers and unavailable SSH targets', async () => {
  const { terminalChoices } = await import('../src/developmentProjects.ts');
  assert.equal(typeof terminalChoices, 'function');
  const local = {
    ...session('local-project', 'local', 'D:\\work\\app'),
    device: { id: 'local', name: 'My PC', platform: 'win32' as const },
  };
  const ordinary = { ...local, id: 'ordinary', projectPath: 'D:\\sessions\\2026-11-05\\123456' };
  const other = { ...local, id: 'other', device: { ...local.device, id: 'other' } };
  const targets = ['01', '02', 'unavailable'].map((id) => ({
    id,
    name: id,
    available: id !== 'unavailable',
    projects: ['/work/app'],
    status: 'disconnected' as const,
    host: 'fixture.invalid',
    port: 22,
    username: 'dev',
    auth: 'key' as const,
    error: '',
  }));
  const choices = terminalChoices({
    sessions: [
      ordinary,
      other,
      session('unavailable', 'unavailable'),
      local,
      session('remote1', '01'),
      session('remote2', '02'),
    ],
    targets,
    localPaths: ['D:\\work\\APP', 'D:\\saved', 'D:\\saved'],
    localDeviceId: 'local',
    workspaceRoots: ['D:\\sessions'],
    scope: 'service',
  });
  assert.equal(choices.length, 4);
  assert.equal(
    choices.find((p) => p.deviceId === 'local' && p.source)?.source?.id,
    'local-project',
  );
  assert.equal(choices.filter((p) => p.path === '/work/app').length, 2);
  assert.equal(
    choices.some(
      (p) =>
        p.source?.id === 'ordinary' || p.source?.id === 'other' || p.deviceId === 'unavailable',
    ),
    false,
  );
  assert.equal(choices.find((p) => p.deviceId === 'local')?.deviceName, '');
});

test('terminal choices prefer active configuration, then newest and stable ID, before saved paths', async () => {
  const { terminalChoices } = await import('../src/developmentProjects.ts');
  assert.equal(typeof terminalChoices, 'function');
  const active = session('active', '01');
  const newest = session('newest', '01', '/work/app', '2026-11-06T10:00:00Z');
  const tie = session('aaa', '02', '/work/app', '2026-11-06T09:00:00Z');
  const laterId = { ...tie, id: 'zzz' };
  const targets = ['01', '02'].map((id) => ({
    id,
    name: id,
    available: true,
    projects: ['/work/app', '/work/saved'],
    status: 'connected' as const,
    host: 'fixture.invalid',
    port: 22,
    username: 'dev',
    auth: 'key' as const,
    error: '',
  }));
  const choices = terminalChoices({
    sessions: [newest, active, laterId, tie],
    targets,
    localPaths: [],
    localDeviceId: 'local',
    workspaceRoots: [],
    scope: 'service',
    active,
  });
  assert.equal(choices.length, 4);
  assert.equal(choices[0].source?.id, 'active');
  assert.equal(choices[1].source?.id, 'aaa');
  assert.equal(
    choices.slice(2).every((p) => !p.source),
    true,
  );
});
