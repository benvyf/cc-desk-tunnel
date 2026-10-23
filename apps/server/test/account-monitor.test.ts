import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { AccountMonitor } from '../src/account-monitor.ts';
import { environmentConfig, clearServiceVariables } from '../src/config.ts';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';

const token = 'test_node_token_12345678901234567890';
function metrics(measuredAt = new Date().toISOString(), utilization = 20): NativeMetrics {
  return {
    type: 'native.metrics',
    context: null,
    usage: null,
    rateLimits: {
      available: true,
      measuredAt,
      windows: [
        { name: 'five_hour', utilization, resetsAt: new Date(Date.now() + 3600000).toISOString() },
      ],
    },
  };
}
async function fixture(t: TestContext, status = 204, timeout = false) {
  const reports: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    reports.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (!timeout) {
      res.writeHead(status);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const monitor = new AccountMonitor(
    { url: `http://127.0.0.1:${addr.port}/report`, nodeId: 'node-1', token },
    { intervalMs: 20, retryMs: 30, timeoutMs: 60 },
  );
  t.after(async () => {
    monitor.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  async function wait(count: number) {
    const end = Date.now() + 2000;
    while (reports.length < count && Date.now() < end) await delay(5);
    assert.ok(reports.length >= count, `expected ${count} reports, got ${reports.length}`);
  }
  function identify(sessionId = 'session-1', sourceId = sessionId) {
    monitor.observe(
      {
        type: 'native.capabilities',
        account: { email: identity.email, subscriptionType: 'max' },
        models: [],
        commands: [],
      },
      sessionId,
      sourceId,
    );
  }
  return { monitor, reports, wait, identify };
}
const identity = {
  type: 'account.state',
  loggedIn: true,
  email: 'Owner@example.invalid',
  subscriptionType: 'max',
  login: null,
} as const;

test('monitor mirrors authorized identity, removes content/secrets and ignores context-only repeats', async (t) => {
  const f = await fixture(t);
  await delay(30);
  assert.equal(f.reports.length, 0);
  f.monitor.observe(metrics(), 'session-1');
  await delay(30);
  assert.equal(f.reports.length, 0, 'unidentified quota must not be attributed');
  f.monitor.observe({
    ...identity,
    secret: 'do-not-copy',
    login: { url: 'secret-login-url' },
  } as never);
  await f.wait(1);
  f.identify();
  const event = metrics();
  f.monitor.observe(event as never, 'session-1');
  await f.wait(2);
  for (let i = 0; i < 10; i++)
    f.monitor.observe({ ...event, context: { percentage: i } } as never, 'session-1');
  await delay(70);
  assert.equal(f.reports.length, 2);
  const report = f.reports[1];
  assert.match(report.account.id, /^[a-f0-9]{64}$/);
  assert.equal(report.rateLimits.windows[0].utilization, 20);
  assert.equal(report.account.email, identity.email);
  assert.equal(/secret|context|login/.test(JSON.stringify(report)), false);
});

test('existing identity metadata and safe quota failures are distinguishable without new readings', async (t) => {
  const f = await fixture(t);
  f.monitor.observe({ ...identity, organization: '我的工作组', authMethod: 'oauth_token' });
  await f.wait(1);
  f.identify();
  f.monitor.observe(metrics(), 'session-1');
  await f.wait(2);
  assert.equal(f.reports[1].schema, 2);
  assert.equal(f.reports[1].account.organization, '我的工作组');
  assert.equal(f.reports[1].account.authMethod, 'oauth_token');
  assert.equal(f.reports[1].identity.state, 'identified');
  const withUsage = metrics(new Date().toISOString());
  withUsage.usage = {
    measuredAt: new Date().toISOString(),
    costUsd: 0.2,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  };
  f.monitor.observe(withUsage, 'session-1');
  await f.wait(3);
  assert.equal(f.reports[2].usage.runId, 'session-1');
  f.monitor.observe(
    {
      type: 'native.metrics',
      context: null,
      usage: null,
      rateLimits: null,
      errors: { usage: 'arbitrary private error' },
    },
    'session-1',
  );
  await f.wait(4);
  assert.equal(f.reports[3].quotaStatus.state, 'error');
  assert.equal(f.reports[3].rateLimits.windows[0].utilization, 20);
  assert.equal(JSON.stringify(f.reports[3]).includes('arbitrary private error'), false);
  f.monitor.observe({ type: 'account.state', loggedIn: false, login: null });
  await f.wait(5);
  assert.equal(f.reports[4].identity.state, 'signed_out');
  f.monitor.beginSource('unknown-run');
  f.monitor.observe(
    { type: 'native.capabilities', account: {}, models: [], commands: [] },
    'session-2',
    'unknown-run',
  );
  await f.wait(6);
  assert.equal(f.reports[5].identity.state, 'unknown');
});

test('changing organization invalidates readings from the previous process context', async (t) => {
  const f = await fixture(t);
  f.monitor.observe({ ...identity, organization: 'Old org' });
  f.identify();
  f.monitor.observe(metrics(), 'session-1');
  await f.wait(1);
  f.monitor.beginSource('pending-old-org');
  f.monitor.observe({ ...identity, organization: 'New org' });
  await f.wait(2);
  assert.equal(f.reports[1].rateLimits, null);
  f.monitor.observe(metrics(), 'session-1');
  f.monitor.observe(
    {
      type: 'native.capabilities',
      account: { email: identity.email, organization: 'Old org' },
      models: [],
      commands: [],
    },
    'session-2',
    'pending-old-org',
  );
  await delay(60);
  assert.equal(f.reports.length, 2);
});

test('an old failed attempt replayed by context updates cannot hide a newer successful read', async (t) => {
  const f = await fixture(t);
  f.identify('session-a');
  f.identify('session-b');
  const at = Date.now() - 1000;
  const failure = {
    type: 'native.metrics',
    context: null,
    usage: null,
    rateLimits: null,
    quotaAttemptAt: new Date(at).toISOString(),
    errors: { usage: 'read failed' },
  } as const;
  f.monitor.observe(failure, 'session-a');
  await f.wait(1);
  f.monitor.observe(metrics(new Date(at + 100).toISOString()), 'session-b');
  await f.wait(2);
  assert.equal(f.reports[1].quotaStatus.state, 'ok');
  f.monitor.observe(failure, 'session-a');
  await delay(60);
  assert.equal(f.reports.length, 2);
});

test('concurrent runs begun before first identity can bind the same complete account context', async (t) => {
  const f = await fixture(t);
  f.monitor.beginSource('run-a');
  f.monitor.beginSource('run-b');
  const capabilities = {
    type: 'native.capabilities',
    account: {
      email: identity.email,
      subscriptionType: 'max',
      organization: 'Org A',
      apiProvider: 'firstParty',
    },
    models: [],
    commands: [],
  } as const;
  f.monitor.observe(capabilities as never, 'session-a', 'run-a');
  await f.wait(1);
  f.monitor.observe(capabilities as never, 'session-b', 'run-b');
  f.monitor.observe(metrics(new Date().toISOString(), 73), 'session-b', 'run-b');
  await f.wait(2);
  assert.equal(f.reports[1].rateLimits.windows[0].utilization, 73);
});

test('rapid account switching retains the latest pending observation for each account', async (t) => {
  const f = await fixture(t);
  f.monitor.observe(identity);
  f.monitor.observe({ ...identity, email: 'second@example.invalid' });
  f.monitor.observe({ ...identity, email: 'third@example.invalid' });
  await f.wait(3);
  assert.deepEqual(
    f.reports.map((r) => r.account.email),
    [identity.email, 'second@example.invalid', 'third@example.invalid'],
  );
});

test('logout and account switches clear the previous account quota', async (t) => {
  const f = await fixture(t);
  f.monitor.observe(identity);
  await f.wait(1);
  f.identify();
  f.monitor.observe(metrics() as never, 'session-1');
  await f.wait(2);
  f.monitor.observe({ ...identity, email: 'other@example.invalid' });
  await f.wait(3);
  assert.notEqual(f.reports[2].account.id, f.reports[1].account.id);
  assert.equal(f.reports[2].rateLimits, null);
  f.monitor.observe({ type: 'account.state', loggedIn: false, login: null });
  await f.wait(4);
  assert.equal(f.reports[3].account, null);
  assert.equal(f.reports[3].rateLimits, null);
});

test('VPS failures retry the newest snapshot without waiting or calling Claude', async (t) => {
  const f = await fixture(t, 503);
  f.monitor.observe(identity);
  await f.wait(1);
  f.identify();
  const now = Date.now();
  for (let i = 0; i < 15; i++)
    f.monitor.observe(metrics(new Date(now + i).toISOString(), i) as never, 'session-1');
  await f.wait(2);
  assert.equal(f.reports[1].rateLimits.windows[0].utilization, 14);
  f.monitor.close();
  const count = f.reports.length;
  await delay(100);
  assert.equal(f.reports.length, count);
});

test('a hung VPS request times out and close cancels background work', async (t) => {
  const f = await fixture(t, 204, true);
  f.monitor.observe(identity);
  await f.wait(2);
  f.monitor.close();
  const count = f.reports.length;
  await delay(100);
  assert.equal(f.reports.length, count);
});

test('monitoring configuration is opt-in, HTTPS only and never inherited by Claude', () => {
  assert.equal(environmentConfig({}, '/state').options.accountMonitor, undefined);
  const env = {
    PROXY_MONITOR_URL: 'https://vps.example.invalid/cc-updates/admin/api/monitor/report',
    PROXY_MONITOR_NODE_ID: 'node-1',
    PROXY_MONITOR_TOKEN: token,
  };
  assert.equal(environmentConfig(env, '/state').options.accountMonitor?.nodeId, 'node-1');
  for (const url of [
    'http://vps.example.invalid/report',
    'https://user:pass@vps.example.invalid/report',
    'https://vps.example.invalid/report?token=secret',
  ])
    assert.throws(() => environmentConfig({ ...env, PROXY_MONITOR_URL: url }, '/state'));
  assert.throws(() => environmentConfig({ PROXY_MONITOR_URL: env.PROXY_MONITOR_URL }, '/state'));
  clearServiceVariables(env);
  assert.deepEqual(env, {});
});

test('incompatible future/invalid native data cannot poison subsequent valid observations', async (t) => {
  const f = await fixture(t);
  f.monitor.observe(identity);
  await f.wait(1);
  f.identify();
  f.monitor.observe(metrics(new Date(Date.now() + 3600000).toISOString(), -1), 'session-1');
  f.monitor.observe(metrics(), 'session-1');
  await f.wait(2);
  assert.equal(f.reports[1].rateLimits.windows[0].utilization, 20);
});

test('native quota reset times without milliseconds or with offsets are normalized before sync', async (t) => {
  const f = await fixture(t);
  f.monitor.observe(identity);
  await f.wait(1);
  f.identify();
  const event = metrics();
  event.rateLimits!.windows = [
    { name: 'five_hour', utilization: 10, resetsAt: '2026-10-24T02:00:00Z' },
    { name: 'seven_day', utilization: 20, resetsAt: '2026-10-31T10:00:00+08:00' },
  ];
  f.monitor.observe(event, 'session-1');
  await f.wait(2);
  assert.equal(f.reports[1].rateLimits.windows[0].resetsAt, '2026-10-24T02:00:00.000Z');
  assert.equal(f.reports[1].rateLimits.windows[1].resetsAt, '2026-10-31T02:00:00.000Z');
});

test('interleaved context refreshes cannot replace newer session usage', async (t) => {
  const f = await fixture(t);
  f.monitor.observe(identity);
  await f.wait(1);
  f.identify('session-a');
  f.identify('session-b');
  const now = Date.now() - 1000;
  const a = metrics(new Date(now).toISOString());
  a.usage = {
    measuredAt: new Date(now).toISOString(),
    costUsd: 0.1,
    inputTokens: 1,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const b = metrics(new Date(now + 1).toISOString());
  b.usage = { ...a.usage, measuredAt: new Date(now + 1).toISOString(), outputTokens: 20 };
  f.monitor.observe(a, 'session-a');
  await f.wait(2);
  f.monitor.observe(b, 'session-b');
  await f.wait(3);
  f.monitor.observe(a, 'session-a');
  await delay(60);
  assert.equal(f.reports.length, 3);
  assert.equal(f.reports[2].usage.sessionId, 'session-b');
});

test('old native process observations cannot cross an account switch or roll back its identity', async (t) => {
  const f = await fixture(t);
  const caps = (email: string) =>
    ({
      type: 'native.capabilities',
      account: { email, subscriptionType: 'max' },
      models: [],
      commands: [],
    }) as const;
  f.monitor.observe(caps(identity.email) as never, 'session-a', 'run-a');
  await f.wait(1);
  f.monitor.beginSource('pending-old-run');
  const old = metrics();
  f.monitor.observe(old, 'session-a', 'run-a');
  await f.wait(2);
  f.monitor.observe({ ...identity, email: 'other@example.invalid' });
  await f.wait(3);
  f.monitor.observe(metrics(new Date().toISOString(), 99), 'session-a', 'run-a');
  f.monitor.observe(caps(identity.email) as never, 'session-a', 'run-a');
  f.monitor.observe(caps(identity.email) as never, 'pending-session', 'pending-old-run');
  await delay(60);
  assert.equal(f.reports.length, 3);
  assert.equal(f.reports[2].rateLimits, null);
  f.monitor.observe(caps('other@example.invalid') as never, 'session-a', 'new-run');
  f.monitor.observe(metrics(), 'session-a', 'new-run');
  await f.wait(4);
  assert.equal(f.reports[3].rateLimits.windows[0].utilization, 20);
});

test('a fresh unknown identity clears the previous account instead of keeping its quota', async (t) => {
  const f = await fixture(t);
  f.identify();
  await f.wait(1);
  f.monitor.observe(metrics(), 'session-1');
  await f.wait(2);
  f.monitor.forgetSource('session-1');
  f.monitor.beginSource('new-unknown-run');
  f.monitor.observe(
    { type: 'native.capabilities', account: {}, models: [], commands: [] },
    'session-2',
    'new-unknown-run',
  );
  await f.wait(3);
  assert.equal(f.reports[2].account, null);
  assert.equal(f.reports[2].rateLimits, null);
  f.monitor.observe(metrics(), 'session-2', 'new-unknown-run');
  await delay(60);
  assert.equal(f.reports.length, 3);
});
