import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyIndex } from '../packages/managed-updates/src/index.ts';

// Only the signing administrator may inspect an expired index at its issue time.
// Clients must continue to verify validity using the current time.
export function verifyForRenewal(bytes, keys, now = Date.now()) {
  const envelope = JSON.parse(bytes);
  const issued = Date.parse(JSON.parse(Buffer.from(envelope.payload, 'base64')).issuedAt);
  assert(issued <= now + 5 * 60000, 'Index issue time is in the future');
  return verifyIndex(bytes, keys, Math.min(now, issued));
}

export function renewalDecision(payload, expectedRelease, now = Date.now(), force = false) {
  assert.equal(payload.channel, 'pilot');
  if (payload.state === 'empty') return 'withdrawn';
  assert.deepEqual(
    payload.release,
    expectedRelease,
    'Active release differs from renewal registration',
  );
  return force || Date.parse(payload.expiresAt) - now <= 2 * 86400000 ? 'renew' : 'not-due';
}

export async function renew(configFile, force = false) {
  const config = JSON.parse(await readFile(configFile));
  const root = config.adminRoot;
  const automation = join(root, 'automation');
  const identity = JSON.parse(await readFile(join(root, 'identity-public.json')));
  const token = (await readFile(join(root, 'access/admin-token.txt'), 'utf8')).trim();
  let stage = 'read-index';
  const record = async (result) => {
    await writeFile(join(automation, 'last-run.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(JSON.stringify(result));
    return result;
  };
  async function request(path, authenticated = false, method = 'GET') {
    const response = await fetch(new URL(path, identity.origin), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: authenticated ? { Authorization: `Bearer ${token}`, Origin: identity.origin } : {},
    });
    assert(response.ok, `HTTP ${response.status}`);
    return response;
  }
  const channel = (name) => `/cc-updates/v1/channels/${name}/win32-x64.json`;
  const bytes = async (name) => Buffer.from(await (await request(channel(name))).arrayBuffer());
  try {
    const before = verifyForRenewal(await bytes('pilot'), identity.trustedKeys).payload;
    const decision = renewalDecision(before, config.expectedRelease, Date.now(), force);
    if (decision !== 'renew')
      return await record({
        at: new Date().toISOString(),
        status: decision,
        revision: before.revision,
        expiresAt: before.expiresAt,
      });
    stage = 'check-candidates';
    const status = await (await request('/cc-updates/admin/api/status', true)).json();
    assert.equal(
      status.candidates.length,
      0,
      'Unfinished publication requires administrator review',
    );
    const stable = await bytes('stable');
    const runDirectory = join(automation, 'runs', new Date().toISOString().replaceAll(':', '-'));
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    const input = join(runDirectory, 'template.json');
    const output = join(runDirectory, 'pilot.json');
    const { size, sha256, ...release } = before.release;
    await writeFile(
      input,
      JSON.stringify({
        schema: before.schema,
        product: before.product,
        channel: before.channel,
        platform: before.platform,
        arch: before.arch,
        state: before.state,
        release,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    stage = 'publish';
    execFileSync(
      process.execPath,
      [
        join(config.source, 'scripts/publish-managed-update.mjs'),
        '--input',
        input,
        '--out',
        output,
        '--source',
        config.source,
        '--artifact',
        config.artifact,
        '--admin-root',
        root,
      ],
      { cwd: config.source, stdio: 'pipe', timeout: 12 * 60000, maxBuffer: 1024 * 1024 },
    );
    stage = 'verify-public';
    const evidence = JSON.parse(await readFile(output + '.evidence.json'));
    assert(
      evidence.publicIndexMatches &&
        evidence.publicArtifactVerified &&
        evidence.otherChannelUnchanged,
    );
    const signed = await readFile(output);
    assert.deepEqual(await bytes('pilot'), signed);
    const after = verifyIndex(signed, identity.trustedKeys).payload;
    assert.deepEqual(after.release, before.release);
    assert(
      after.revision > before.revision &&
        Date.parse(after.expiresAt) > Date.parse(before.expiresAt),
    );
    assert.deepEqual(await bytes('stable'), stable);
    stage = 'cleanup-candidate';
    assert.match(evidence.candidateId, /^[a-f0-9-]{36}$/);
    await request(`/cc-updates/admin/api/candidates/${evidence.candidateId}`, true, 'DELETE');
    assert.deepEqual(await bytes('pilot'), signed);
    assert.deepEqual(await bytes('stable'), stable);
    const finalStatus = await (await request('/cc-updates/admin/api/status', true)).json();
    assert.equal(finalStatus.candidates.length, 0);
    const result = {
      at: new Date().toISOString(),
      status: 'renewed',
      channel: 'pilot',
      build: after.release.build,
      previousRevision: before.revision,
      revision: after.revision,
      expiresAt: after.expiresAt,
      releaseUnchanged: true,
      stableUnchanged: true,
      candidates: 0,
      publicArtifactVerified: true,
      signedIndex: output,
      publicationEvidence: output + '.evidence.json',
    };
    await writeFile(join(runDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    stage = 'save-snapshot';
    const snapshot = JSON.parse(await readFile(join(root, 'CURRENT-RELEASE.json')));
    await writeFile(
      join(root, 'CURRENT-RELEASE.json'),
      JSON.stringify({ ...snapshot, ...result, automaticRenewalConfigured: true }, null, 2) + '\n',
      { mode: 0o600 },
    );
    return await record(result);
  } catch {
    await record({
      at: new Date().toISOString(),
      status: 'error',
      stage,
      message:
        'Inspect this service journal and protected automation/runs evidence; do not print credentials.',
    });
    throw new Error(`Automatic renewal failed at ${stage}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--config' ||
    !args[1] ||
    (args.length !== 2 && !(args.length === 3 && args[2] === '--force'))
  ) {
    console.error('Usage: node renew-managed-index.mjs --config CONFIG [--force]');
    process.exitCode = 1;
  } else {
    try {
      await renew(args[1], args[2] === '--force');
    } catch {
      console.error(
        'Automatic renewal failed. Inspect the service journal and protected evidence.',
      );
      process.exitCode = 1;
    }
  }
}
