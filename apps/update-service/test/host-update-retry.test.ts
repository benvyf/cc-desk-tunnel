import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostUpdates } from '../src/host-updates.ts';
import type {
  ServerRelease,
  SignedServerIndex,
} from '../../../packages/managed-server/src/index.ts';

test('only a settled failed preparation with a serving committed child can be retried from center', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'host-retry-contract-'));
  mkdirSync(join(root, 'private'));
  const center = new HostUpdates(root, () => ['ubuntu-cc']);
  t.after(() => {
    center.close();
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now(),
    nodeId = 'ubuntu-cc';
  const grant = center.issue(nodeId, now);
  const { token } = center.enroll({ nodeId, code: grant.code }, now);
  const release = { build: 11, protocol: 23, sha256: 'a'.repeat(64) } as ServerRelease;
  const confirmed = { confirmed: true, build: release.build, sha256: release.sha256 };
  const index = {} as SignedServerIndex;
  const agent = fileURLToPath(new URL('../web/host-updater-agent.py', import.meta.url));
  const script =
    "import importlib.util,json,sys;s=importlib.util.spec_from_file_location('agent',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.probe=lambda:json.loads(sys.argv[2]);print(json.dumps(m.current()))";
  for (const [retryable, serving, expected] of [
    [true, true, 'idle'],
    [false, true, 'failed'],
    [true, false, 'failed'],
    [null, true, 'failed'],
  ] as const) {
    center.poll(token, { nodeId, current: { build: 10, protocol: 23, phase: 'committed' } }, now);
    const first = center.enqueue(nodeId, confirmed, release, index, now).job!;
    const status = { current: { build: 10, protocol: 23 }, phase: 'failed', retryable, serving };
    const current = JSON.parse(
      execFileSync(
        process.platform === 'win32' ? 'python' : 'python3',
        ['-c', script, agent, JSON.stringify(status)],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
    assert.equal(current.phase, expected);
    center.poll(
      token,
      {
        nodeId,
        current,
        report: {
          id: first.id,
          state: 'failed',
          progress: 'Preparation stopped; old service retained.',
        },
      },
      now + 1,
    );
    if (expected === 'idle') {
      const next = center.enqueue(nodeId, confirmed, release, index, now + 1).job!;
      assert.notEqual(next.id, first.id);
      center.poll(
        token,
        { nodeId, current, report: { id: next.id, state: 'failed', progress: 'fixture reset' } },
        now + 2,
      );
    } else
      assert.throws(() => center.enqueue(nodeId, confirmed, release, index, now + 1), /当前状态/);
  }
});
