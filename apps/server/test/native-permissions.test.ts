import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { permissionSourceSchema } from '@cc-desk-tunnel/protocol';
import {
  permissionPaths,
  projectPermissions,
  readPermissionSource,
  readPermissions,
} from '../src/native-permissions.ts';

const SECRET = 'sk-ant-api03-NEVER-SHOWN';
const settings = {
  env: { ANTHROPIC_API_KEY: SECRET, HTTPS_PROXY: 'http://proxy.invalid' },
  apiKeyHelper: `echo ${SECRET}`,
  hooks: { PreToolUse: [{ command: SECRET }] },
  model: 'claude-opus-4-7',
  unknownKey: SECRET,
  permissions: {
    allow: ['Bash(npm test:*)', 'Read(~/notes/**)', 42, { nested: SECRET }],
    deny: ['Bash(rm -rf:*)', ' spaced rule '],
    ask: ['WebFetch(domain:example.com)'],
    defaultMode: 'acceptEdits',
    additionalDirectories: ['/srv/shared'],
    unknownPermissionKey: SECRET,
  },
};
function directory(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cc-permissions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('only the rule lists, default mode and extra directories leave a file; secrets and other keys never', async (t) => {
  const root = directory(t);
  const path = join(root, 'settings.json');
  writeFileSync(path, JSON.stringify(settings));
  const before = { hash: digest(path), mtime: statSync(path).mtimeMs };
  const source = await readPermissionSource('user', path);
  const sent = JSON.stringify(source);
  assert.ok(!sent.includes(SECRET));
  for (const key of [
    'env',
    'apiKeyHelper',
    'hooks',
    'model',
    'unknownKey',
    'unknownPermissionKey',
    'nested',
    'proxy.invalid',
  ])
    assert.ok(!sent.includes(key), key);
  assert.deepEqual(Object.keys(source).sort(), [
    'additionalDirectories',
    'allow',
    'ask',
    'defaultMode',
    'deny',
    'path',
    'scope',
    'status',
  ]);
  assert.deepEqual(source.allow, ['Bash(npm test:*)', 'Read(~/notes/**)']);
  // As written: not trimmed.
  assert.deepEqual(source.deny, ['Bash(rm -rf:*)', ' spaced rule ']);
  assert.equal(source.defaultMode, 'acceptEdits');
  permissionSourceSchema.parse(source);
  // Read only: the file is as it was.
  assert.equal(digest(path), before.hash);
  assert.equal(statSync(path).mtimeMs, before.mtime);
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('what cannot be read is told by a status alone, never with the file’s bytes', async (t) => {
  const root = directory(t);
  const broken = join(root, 'broken.json');
  writeFileSync(broken, `{"permissions": {"allow": ["${SECRET}"`);
  const array = join(root, 'array.json');
  writeFileSync(array, '[1,2]');
  const large = join(root, 'large.json');
  writeFileSync(large, `{"x":"${'a'.repeat(2 * 1024 * 1024)}"}`);
  const empty = join(root, 'empty.json');
  writeFileSync(empty, '');
  const bom = join(root, 'bom.json');
  writeFileSync(bom, '\uFEFF{"permissions":{"deny":["X"]}}');
  const cases = await Promise.all([
    readPermissionSource('user', broken),
    readPermissionSource('user', array),
    readPermissionSource('user', large),
    readPermissionSource('user', join(root, 'missing.json')),
    readPermissionSource('user', join(broken, 'below')),
    readPermissionSource('user', root),
    readPermissionSource('user', empty),
    readPermissionSource('user', bom),
  ]);
  assert.deepEqual(
    cases.map((source) => source.status),
    ['invalid_json', 'invalid_json', 'too_large', 'missing', 'missing', 'not_file', 'ok', 'ok'],
  );
  assert.ok(!JSON.stringify(cases).includes(SECRET));
  assert.deepEqual(cases[7].deny, ['X']);
  for (const source of cases) permissionSourceSchema.parse(source);
});

test(
  'a link is followed as the CLI follows it, and marked',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = directory(t);
    const target = join(root, 'real.json');
    writeFileSync(target, JSON.stringify(settings));
    const link = join(root, 'link.json');
    symlinkSync(target, link);
    const source = await readPermissionSource('local', link);
    assert.equal(source.symlink, true);
    assert.equal(source.status, 'ok');
    assert.ok(!JSON.stringify(source).includes(SECRET));
  },
);

test('many or long rules are cut, and say so', () => {
  const projected = projectPermissions({
    permissions: {
      allow: Array.from({ length: 600 }, (_, index) => `Rule(${index})`),
      deny: ['x'.repeat(2001)],
    },
  });
  assert.equal(projected.allow.length, 500);
  assert.deepEqual(projected.deny, []);
  assert.equal(projected.truncated, true);
  assert.equal(
    projectPermissions({ permissions: { defaultMode: 'rm -rf' } }).defaultMode,
    undefined,
  );
});

test('the files are where the CLI looks for a session, and none is created for looking', async (t) => {
  const root = directory(t);
  const cwd = join(root, 'native', 'root-1');
  const paths = permissionPaths(
    { settingsPath: '/srv/cc/settings.json', environment: { CLAUDE_CONFIG_DIR: 'config' } },
    cwd,
    'linux',
  );
  assert.deepEqual(paths, [
    { scope: 'user', path: join(cwd, 'config', 'settings.json') },
    { scope: 'project', path: join(cwd, '.claude', 'settings.json') },
    { scope: 'local', path: join(cwd, '.claude', 'settings.local.json') },
    { scope: 'flag', path: '/srv/cc/settings.json' },
    { scope: 'managed', path: '/etc/claude-code/managed-settings.json' },
  ]);
  assert.deepEqual(
    permissionPaths({}, undefined, 'win32').map((path) => path.scope),
    ['user'],
  );
  const sources = await readPermissions(paths.slice(1, 3));
  assert.deepEqual(
    sources.map((source) => source.status),
    ['missing', 'missing'],
  );
  assert.equal(existsSync(cwd), false);
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify(settings));
  const local = digest(join(cwd, '.claude', 'settings.local.json'));
  const [, read] = await readPermissions(paths.slice(1, 3));
  assert.deepEqual(read.ask, ['WebFetch(domain:example.com)']);
  assert.equal(digest(join(cwd, '.claude', 'settings.local.json')), local);
});

test('the budget is of bytes as sent, over all the files read together', async (t) => {
  const root = directory(t);
  const rule = '中'.repeat(1900);
  const paths = ['a', 'b', 'c'].map((name) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify({ permissions: { allow: Array(20).fill(rule) } }));
    return { scope: 'user' as const, path };
  });
  const sources = await readPermissions(paths);
  const kept = sources.reduce((total, source) => total + source.allow.length, 0);
  assert.ok(kept < 60);
  assert.ok(Buffer.byteLength(JSON.stringify(sources)) < 200 * 1024);
  assert.equal(sources.at(-1)!.truncated, true);
});
