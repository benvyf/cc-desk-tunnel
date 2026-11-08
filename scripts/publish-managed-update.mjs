import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactPath, verifyIndex } from '../packages/managed-updates/src/index.ts';

// Run over SSH on the publication VPS. Credentials stay outside the source checkout.
const usage =
  'node scripts/publish-managed-update.mjs --input TEMPLATE --out NEW_INDEX [--source CLEAN_CHECKOUT --artifact SETUP_EXE] [--admin-root /root/.cc-update-admin]';
let stage = 'arguments';
let candidateId;
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(usage);
    return;
  }
  const args = {};
  const allowed = new Set(['input', 'out', 'source', 'artifact', 'admin-root']);
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i].slice(2);
    assert(process.argv[i].startsWith('--') && allowed.has(name) && !Object.hasOwn(args, name));
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'));
    args[name] = process.argv[i + 1];
  }
  assert(args.input && args.out);
  const adminRoot = resolve(args['admin-root'] || '/root/.cc-update-admin');
  const output = resolve(args.out);
  const identity = JSON.parse(await readFile(join(adminRoot, 'identity-public.json')));
  const [keyId] = Object.keys(identity.trustedKeys);
  assert(Object.keys(identity.trustedKeys).length === 1);
  const keyPath = join(adminRoot, 'signing', `${keyId}.pem`);
  assert.equal(
    createPublicKey(await readFile(keyPath)).export({ type: 'spki', format: 'pem' }),
    identity.trustedKeys[keyId],
  );
  const token = (await readFile(join(adminRoot, 'access/admin-token.txt'), 'utf8')).trim();
  const api = '/cc-updates/admin/api';
  async function request(path, options = {}, authenticated = true) {
    const response = await fetch(new URL(path, identity.origin), {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(options.method === 'PUT' ? 600000 : 60000),
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${token}`, Origin: identity.origin } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }
  stage = 'prepare';
  const payload = JSON.parse(await readFile(args.input));
  assert(['pilot', 'stable'].includes(payload.channel));
  const status = await (await request(`${api}/status`)).json();
  const otherChannel = payload.channel === 'pilot' ? 'stable' : 'pilot';
  const channelPath = (channel) => `/cc-updates/v1/channels/${channel}/win32-x64.json`;
  const otherBefore = Buffer.from(
    await (await request(channelPath(otherChannel), {}, false)).arrayBuffer(),
  );
  const revisions = [...status.channels, ...status.candidates]
    .filter((c) => c.payload.channel === payload.channel)
    .map((c) => c.payload.revision);
  payload.revision = Math.max(0, ...revisions) + 1;
  payload.issuedAt = new Date().toISOString();
  payload.expiresAt = new Date(Date.now() + 3 * 86400000).toISOString();
  const input = join(dirname(output), `${payload.channel}-revision-${payload.revision}.input.json`);
  if (payload.state === 'published') {
    assert(args.source && args.artifact);
    const embedded = JSON.parse(await readFile(join(args.source, 'deploy/managed-client.json')));
    assert.equal(embedded.origin, identity.origin);
    assert.equal(embedded.build, payload.release.build);
    assert.deepEqual(embedded.trustedKeys, identity.trustedKeys);
  } else {
    assert.equal(payload.state, 'empty');
    assert(!args.source && !args.artifact);
  }
  await writeFile(input, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  stage = 'sign';
  const signArgs = [
    fileURLToPath(new URL('sign-managed-update.mjs', import.meta.url)),
    '--input',
    input,
    '--key-id',
    keyId,
    '--private-key',
    keyPath,
    '--out',
    output,
  ];
  if (args.source) signArgs.push('--source', args.source, '--artifact', args.artifact);
  execFileSync(process.execPath, signArgs, { stdio: 'pipe' });
  const signed = await readFile(output);
  const verified = verifyIndex(signed, identity.trustedKeys);
  const evidencePath = output + '.evidence.json';
  const evidence = {
    startedAt: payload.issuedAt,
    channel: payload.channel,
    revision: payload.revision,
    keyId,
    payload: verified.payload,
  };
  const saveEvidence = () =>
    writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  stage = 'create-candidate';
  const candidate = await (
    await request(`${api}/candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: signed,
    })
  ).json();
  assert.match(candidate.id, /^[a-f0-9-]{36}$/);
  candidateId = candidate.id;
  evidence.candidateId = candidateId;
  await saveEvidence();
  if (payload.state === 'published') {
    stage = 'upload';
    await request(`${api}/candidates/${candidateId}/artifact`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(verified.payload.release.size),
      },
      body: createReadStream(args.artifact),
      duplex: 'half',
    });
  }
  stage = 'activate';
  evidence.activation = await (
    await request(`${api}/candidates/${candidateId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  ).json();
  await saveEvidence();
  stage = 'verify-public';
  const publicIndex = Buffer.from(
    await (await request(channelPath(payload.channel), {}, false)).arrayBuffer(),
  );
  assert.deepEqual(publicIndex, signed);
  verifyIndex(publicIndex, identity.trustedKeys);
  const otherAfter = Buffer.from(
    await (await request(channelPath(otherChannel), {}, false)).arrayBuffer(),
  );
  assert.deepEqual(otherAfter, otherBefore);
  evidence.publicIndexMatches = true;
  evidence.otherChannelUnchanged = true;
  if (payload.state === 'published') {
    const release = verified.payload.release;
    const url = artifactPath(release);
    const head = await request(url, { method: 'HEAD' }, false);
    assert.equal(Number(head.headers.get('content-length')), release.size);
    const response = await request(url, {}, false);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.length;
    }
    assert.equal(size, release.size);
    assert.equal(hash.digest('hex'), release.sha256);
    evidence.publicArtifactVerified = true;
    evidence.artifactUrl = new URL(url, identity.origin).href;
  }
  evidence.completedAt = new Date().toISOString();
  await saveEvidence();
  console.log(JSON.stringify(evidence, null, 2));
}
try {
  await main();
} catch {
  // No raw exceptions: never log credentials, HTTP headers, or private file contents.
  console.error(
    `Publication stopped at ${stage}${candidateId ? ` (candidate ${candidateId})` : ''}. Inspect the protected release evidence on VPS; do not overwrite signed files.`,
  );
  process.exitCode = 1;
}
