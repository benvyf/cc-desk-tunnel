import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  COMPATIBILITY_PATHS,
  PRODUCT,
  signServerIndex,
} from '../../../packages/managed-server/src/index.ts';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const config = {
  url: 'wss://service.example/nested/ws',
  fingerprint: '',
  token: 'fixture-service-token-at-least-24',
};
const current = { build: 1, appVersion: '0.3.6', protocol: PROTOCOL_VERSION - 1, sha256: null };
function check({
  build = 2,
  revision = build,
  protocol = PROTOCOL_VERSION,
  expiresAt = Date.now() + 60000,
  reason = 'available',
} = {}) {
  const release = {
    build,
    appVersion: '0.3.6',
    protocol,
    sourceCommit: 'a'.repeat(40),
    size: 100,
    sha256: 'b'.repeat(64),
    packageLockSha256: 'c'.repeat(64),
    descriptorSha256: 'd'.repeat(64),
    runtimeLevel: 'node24-cli2.1.295-v1',
    compatibility: Object.fromEntries(COMPATIBILITY_PATHS.map((p) => [p, 'e'.repeat(64)])),
  };
  return {
    schema: 1,
    current,
    candidate: release,
    index: signServerIndex(
      {
        schema: 1,
        product: PRODUCT,
        channel: 'pilot',
        platform: 'linux',
        arch: 'x64',
        revision,
        issuedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        release,
      },
      'fixture',
      privateKey,
    ),
    compatible: reason === 'available',
    reason,
  };
}
async function fixture(options = {}) {
  const { createManagedServerClient } = await import('../electron/managed-server-client.mjs');
  let response = check();
  const calls = [];
  const client = createManagedServerClient({
    keys: { fixture: publicKey },
    request: async (...args) => {
      calls.push(args);
      return typeof response === 'function' ? response(...args) : response;
    },
    ...options,
  });
  return {
    client,
    calls,
    set: (value) => {
      response = value;
    },
  };
}
test('check uses compiled protocol and fixed absolute route; install requires exact signed confirmation', async () => {
  const f = await fixture();
  const found = await f.client.check(config);
  assert.equal(found.candidate.build, 2);
  assert.deepEqual(f.calls[0].slice(1, 4), [
    'POST',
    '/cc-managed/server/v1/check',
    { clientProtocol: PROTOCOL_VERSION },
  ]);
  await assert.rejects(
    f.client.install({ ...config, confirmed: true, build: 3, sha256: found.candidate.sha256 }),
    /确认/,
  );
  f.set({ accepted: true, build: 2, sha256: found.candidate.sha256 });
  await f.client.install({ ...config, confirmed: true, build: 2, sha256: found.candidate.sha256 });
  assert.deepEqual(f.calls.at(-1).slice(1, 4), [
    'POST',
    '/cc-managed/server/v1/install',
    { clientProtocol: PROTOCOL_VERSION, confirmed: true, build: 2, sha256: found.candidate.sha256 },
  ]);
  assert.equal(f.client.busy(), true);
  f.set({
    schema: 1,
    phase: 'rolled-back',
    current,
    target: found.candidate,
    error: 'readiness-failed',
  });
  assert.equal((await f.client.status(config)).phase, 'rolled-back');
  assert.equal(f.client.busy(), false);
});
test('renderer inputs reject extra fields, insecure addresses, short tokens and malformed pins before transport', async () => {
  const f = await fixture();
  for (const input of [
    { ...config, clientProtocol: 999 },
    { ...config, path: '/other' },
    { ...config, url: 'https://service.example' },
    { ...config, url: 'wss://user:pass@service.example/ws' },
    { ...config, url: 'wss://service.example/ws?x=1' },
    { ...config, url: 'wss://service.example/ws#x' },
    { ...config, token: 'short' },
    { ...config, fingerprint: 'wrong' },
  ])
    await assert.rejects(f.client.check(input));
  assert.equal(f.calls.length, 0);
});

test('a lost install response cannot accept an earlier failed or rolled-back result', async () => {
  const f = await fixture();
  const found = await f.client.check(config);
  f.set(() => {
    throw new Error('connection lost');
  });
  await assert.rejects(
    f.client.install({ ...config, confirmed: true, build: 2, sha256: found.candidate.sha256 }),
    /网络请求失败/,
  );
  for (const phase of ['failed', 'rolled-back']) {
    for (const target of [null, found.candidate]) {
      f.set({ schema: 1, phase, current, target });
      await assert.rejects(f.client.status(config), /网络请求失败/);
      assert.equal(f.client.busy(), true);
    }
  }
  f.set({ schema: 1, phase: 'staging', current, target: found.candidate });
  assert.equal((await f.client.status(config)).phase, 'staging');
  f.set({ schema: 1, phase: 'rolled-back', current, target: null });
  assert.equal((await f.client.status(config)).phase, 'rolled-back');
  assert.equal(f.client.busy(), false);
});
test('tampering, expired indexes, replay, incompatible and changed credentials cannot authorize installation', async () => {
  const f = await fixture();
  const signed = check();
  f.set({ ...signed, candidate: { ...signed.candidate, appVersion: '9.9.9' } });
  await assert.rejects(f.client.check(config), /签名|目标/);
  f.set(check({ expiresAt: Date.now() - 1 }));
  await assert.rejects(f.client.check(config), /expired/);
  f.set(check({ build: 3 }));
  const found = await f.client.check(config);
  f.set(check({ build: 2 }));
  await assert.rejects(f.client.check(config), /replay/);
  f.set(check({ build: 4, protocol: PROTOCOL_VERSION + 1 }));
  await assert.rejects(f.client.check(config), /协议/);
  f.set(check({ build: 5 }));
  const fresh = await f.client.check(config);
  await assert.rejects(
    f.client.install({
      ...config,
      token: config.token + 'changed',
      confirmed: true,
      build: fresh.candidate.build,
      sha256: fresh.candidate.sha256,
    }),
    /确认/,
  );
  assert.equal(found.candidate.build, 3);
});
test('install re-verifies expiry and client idle/frozen gates, and cancellation erases confirmation', async () => {
  let now = Date.now(),
    blocked = false;
  const f = await fixture({ now: () => now, isBlocked: () => blocked });
  const found = await f.client.check(config);
  const input = {
    ...config,
    confirmed: true,
    build: found.candidate.build,
    sha256: found.candidate.sha256,
  };
  now += 120000;
  await assert.rejects(f.client.install(input), /expired/);
  now = Date.now();
  await f.client.check(config);
  blocked = true;
  await assert.rejects(f.client.install(input), /空闲/);
  blocked = false;
  await f.client.cancel();
  await assert.rejects(f.client.install(input), /确认/);
});
test('disabled, busy and manual-image-upgrade checks have no install confirmation', async () => {
  const f = await fixture();
  for (const reason of [
    'disabled',
    'busy',
    'manual-image-upgrade',
    'protocol-unavailable',
    'current',
  ]) {
    f.set({ schema: 1, current, candidate: null, index: null, compatible: false, reason });
    assert.equal((await f.client.check(config)).reason, reason);
    await assert.rejects(
      f.client.install({ ...config, confirmed: true, build: 2, sha256: 'b'.repeat(64) }),
      /确认/,
    );
  }
});

test('release metadata changes between checks invalidate the previously displayed confirmation', async () => {
  const f = await fixture();
  const original = await f.client.check(config);
  f.set(check({ build: 3 }));
  await f.client.check(config);
  await assert.rejects(
    f.client.install({
      ...config,
      confirmed: true,
      build: original.candidate.build,
      sha256: original.candidate.sha256,
    }),
    /确认/,
  );
});

test('persisted replay floor is restored by another client instance', async () => {
  let saved;
  const f = await fixture({
    writeReplay: (value) => {
      saved = value;
    },
  });
  f.set(check({ build: 5 }));
  await f.client.check(config);
  const restarted = await fixture({ readReplay: () => saved });
  await assert.rejects(restarted.client.check(config), /replay/);
});

test('cancelled check cannot recreate confirmation or persist results after form changes', async () => {
  let resolve;
  const f = await fixture({
    request: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = f.client.check(config);
  f.client.cancel();
  resolve(check());
  await assert.rejects(pending, /取消/);
  await assert.rejects(
    f.client.install({ ...config, confirmed: true, build: 2, sha256: 'b'.repeat(64) }),
    /确认/,
  );
});

test('409 and 404 responses cannot authorize installation and never reflect peer-controlled errors or secrets', async () => {
  for (const status of [404, 409]) {
    const f = await fixture({
      request: async () => {
        throw Object.assign(new Error(config.token), { status });
      },
    });
    await assert.rejects(
      f.client.check(config),
      (error) =>
        !error.message.includes(config.token) &&
        (status === 404 ? /首次|引导|启用/.test(error.message) : /繁忙/.test(error.message)),
    );
    await assert.rejects(
      f.client.install({ ...config, confirmed: true, build: 2, sha256: 'b'.repeat(64) }),
      /确认/,
    );
  }
});

test('dedicated IPC rejects arbitrary argument lists and fixes the manager URL', async () => {
  const { registerManagedServerUpdates } = createRequire(import.meta.url)(
    '../electron/managed-server-ipc.cjs',
  );
  const handlers = new Map(),
    calls = [];
  registerManagedServerUpdates(
    (name, fn) => handlers.set(name, fn),
    async () => ({
      check: (input) => {
        calls.push(input);
      },
    }),
    (url) => {
      calls.push(url);
    },
  );
  assert.deepEqual(
    [...handlers.keys()],
    [
      'managed-server:check',
      'managed-server:install',
      'managed-server:status',
      'managed-server:cancel',
      'managed-server:manager',
    ],
  );
  await assert.rejects(handlers.get('managed-server:check')({}, config, '/steal'));
  assert.throws(() => handlers.get('managed-server:manager')({}, 'https://attacker.invalid'));
  await handlers.get('managed-server:check')({}, config);
  handlers.get('managed-server:manager')({});
  assert.deepEqual(calls, [config, 'https://api.ghostapi.org/cc-updates/admin/updates']);
});
