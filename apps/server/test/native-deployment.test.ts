import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { enforceManagedDeployment } from '../src/native-deployment.ts';
import { nativeTerminalPolicy } from '../src/native-terminal-policy.ts';

const node = {
  endpoint: 'https://127.0.0.1/cc-updates/v1/moderation/check',
  nodeId: 'fixture-node',
  token: 'x'.repeat(43),
};
function fixture(options: { mount?: string; credential?: unknown; policyError?: boolean } = {}) {
  let policyChecks = 0;
  const io = {
    read(path: string) {
      if (path === '/proc/self/mountinfo')
        return (
          options.mount ??
          '44 23 0:52 /managed /etc/claude-code ro,relatime - ext4 /dev/fixture rw\n'
        );
      assert.equal(path, '/etc/claude-code/moderation-node.json');
      return JSON.stringify(options.credential ?? node);
    },
    policy() {
      policyChecks++;
      if (options.policyError) throw new Error('administrator policy rejected');
      return '/opt/runtime/cli/bin/claude';
    },
  };
  return { io, checks: () => policyChecks };
}

test('production bootstrap overrides attempted gate disable and preserves account/transport settings', () => {
  const env = {
    PROXY_ADAPTER: 'simulation',
    PROXY_MODERATION_CONFIG: '',
    PROXY_NATIVE_TERMINAL_REVIEW: '0',
    CLAUDE_PATH: '/data/untrusted',
    HTTPS_PROXY: 'fixture-proxy',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    PROXY_TOKEN: 'fixture-service-token',
  };
  const f = fixture();
  enforceManagedDeployment(env, f.io);
  assert.equal(env.PROXY_ADAPTER, 'claude-code');
  assert.equal(env.PROXY_MODERATION_CONFIG, '/etc/claude-code/moderation-node.json');
  assert.equal(env.PROXY_NATIVE_TERMINAL_REVIEW, '1');
  assert.equal(env.CLAUDE_PATH, '/opt/runtime/cli/bin/claude');
  assert.equal(env.HTTPS_PROXY, 'fixture-proxy');
  assert.equal(env.PROXY_TOKEN, 'fixture-service-token');
  assert.equal(env.DISABLE_TELEMETRY, '1');
  assert.equal(env.DISABLE_ERROR_REPORTING, '1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.equal(f.checks(), 1);
});

test('missing or writable managed mounts fail before enabling the server', () => {
  for (const mount of [
    '',
    '44 23 0:52 /managed /etc/claude-code rw,relatime - ext4 /dev/fixture rw\n',
    '44 23 0:52 /managed /data/fake ro,relatime - ext4 /dev/fixture rw\n',
  ]) {
    const f = fixture({ mount });
    const env = { PROXY_NATIVE_TERMINAL_REVIEW: '0' };
    assert.throws(() => enforceManagedDeployment(env, f.io), /mounted read-only/);
    assert.equal(f.checks(), 0);
    assert.equal(env.PROXY_NATIVE_TERMINAL_REVIEW, '0');
  }
});

test('rejected administrator policy prevents startup', () => {
  const f = fixture({ policyError: true });
  assert.throws(() => enforceManagedDeployment({}, f.io), /native policy is invalid/);
});

test('missing or invalid node authentication prevents startup without network requests', () => {
  for (const credential of [
    {},
    { ...node, token: '' },
    { ...node, nodeId: '' },
    { ...node, endpoint: 'http://127.0.0.1/cc-updates/v1/moderation/check' },
  ]) {
    const f = fixture({ credential });
    assert.throws(() => enforceManagedDeployment({}, f.io));
  }
});

test('packaged installation policy exactly matches the native terminal policy', () => {
  const packaged = JSON.parse(
    readFileSync(new URL('../../../deploy/docker/managed-settings.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(packaged, nativeTerminalPolicy());
});

test('malformed credential diagnostics never echo credential text', () => {
  const f = fixture();
  const io = {
    ...f.io,
    read: (path: string) =>
      path === '/proc/self/mountinfo' ? f.io.read(path) : '{"token":"private-fixture-value"',
  };
  assert.throws(
    () => enforceManagedDeployment({}, io),
    (error: Error) => {
      assert.equal(error.message, 'Managed node configuration is invalid');
      assert.ok(!error.stack?.includes('private-fixture-value'));
      return true;
    },
  );
});
