import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUpdateServer } from '../src/http.ts';
import { UpdateStore } from '../src/store.ts';
import { EnrollmentStore } from '../src/enrollment.ts';

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
test('private enrollment is node-bound, expiring, restart-safe and consumed exactly once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'enrollment-'));
  const dir = join(root, 'private/enrollment');
  await mkdir(dir, { recursive: true });
  const payload = Buffer.from('synthetic private bundle');
  const nodeToken = 'fixture_node_123456789012345678901234567890';
  await writeFile(join(dir, 'ubuntu-cc.tar.gz'), payload);
  await writeFile(
    join(dir, 'packages.json'),
    JSON.stringify({
      'ubuntu-cc': {
        sha256: hash(payload),
        tokenSha256: hash(nodeToken),
        version: '0.3.6',
      },
    }),
  );
  const keys = generateKeyPairSync('ed25519');
  const admin = 'fixture_admin_12345678901234567890123456789';
  const config = {
    origin: 'https://fixture.example.invalid',
    dataDir: root,
    port: 8817,
    adminName: 'fixture',
    adminTokenSha256: hash(admin),
    trustedKeys: { fixture: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    monitorNodes: { 'ubuntu-cc': hash(nodeToken), other: hash(nodeToken) },
  };
  const store = await UpdateStore.open(root, config.trustedKeys, config.adminName);
  const server = await createUpdateServer(store, config);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/cc-updates/admin`;
  const req = (
    path: string,
    token = admin,
    data?: unknown,
    origin: string | null = config.origin,
  ) =>
    fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin ? { origin } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  assert.equal((await req('/api/monitor/enrollment', nodeToken)).status, 401);
  assert.equal(
    (await req('/api/monitor/enrollment', admin, { nodeId: 'ubuntu-cc' }, 'https://evil.invalid'))
      .status,
    403,
  );
  assert.equal((await req('/api/monitor/enrollment', admin, { nodeId: '../private' })).status, 400);
  assert.equal((await req('/api/monitor/enrollment', admin, { nodeId: 'other' })).status, 409);
  const available = await (await req('/api/monitor/enrollment')).json();
  assert.equal(
    available.nodes.find((n: { nodeId: string }) => n.nodeId === 'ubuntu-cc').ready,
    true,
  );
  assert.equal(available.nodes.find((n: { nodeId: string }) => n.nodeId === 'other').ready, false);
  const issue = async () => {
    const response = await req('/api/monitor/enrollment', admin, { nodeId: 'ubuntu-cc' });
    assert.equal(response.status, 201);
    return response.json();
  };
  const first = await issue();
  assert.ok(!JSON.stringify(first).includes(nodeToken));
  assert.match(first.command, /^sudo python3 -c /);
  const code = first.code;
  const saved = await readFile(join(dir, 'grants.json'), 'utf8');
  assert.ok(!saved.includes(code));
  const restarted = new EnrollmentStore(config);
  assert.equal((await req('/api/monitor/enrollment/redeem', code, {}, config.origin)).status, 403);
  const next = await issue();
  await assert.rejects(() => restarted.redeem(code));
  const replies = await Promise.all(
    [1, 2].map(() => req('/api/monitor/enrollment/redeem', next.code, {}, null)),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
  const good = replies.find((r) => r.status === 200)!;
  assert.equal(hash(Buffer.from(await good.arrayBuffer())), hash(payload));
  const third = await issue();
  const grants = JSON.parse(await readFile(join(dir, 'grants.json'), 'utf8'));
  grants['ubuntu-cc'].expiresAt = 0;
  await writeFile(join(dir, 'grants.json'), JSON.stringify(grants));
  await assert.rejects(() => restarted.redeem(third.code));
  const fourth = await issue();
  await writeFile(join(dir, 'ubuntu-cc.tar.gz'), 'tampered');
  await assert.rejects(() => restarted.redeem(fourth.code));
  await writeFile(join(dir, 'ubuntu-cc.tar.gz'), payload);
  const fifth = await issue();
  for (let i = 0; i < 31; i++) await req('/api/monitor/enrollment/redeem', 'invalid', {}, null);
  assert.equal(
    (await req('/api/monitor/enrollment/redeem', fifth.code, {}, null)).status,
    200,
    'anonymous invalid attempts must not block a valid enrollment',
  );
  assert.equal((await fetch(base + '/monitor-install.py')).status, 200);
  assert.equal((await fetch(base + '/enrollment/ubuntu-cc.tar.gz')).status, 404);
});
