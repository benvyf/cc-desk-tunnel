import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearServiceVariables, environmentConfig } from '../src/config.ts';
import { createProxyServer } from '../src/server.ts';

const native = {
  PROXY_ADAPTER: 'claude-code',
  PROXY_TOKEN: 'a'.repeat(32),
  PROXY_PUBLIC_HOST: 'proxy.example.com',
  PROXY_TLS_MODE: 'reverse-proxy',
};
// What a deployment made before 0.2.10 still has in its configuration file.
const legacy = {
  FRPS_TLS_CERT: '/private/frp.crt',
  FRPS_TLS_KEY: '/private/frp.key',
  FRPS_SERVER_NAME: 'cc-desk-tunnel.frp',
  FRPS_PORT: 'NaN',
  FRPS_PATH: '/missing/frps',
};
test('managed services ignore old release settings and never enable online updates', () => {
  for (const repository of [
    undefined,
    'sun168567/cc-desk-tunnel',
    'benvyf/cc-desk-tunnel',
    'none',
  ]) {
    const { options } = environmentConfig(
      {
        ...native,
        PROXY_RELEASE_REPO: repository,
        PROXY_PROGRAM_DIR: '/data/program',
        PROXY_RUNTIME_DIR: '/opt/runtime',
      },
      '/state',
    );
    assert.equal(options.updates, undefined);
  }
});
test('reverse proxy mode leaves TLS to the proxy and defaults to loopback', () => {
  const { options, port } = environmentConfig(native, '/state');
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.reverseProxy, true);
  assert.equal(options.tls, undefined);
  assert.equal(port, 8787);
  assert.deepEqual(options.tunnel, {});
});
test('the frp settings of an older deployment are ignored, as is a missing public host', () => {
  const { options } = environmentConfig(
    { ...native, ...legacy, PROXY_PUBLIC_HOST: undefined },
    '/state',
  );
  assert.deepEqual(options.tunnel, {});
  assert.equal(
    environmentConfig({ PROXY_TOKEN: 'a'.repeat(32) }, '/state').options.tunnel,
    undefined,
  );
});
test('explicit native TLS mode is required', () => {
  assert.throws(
    () => environmentConfig({ ...native, PROXY_TLS_MODE: undefined }, '/state'),
    /Direct mode/,
  );
  assert.throws(
    () => environmentConfig({ ...native, PROXY_TLS_MODE: 'insecure' }, '/state'),
    /PROXY_TLS_MODE/,
  );

  assert.throws(() => environmentConfig({ ...native, PROXY_PORT: '0' }, '/state'), /PROXY_PORT/);
  assert.throws(
    () => environmentConfig({ ...native, CLAUDE_CONTEXT_RETENTION_DAYS: '0' }, '/state'),
    /RETENTION/,
  );
});
test('service settings are removed from the environment inherited by the native CLI, leaving everything else', () => {
  const env = {
    ...native,
    FRPS_PORT: '7000',
    PROXY_DATA_DIR: '/state',
    PROXY_NATIVE_TERMINAL_REVIEW: '1',
    CLAUDE_PATH: 'claude',
    CLAUDE_MODEL: 'opus',
    CLAUDE_SETTINGS_PATH: '/private/provider.json',
    CLAUDE_CONTEXT_RETENTION_DAYS: '30',
    HOME: '/data/home',
    PATH: '/usr/bin',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BASE_URL: 'https://api.example.com',
  };
  clearServiceVariables(env);
  assert.deepEqual(env, {
    HOME: '/data/home',
    PATH: '/usr/bin',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BASE_URL: 'https://api.example.com',
  });
});
test('native terminal review stays opt-in and requires the native adapter and node moderation', () => {
  assert.equal(environmentConfig(native, '/state').options.nativeTerminalReview, false);
  assert.throws(
    () => environmentConfig({ ...native, PROXY_NATIVE_TERMINAL_REVIEW: '1' }, '/state'),
    /node moderation/,
  );
  assert.throws(
    () => environmentConfig({ PROXY_NATIVE_TERMINAL_REVIEW: '1' }, '/state'),
    /native adapter/,
  );
});
test('native server fails before opening history storage when transport config is incomplete', () => {
  assert.throws(
    () =>
      createProxyServer({
        token: 'a'.repeat(32),
        dataDir: '/must-not-open',
        claude: { executable: 'claude' },
      }),
    /TLS/,
  );
});

test('email mode requires monitoring credentials and migration preserves manual login', () => {
  const env = {
    ...native,
    PROXY_MONITOR_URL: 'https://manager.example/cc-updates/admin/api/monitor/report',
    PROXY_MONITOR_NODE_ID: 'ubuntu-cc',
    PROXY_MONITOR_TOKEN: 'm'.repeat(43),
  };
  assert.equal(environmentConfig(env, '/state').options.desktopAccess?.allowLegacy, true);
  assert.equal(
    environmentConfig({ ...env, PROXY_LOGIN_MODE: 'email' }, '/state').options.desktopAccess
      ?.allowLegacy,
    false,
  );
  assert.equal(
    environmentConfig({ ...env, PROXY_LOGIN_MODE: 'token' }, '/state').options.desktopAccess,
    undefined,
  );
  assert.throws(
    () => environmentConfig({ ...native, PROXY_LOGIN_MODE: 'email' }, '/state'),
    /monitoring credentials/,
  );
  assert.throws(
    () => environmentConfig({ ...env, PROXY_LOGIN_MODE: 'invalid' }, '/state'),
    /PROXY_LOGIN_MODE/,
  );
});
