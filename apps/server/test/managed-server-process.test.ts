import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { forkProgram } from '../src/managed-server-process.ts';

test('real child must prove readiness through IPC and authenticated local HTTP, and stop exits its process', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-child-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/server/src'), { recursive: true });
  const allocation = createServer();
  await new Promise<void>((r) => allocation.listen(0, '127.0.0.1', r));
  const address = allocation.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((r) => allocation.close(() => r()));
  writeFileSync(
    join(root, 'apps/server/src/managed-main.ts'),
    `
    import {createServer} from 'node:http';
    const proof=JSON.parse(process.env.CC_TEST_PROOF);
    const s=createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+process.env.PROXY_TOKEN||req.headers['x-cc-launch-nonce']!==proof.nonce){res.writeHead(403).end();return}res.end(JSON.stringify({...proof,openedStore:true,effectivePolicy:true}))});
    s.listen(Number(process.env.CC_TEST_PORT),'127.0.0.1',()=>process.send({kind:'cc-managed-ready',proof:{...proof,openedStore:true,effectivePolicy:true}}));
    process.on('message',m=>{if(m.kind==='cc-managed-stop')s.close(()=>process.exit(0))});
    process.on('SIGTERM',()=>s.close(()=>process.exit(0)));
  `,
  );
  const expected = {
    nonce: 'n'.repeat(64),
    build: 1,
    protocol: 20,
    releaseHash: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
  };
  const child = await forkProgram(
    { root, current: { build: 1, protocol: 20, appVersion: '0.2.19', sha256: null }, expected },
    {
      env: {
        ...process.env,
        PROXY_TOKEN: 'offline-process-token-long-123',
        CC_TEST_PROOF: JSON.stringify(expected),
        CC_TEST_PORT: String(port),
      },
      cwd: root,
      port,
      tls: false,
    },
    {
      check: async () => {
        throw new Error('unused');
      },
      status: async () => {
        throw new Error('unused');
      },
      prepare: async () => {},
      activate: () => {},
    },
  );
  assert.equal((await child.ready).nonce, expected.nonce);
  child.commit();
  await child.stop();
  await child.exited;
});
test('immutable loader resolves candidate protocol while retaining image dependencies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'managed-loader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/protocol/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(root, 'packages/protocol/src/index.ts'),
    'export const candidateProtocol = 987;',
  );
  writeFileSync(
    join(root, 'probe.mjs'),
    "import {candidateProtocol} from '@cc-desk-tunnel/protocol'; import {z} from 'zod'; console.log(z.number().parse(candidateProtocol));",
  );
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      new URL('../src/managed-server-loader.mjs', import.meta.url).href,
      join(root, 'probe.mjs'),
    ],
    { env: { ...process.env, CC_MANAGED_PROGRAM_ROOT: root }, encoding: 'utf8' },
  );
  assert.equal(result.trim(), '987');
});
