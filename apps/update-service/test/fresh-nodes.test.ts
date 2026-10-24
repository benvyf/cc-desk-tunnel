import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  COMPATIBILITY_PATHS,
  RUNTIME_LEVEL,
  signServerIndex,
} from '../../../packages/managed-server/src/index.ts';
import { FreshNodes } from '../src/fresh-nodes.ts';
import { createUpdateServer } from '../src/http.ts';
import { authenticateNode } from '../src/moderation-nodes.ts';
import { UpdateStore } from '../src/store.ts';

test('fresh deployment grants are private, single-use, node-bound; dynamic reports and review auth survive restart', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cc-fresh-'));
  const keys = generateKeyPairSync('ed25519');
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const admin = 'synthetic_fresh_admin_token_1234567890';
  const config = {
    origin: 'https://fixture.example.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: hash(admin),
    trustedKeys: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    monitorNodes: { existing: hash('synthetic_existing_token') },
  };
  mkdirSync(join(root, 'server'), { recursive: true });
  const index = signServerIndex(
    {
      schema: 1,
      product: 'cc-desk-tunnel-managed-server',
      channel: 'pilot',
      platform: 'linux',
      arch: 'x64',
      revision: 1,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      release: {
        build: 3,
        protocol: 20,
        appVersion: '0.3.6',
        sourceCommit: 'a'.repeat(40),
        size: 100,
        sha256: 'b'.repeat(64),
        descriptorSha256: 'c'.repeat(64),
        packageLockSha256: 'd'.repeat(64),
        runtimeLevel: RUNTIME_LEVEL,
        compatibility: Object.fromEntries(COMPATIBILITY_PATHS.map((p) => [p, 'e'.repeat(64)])),
      },
    },
    'fixture',
    keys.privateKey,
  );
  writeFileSync(join(root, 'server/index.json'), JSON.stringify(index));
  let store: UpdateStore;
  let server: Awaited<ReturnType<typeof createUpdateServer>>;
  let origin: string;
  async function open() {
    store = await UpdateStore.open(root, config.trustedKeys, 'fixture');
    server = await createUpdateServer(store, config);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
  }
  await open();
  t.after(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = (path: string, token = admin, value?: unknown, browser = true) =>
    fetch(origin + '/cc-updates/admin/api' + path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        ...(browser ? { origin: config.origin } : {}),
        ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  assert.equal((await request('/fresh-nodes', 'invalid', { nodeId: 'new-1' })).status, 401);
  assert.equal((await request('/fresh-nodes', admin, { nodeId: '../bad' })).status, 400);
  assert.equal((await request('/fresh-nodes', admin, { nodeId: 'existing' })).status, 409);
  const issue = async (nodeId: string) => {
    const response = await request('/fresh-nodes', admin, { nodeId });
    assert.equal(response.status, 201);
    const result = await response.json();
    const code = /"--code","([A-Za-z0-9_-]{43})"/.exec(result.command)?.[1];
    assert(code);
    assert(result.command.startsWith('sudo python3 -c '));
    return { ...result, code };
  };
  const obsolete = await issue('new-1');
  const fresh = await issue('new-1');
  assert.equal((await request('/fresh-nodes/redeem', obsolete.code, {}, false)).status, 401);
  assert.equal((await request('/fresh-nodes/redeem', fresh.code, {}, true)).status, 403);
  const redeemed = await request('/fresh-nodes/redeem', fresh.code, {}, false);
  assert.equal(redeemed.status, 200);
  const bundle = await redeemed.json();
  assert.equal(bundle.nodeId, 'new-1');
  assert.notEqual(bundle.monitorToken, bundle.moderationToken);
  assert.equal(bundle.index, JSON.stringify(index));
  const privateState = readFileSync(join(root, 'private/fresh-nodes.json'), 'utf8');
  for (const value of [fresh.code, bundle.monitorToken, bundle.moderationToken])
    assert(!privateState.includes(value));
  assert.equal((await request('/fresh-nodes/redeem', fresh.code, {}, false)).status, 401);
  assert.equal((await request('/fresh-nodes', admin, { nodeId: 'new-1' })).status, 409);
  assert.equal(await authenticateNode(root, 'Bearer ' + bundle.moderationToken), 'new-1');
  await assert.rejects(authenticateNode(root, 'Bearer ' + bundle.monitorToken));
  const report = {
    schema: 1,
    nodeId: 'new-1',
    observedAt: new Date().toISOString(),
    account: null,
    rateLimits: null,
    usage: null,
  };
  assert.equal(
    (await request('/monitor/report', bundle.moderationToken, report, false)).status,
    401,
  );
  assert.equal(
    (
      await request(
        '/monitor/report',
        bundle.monitorToken,
        { ...report, nodeId: 'existing' },
        false,
      )
    ).status,
    401,
  );
  assert.equal((await request('/monitor/report', bundle.monitorToken, report, false)).status, 204);
  const expired = await issue('new-2');
  const path = join(root, 'private/fresh-nodes.json');
  const records = JSON.parse(readFileSync(path, 'utf8'));
  records['new-2'].expiresAt = Date.now() - 1;
  writeFileSync(path, JSON.stringify(records));
  assert.equal((await request('/fresh-nodes/redeem', expired.code, {}, false)).status, 401);
  await close();
  await open();
  const status = await (await request('/monitor')).json();
  assert(status.configuredNodes.includes('existing'));
  assert(status.configuredNodes.includes('new-1'));
  assert.equal(
    status.nodes.find((node: { nodeId: string }) => node.nodeId === 'new-1').observedAt,
    report.observedAt,
  );
  assert.equal(new FreshNodes(config).monitorNodes()['new-1'], hash(bundle.monitorToken));
  assert.equal(await authenticateNode(root, 'Bearer ' + bundle.moderationToken), 'new-1');
});
