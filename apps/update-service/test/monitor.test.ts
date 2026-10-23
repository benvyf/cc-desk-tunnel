import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { validateConfig } from '../src/config.ts';
import { createUpdateServer } from '../src/http.ts';
import { UpdateStore } from '../src/store.ts';
import { AccountMonitor } from '../../server/src/account-monitor.ts';
import { MonitorStore } from '../src/monitor.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const admin = 'test_admin_123456789012345678901234';
const nodeToken = 'test_node_1234567890123456789012345';
const api = '/cc-updates/admin/api/monitor';
export function report(at = Date.now(), utilization = 30) {
  return {
    schema: 1,
    nodeId: 'node-1',
    observedAt: new Date(at).toISOString(),
    account: { id: hash('account'), subscriptionType: 'max' },
    rateLimits: {
      available: true,
      measuredAt: new Date(at).toISOString(),
      windows: [{ name: 'five_hour', utilization, resetsAt: new Date(at + 3600000).toISOString() }],
    },
    usage: null,
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cc-monitor-http-'));
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const config = validateConfig({
    origin: 'https://vps.example.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'test',
    adminTokenSha256: hash(admin),
    trustedKeys: { test: key },
    monitorNodes: {
      'node-1': hash(nodeToken),
      'node-2': hash('other_node_1234567890123456789012345'),
    },
  });
  let store: UpdateStore, server: Awaited<ReturnType<typeof createUpdateServer>>, url: string;
  async function open() {
    store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
    server = await createUpdateServer(store, config);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    assert.ok(addr && typeof addr !== 'string');
    url = `http://127.0.0.1:${addr.port}`;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
  }
  await open();
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  const post = (value: unknown, token = nodeToken, extra: Record<string, string> = {}) =>
    fetch(url + api + '/report', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(value),
    });
  const get = (token = admin) =>
    fetch(url + api, { headers: { authorization: `Bearer ${token}` } });
  return {
    post,
    get,
    url: () => url,
    note: (id: string, note: unknown, token = admin) =>
      fetch(url + api + '/accounts/' + id + '/note', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          origin: config.origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ note }),
      }),
    restart: async () => {
      await close();
      await open();
    },
  };
}

test('node writes are scoped, admin reads are private and snapshots persist without querying Claude', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get('')).status, 401);
  assert.equal((await f.get(nodeToken)).status, 401);
  assert.equal((await f.post(report(), admin)).status, 401);
  assert.equal((await f.post({ ...report(), nodeId: 'node-2' })).status, 401);
  assert.equal(
    (await f.post(report(), nodeToken, { origin: 'https://vps.example.invalid' })).status,
    403,
  );
  assert.equal((await f.post(report())).status, 204);
  let data = await (await f.get()).json();
  assert.equal(data.nodes.length, 1);
  assert.equal(data.nodes[0].rateLimits.windows[0].utilization, 30);
  await f.restart();
  data = await (await f.get()).json();
  assert.equal(data.nodes[0].nodeId, 'node-1');
});

test('account registry preserves switches, node associations and administrator notes across restarts', async (t) => {
  const f = await fixture(t);
  const at = Date.now() - 10000;
  const a = report(at, 30);
  assert.equal((await f.post(a)).status, 204);
  assert.equal((await f.note(a.account.id, '主账号 <img src=x>')).status, 204);
  const b = {
    ...report(at + 1, 70),
    account: { id: hash('second-account'), subscriptionType: 'pro' },
  };
  assert.equal((await f.post(b)).status, 204);
  assert.equal(
    (
      await f.post(
        { ...report(at + 2, 40), nodeId: 'node-2' },
        'other_node_1234567890123456789012345',
      )
    ).status,
    204,
  );
  let data = await (await f.get()).json();
  assert.deepEqual(data.configuredNodes, ['node-1', 'node-2']);
  assert.equal(data.accounts.length, 2);
  const account = data.accounts.find((row: any) => row.id === a.account.id);
  assert.equal(account.note, '主账号 <img src=x>');
  assert.equal(account.snapshots.length, 2);
  assert.deepEqual(
    account.snapshots.map((s: any) => s.rateLimits.windows[0].utilization).sort(),
    [30, 40],
  );
  assert.equal(data.nodes[0].account.id, b.account.id);
  assert.equal((await f.note(a.account.id, 'forbidden', nodeToken)).status, 401);
  assert.equal((await f.note(a.account.id, 'x'.repeat(2001))).status, 400);
  assert.equal((await f.note(hash('missing'), '')).status, 404);
  await f.restart();
  data = await (await f.get()).json();
  assert.equal(data.accounts.find((row: any) => row.id === a.account.id).note, account.note);
  assert.equal(data.accounts.length, 2);
});

test('configured nodes are visible before their first report', async (t) => {
  const f = await fixture(t);
  const data = await (await f.get()).json();
  assert.deepEqual(data.configuredNodes, ['node-1', 'node-2']);
  assert.deepEqual(data.accounts, []);
  assert.deepEqual(data.nodes, []);
});

test('same-account identity-only reports retain the last sampled quota and its original age', async (t) => {
  const f = await fixture(t);
  const at = Date.now() - 10000;
  const a = report(at, 60);
  assert.equal((await f.post(a)).status, 204);
  assert.equal((await f.post({ ...report(at + 1), rateLimits: null })).status, 204);
  const data = await (await f.get()).json();
  assert.equal(data.nodes[0].rateLimits.windows[0].utilization, 60);
  assert.equal(data.nodes[0].rateLimits.measuredAt, a.rateLimits.measuredAt);
});

function detailedReport(at: number, email = 'owner@example.invalid', organization = 'Org A') {
  return {
    ...report(at),
    schema: 2,
    account: {
      id: hash(email.toLowerCase()),
      email,
      organization,
      subscriptionType: 'max',
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
    },
    identity: { state: 'identified', measuredAt: new Date(at).toISOString() },
    quotaStatus: { state: 'ok', measuredAt: new Date(at).toISOString() },
  };
}

test('legacy reports cannot corrupt richer identity metadata and organization changes clear old quota', async (t) => {
  const f = await fixture(t);
  const at = Date.now() - 10000;
  const a = detailedReport(at);
  assert.equal((await f.post(a)).status, 204);
  assert.equal(
    (await f.post({ ...report(at + 1), account: { id: a.account.id, subscriptionType: 'max' } }))
      .status,
    204,
  );
  let result = await f.get();
  assert.equal(result.status, 200);
  let data = await result.json();
  assert.equal(data.nodes[0].account.email, a.account.email);
  const changed = {
    ...detailedReport(at + 2, a.account.email, 'Org B'),
    rateLimits: null,
    quotaStatus: { state: 'unknown', measuredAt: null },
  };
  assert.equal((await f.post(changed)).status, 204);
  data = await (await f.get()).json();
  assert.equal(data.nodes[0].rateLimits, null);
  assert.equal(data.accounts.length, 1);
});

test('a schema 2 restart preserves known metadata and legacy quota without inventing usage provenance', async (t) => {
  const f = await fixture(t);
  const at = Date.now() - 10000;
  const a = detailedReport(at);
  const usage = {
    sessionId: 'legacy-session',
    measuredAt: new Date(at).toISOString(),
    costUsd: 0.1,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
  };
  assert.equal(
    (await f.post({ ...report(at), account: { id: a.account.id, subscriptionType: 'max' }, usage }))
      .status,
    204,
  );
  assert.equal(
    (
      await f.post({
        ...a,
        observedAt: new Date(at + 1).toISOString(),
        rateLimits: null,
        quotaStatus: { state: 'unknown', measuredAt: null },
      })
    ).status,
    204,
  );
  const restart = {
    ...detailedReport(at + 2),
    rateLimits: null,
    quotaStatus: { state: 'unknown', measuredAt: null },
    account: {
      ...a.account,
      subscriptionType: null,
      organization: null,
      apiProvider: null,
      authMethod: null,
    },
  };
  assert.equal((await f.post(restart)).status, 204);
  const data = await (await f.get()).json();
  assert.equal(data.nodes[0].account.organization, 'Org A');
  assert.equal(data.nodes[0].account.subscriptionType, 'max');
  assert.equal(data.nodes[0].account.authMethod, 'oauth_token');
  assert.equal(data.nodes[0].account.apiProvider, 'firstParty');
  assert.equal(data.nodes[0].usage, null);
  assert.equal(data.nodes[0].rateLimits.measuredAt, new Date(at).toISOString());
});

test('schema 2 rejects mismatched identity hashes, unknown metadata and inconsistent state', async (t) => {
  const f = await fixture(t);
  const a = detailedReport(Date.now());
  const invalid = [
    { ...a, account: { ...a.account, id: hash('wrong') } },
    { ...a, account: { ...a.account, tokenSource: 'not-allowed' } },
    { ...a, account: { ...a.account, email: 'invalid email' } },
    { ...a, identity: { ...a.identity, state: 'signed_out' } },
  ];
  for (const item of invalid) assert.equal((await f.post(item)).status, 400);
});

test('legacy SQLite snapshots migrate idempotently and removing a node keeps its account archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-monitor-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'private'));
  const at = new Date(Date.now() - 60000).toISOString();
  const old = report(Date.parse(at));
  const db = new DatabaseSync(join(root, 'private/monitor.sqlite'));
  db.exec(
    'CREATE TABLE snapshots (node_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, report TEXT NOT NULL, received_at TEXT NOT NULL)',
  );
  const later = new Date(Date.parse(at) + 1000).toISOString();
  db.prepare('INSERT INTO snapshots VALUES (?,?,?,?)').run(
    'node-2',
    old.observedAt,
    JSON.stringify({ ...old, nodeId: 'node-2' }),
    later,
  );
  db.prepare('INSERT INTO snapshots VALUES (?,?,?,?)').run(
    old.nodeId,
    old.observedAt,
    JSON.stringify(old),
    at,
  );
  db.close();
  const first = new MonitorStore(root, ['node-1']);
  assert.equal(first.status().accounts[0]!.firstSeenAt, at);
  assert.equal(first.status().accounts[0]!.lastSeenAt, later);
  assert.equal(first.note(old.account.id, '保留备注'), true);
  first.close();
  const removed = new MonitorStore(root, []);
  const data = removed.status();
  assert.deepEqual(data.nodes, []);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0]!.snapshots.length, 2);
  assert.equal(data.accounts[0]!.note, '保留备注');
  removed.close();
});

test('producer observations reach the real receiver and multiple node quotas remain separate', async (t) => {
  const f = await fixture(t);
  const monitor = new AccountMonitor(
    { url: f.url() + api + '/report', nodeId: 'node-1', token: nodeToken },
    { intervalMs: 5, retryMs: 10, timeoutMs: 500 },
  );
  t.after(() => monitor.close());
  monitor.beginSource('run-1');
  monitor.observe(
    {
      type: 'native.capabilities',
      account: { email: 'owner@example.invalid', subscriptionType: 'max' },
      models: [],
      commands: [],
    },
    'session-1',
    'run-1',
  );
  monitor.observe(
    {
      type: 'native.metrics',
      context: null,
      rateLimits: {
        available: true,
        measuredAt: new Date().toISOString(),
        windows: [{ name: 'five_hour', utilization: 43, resetsAt: '2026-10-24T01:00:00Z' }],
      },
      usage: null,
    },
    'session-1',
    'run-1',
  );
  let nodes: any[] = [];
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    nodes = (await (await f.get()).json()).nodes;
    if (nodes[0]?.rateLimits?.windows[0]?.utilization === 43) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(nodes[0]?.rateLimits?.windows[0]?.utilization, 43);
  const other = {
    ...report(),
    nodeId: 'node-2',
    account: { id: nodes[0].account.id, subscriptionType: 'max' },
  };
  assert.equal((await f.post(other, 'other_node_1234567890123456789012345')).status, 204);
  nodes = (await (await f.get()).json()).nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].account.id, nodes[1].account.id);
  assert.deepEqual(
    nodes.map((n) => n.rateLimits.windows[0].utilization),
    [43, 30],
  );
});

test('receiver rejects extra fields, invalid numbers/times, large bodies and future timestamps', async (t) => {
  const f = await fixture(t);
  const r = report();
  const invalid = [
    { ...r, token: 'secret' },
    { ...r, account: { ...r.account, email: 'private@example.invalid' } },
    {
      ...r,
      rateLimits: { ...r.rateLimits, windows: [{ ...r.rateLimits.windows[0], utilization: -1 }] },
    },
    {
      ...r,
      rateLimits: { ...r.rateLimits, windows: [{ ...r.rateLimits.windows[0], utilization: '30' }] },
    },
    { ...r, observedAt: 'invalid' },
    report(Date.now() + 600000),
    { ...r, usage: { content: 'private' } },
    { ...r, account: null },
    { ...r, padding: 'x'.repeat(20000) },
  ];
  for (const value of invalid) assert.ok([400, 413].includes((await f.post(value)).status));
  assert.equal((await (await f.get()).json()).nodes.length, 0);
});

test('duplicate/old reports cannot replace the latest snapshot or make old data look fresh', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const r = report(now);
  assert.equal((await f.post(r)).status, 204);
  const first = await (await f.get()).json();
  assert.equal((await f.post(r)).status, 204);
  assert.equal((await f.post(report(now - 1000, 90))).status, 204);
  const after = await (await f.get()).json();
  assert.deepEqual(after.nodes, first.nodes);
  assert.equal(
    (
      await f.post({
        ...report(now + 1),
        rateLimits: { ...r.rateLimits, measuredAt: new Date(now - 1000).toISOString() },
      })
    ).status,
    400,
  );
  assert.equal((await f.post({ ...report(now + 2), account: null, rateLimits: null })).status, 204);
  assert.equal((await (await f.get()).json()).nodes[0].account, null);
});
