import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { validateConfig } from '../src/config.ts';
import { createUpdateServer } from '../src/http.ts';
import { UpdateStore } from '../src/store.ts';
import { AccountMonitor } from '../../server/src/account-monitor.ts';

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
  const other = { ...report(), nodeId: 'node-2', account: nodes[0].account };
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
