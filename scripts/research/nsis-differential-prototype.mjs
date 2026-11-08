// Isolated feasibility experiment only. Never import into the desktop runtime.
// Uses fixture TLS and ephemeral signing keys; does not execute an installer.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, open, copyFile, unlink, mkdtemp } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { defaultCertificate } from '../../apps/server/test/fixtures/web-certificates.ts';
import * as managed from '../../packages/managed-updates/src/index.ts';
const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const isolatedRequire = createRequire(join(projectRoot, '.local/updater-research/package.json'));
assert.equal(isolatedRequire('electron-updater/package.json').version, '6.8.10');
const { GenericDifferentialDownloader } = isolatedRequire(
  'electron-updater/out/differentialDownloader/GenericDifferentialDownloader',
);
const { computeOperations, OperationKind } = isolatedRequire(
  'electron-updater/out/differentialDownloader/downloadPlanBuilder',
);
const { HttpExecutor, CancellationToken, CancellationError } =
  isolatedRequire('builder-util-runtime');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const { createNetwork } = require('../../apps/desktop/electron/managed-network.cjs');
const args = process.argv.slice(2);
if (args.length !== 5)
  throw new Error(
    'Usage: node scripts/research/nsis-differential-prototype.mjs OLD_EXE OLD_RELEASE_JSON NEW_EXE NEW_RELEASE_JSON OUTPUT_PARENT',
  );
const [oldFile, baselineMetadata, target, releaseMetadata, outputParent] = args.map((p) =>
  resolve(p),
);
await mkdir(outputParent, { recursive: true });
const root = await mkdtemp(join(outputParent, 'run-'));
await mkdir(join(root, 'results'));
console.log(JSON.stringify({ outputDirectory: root }));
const targetMapFile = target + '.blockmap';
const oldMapFile = join(root, 'old-installer.blockmap');
const hash = async (file, algorithm = 'sha256', encoding = 'hex') => {
  const h = createHash(algorithm);
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest(encoding);
};
const baselineHash = await hash(oldFile);
const baselineInput = JSON.parse(await readFile(baselineMetadata, 'utf8'));
const baseline = baselineInput.release ?? baselineInput;
assert.equal(
  baselineHash,
  baseline.sha256,
  'The baseline installer must match its recorded identity',
);
await buildBlockMap(oldFile, 'gzip', oldMapFile);
const oldMapBytes = await readFile(oldMapFile),
  newMapBytes = await readFile(targetMapFile);
const oldMap = JSON.parse(gunzipSync(oldMapBytes, { maxOutputLength: 16 * 1024 * 1024 }));
const newMap = JSON.parse(gunzipSync(newMapBytes, { maxOutputLength: 16 * 1024 * 1024 }));
const input = JSON.parse(await readFile(releaseMetadata, 'utf8'));
const release = { ...(input.release ?? input), notes: 'Isolated mature updater feasibility test' };
assert.equal(await hash(target), release.sha256);
const sha512 = await hash(target, 'sha512', 'base64');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trustedKeys = { research: publicKey.export({ type: 'spki', format: 'pem' }) };
const signed = managed.signIndex(
  {
    schema: 1,
    product: managed.PRODUCT,
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    revision: 1,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    state: 'published',
    release,
  },
  'research',
  privateKey,
);
const selected = managed.selectUpdate(
  managed.verifyIndex(signed, trustedKeys),
  {
    product: managed.PRODUCT,
    channel: 'pilot',
    platform: 'win32',
    arch: 'x64',
    build: baseline.build,
    protocol: baseline.protocol,
  },
  null,
);
assert.equal(selected.status, 'available');
const descriptor = {
  domain: 'CCSPACE-NSIS-RESEARCH-V1',
  build: release.build,
  installerSha256: release.sha256,
  installerSha512: sha512,
  blockmapSha256: createHash('sha256').update(newMapBytes).digest('hex'),
  blockmapSize: newMapBytes.length,
};
const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
const signature = sign(null, descriptorBytes, privateKey);
assert.ok(verify(null, descriptorBytes, publicKey, signature));
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const plan = computeOperations(oldMap, newMap, logger);
const copyBytes = plan
  .filter((p) => p.kind === OperationKind.COPY)
  .reduce((s, p) => s + p.end - p.start, 0);
const plannedDownloadBytes = plan
  .filter((p) => p.kind === OperationKind.DOWNLOAD)
  .reduce((s, p) => s + p.end - p.start, 0);
console.log(
  JSON.stringify({
    phase: 'plan',
    fullSize: release.size,
    plannedDownloadBytes,
    copyBytes,
    operations: plan.length,
  }),
);
let mode = 'normal',
  tokenForStall;
let stats = {};
const reset = () => {
  stats = { rangeRequests: 0, rangeBytes: 0, mapBytes: 0, fullRequests: 0, fullBytes: 0 };
};
reset();
const server = createServer(defaultCertificate, (req, res) => {
  if (req.url.endsWith('.blockmap')) {
    stats.mapBytes += newMapBytes.length;
    res.writeHead(200, { 'content-length': newMapBytes.length });
    res.end(newMapBytes);
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
  if (match) {
    const start = Number(match[1]),
      end = Number(match[2]);
    assert.ok(start >= 0 && end >= start && end < release.size);
    stats.rangeRequests++;
    if (mode === 'range-ignored') {
      res.writeHead(200, { 'content-length': release.size });
      res.flushHeaders();
      return;
    }
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${release.size}`,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
    });
    if (mode === 'stall') {
      res.flushHeaders();
      setTimeout(() => tokenForStall.cancel(), 100);
      return;
    }
    stats.rangeBytes += end - start + 1;
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  stats.fullRequests++;
  stats.fullBytes += release.size;
  res.writeHead(200, { 'content-length': release.size });
  createReadStream(target).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `https://127.0.0.1:${server.address().port}`;
const artifactUrl = origin + managed.artifactPath(release);
class StrictExecutor extends HttpExecutor {
  constructor(token) {
    super();
    this.token = token;
    this.active = new Set();
    token.onCancel(() => {
      for (const r of this.active) this.abortRequest(r, new CancellationError());
    });
  }
  abortRequest(r, error) {
    r.strictReject?.(error);
    r.strictResponse?.destroy(error);
    r.destroy(error);
  }
  addErrorAndTimeoutHandlers(r, reject, timeout = 20000) {
    r.strictReject = reject;
    r.on('error', reject);
    r.setTimeout(Math.min(timeout, 20000), () =>
      this.abortRequest(r, new Error('request timeout')),
    );
  }
  createRequest(options, callback) {
    if (this.token.cancelled) throw new CancellationError();
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(Number(options.port), server.address().port);
    const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers.range);
    assert.ok(m);
    const start = Number(m[1]),
      end = Number(m[2]);
    const r = request(
      { ...options, ca: defaultCertificate.cert, servername: 'default.example.test' },
      (response) => {
        r.strictResponse = response;
        response.on('error', (error) => r.strictReject?.(error));
        const expected = `bytes ${start}-${end}/${release.size}`;
        if (
          response.statusCode !== 206 ||
          response.headers['content-range'] !== expected ||
          Number(response.headers['content-length']) !== end - start + 1 ||
          response.headers['content-encoding']
        ) {
          this.abortRequest(r, new Error('STRICT_RANGE_REJECTED'));
          return;
        }
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > end - start + 1) this.abortRequest(r, new Error('range overflow'));
        });
        callback(response);
      },
    );
    this.active.add(r);
    r.on('close', () => this.active.delete(r));
    return r;
  }
}
const nativeFetch = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const r = request(
      url,
      {
        headers: options.headers,
        signal: options.signal,
        ca: defaultCertificate.cert,
        servername: 'default.example.test',
      },
      (response) =>
        resolve(
          new Response(Readable.toWeb(response), {
            status: response.statusCode,
            headers: response.headers,
          }),
        ),
    );
    r.on('error', reject);
    r.end();
  });
const network = createNetwork(nativeFetch, origin);
const diff = async (name, token = new CancellationToken(), base = oldFile) => {
  const mapResponse = await nativeFetch(artifactUrl + '.blockmap');
  const bytes = Buffer.from(await mapResponse.arrayBuffer());
  assert.equal(bytes.length, descriptor.blockmapSize);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.blockmapSha256);
  const output = join(root, 'results', name + '.exe');
  const downloader = new GenericDifferentialDownloader(
    { size: release.size, sha512 },
    new StrictExecutor(token),
    {
      oldFile: base,
      newFile: output,
      newUrl: new URL(artifactUrl),
      logger,
      requestHeaders: {},
      isUseMultipleRangeRequest: false,
      cancellationToken: token,
      onProgress: () => {},
    },
  );
  await downloader.download(
    oldMap,
    JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 })),
  );
  assert.equal(await hash(output), release.sha256);
  return output;
};
const full = async (name) => {
  const output = join(root, 'results', name + '.exe');
  await unlink(output).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await network.download(artifactUrl, output, release, new AbortController().signal, () => {});
  assert.equal(await hash(output), release.sha256);
  return output;
};
const update = async (name, { base = oldFile, token = new CancellationToken() } = {}) => {
  if (token.cancelled) throw new CancellationError();
  const cacheValid = await hash(base).then(
    (actual) => actual === baselineHash,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (!cacheValid)
    return { method: 'full', reason: 'no-valid-baseline', file: await full(name + '-full') };
  try {
    return { method: 'differential', file: await diff(name, token, base) };
  } catch (error) {
    if (token.cancelled) throw error;
    return { method: 'full', reason: error.message, file: await full(name + '-full') };
  }
};
const checks = [];
try {
  reset();
  const started = performance.now();
  const normalUpdate = await update('normal');
  assert.equal(normalUpdate.method, 'differential');
  checks.push({
    name: 'real-NSIS-differential-reconstruction',
    passed: true,
    elapsedMs: Math.round(performance.now() - started),
    ...stats,
  });
  assert.equal(stats.fullRequests, 0);
  assert.equal(stats.rangeBytes, plannedDownloadBytes);
  console.log(JSON.stringify(checks.at(-1)));
  reset();
  const corrupt = join(root, 'corrupt-cache.exe');
  await copyFile(oldFile, corrupt);
  const f = await open(corrupt, 'r+');
  const byte = Buffer.alloc(1);
  await f.read(byte, 0, 1, 0);
  byte[0] ^= 1;
  await f.write(byte, 0, 1, 0);
  await f.close();
  assert.notEqual(await hash(corrupt), baselineHash);
  const badCache = await update('corrupt-cache-auto', { base: corrupt });
  assert.equal(badCache.method, 'full');
  assert.equal(badCache.reason, 'no-valid-baseline');
  checks.push({ name: 'corrupt-cached-installer-full-fallback', passed: true, ...stats });
  assert.equal(stats.rangeRequests, 0);
  reset();
  mode = 'range-ignored';
  const badRange = await update('bad-range-auto');
  assert.equal(badRange.method, 'full');
  assert.match(badRange.reason, /STRICT_RANGE_REJECTED/);
  mode = 'normal';
  checks.push({ name: 'ignored-Range-rejected-then-full-fallback', passed: true, ...stats });
  assert.equal(stats.fullRequests, 1);
  reset();
  mode = 'stall';
  tokenForStall = new CancellationToken();
  const cancellationStart = performance.now();
  await assert.rejects(update('cancelled-auto', { token: tokenForStall }), /cancel/i);
  const cancelMs = Math.round(performance.now() - cancellationStart);
  assert.ok(cancelMs < 3000);
  assert.equal(stats.fullRequests, 0);
  checks.push({
    name: 'stalled-range-cancellation-without-full-fallback',
    passed: true,
    elapsedMs: cancelMs,
    ...stats,
  });
  mode = 'normal';
  reset();
  const missing = await update('missing-cache-auto', { base: join(root, 'does-not-exist.exe') });
  assert.equal(missing.method, 'full');
  assert.equal(stats.rangeRequests, 0);
  checks.push({ name: 'missing-cache-automatic-full-fallback', passed: true, ...stats });
  const tampered = Buffer.from(descriptorBytes);
  tampered[0] ^= 1;
  assert.equal(verify(null, tampered, publicKey, signature), false);
  checks.push({ name: 'signed-descriptor-tamper-rejected', passed: true });
  assert.equal(await hash(oldFile), baselineHash);
  const normal = checks[0];
  const result = {
    date: '2026-11-08',
    prototypeOnly: true,
    electronUpdater: '6.8.10',
    builder: '26.15.3',
    oldInstallerSha256: baselineHash,
    oldBuild: baseline.build,
    oldSourceCommit: baseline.sourceCommit,
    targetInstallerSha256: release.sha256,
    targetBuild: release.build,
    fullInstallerBytes: release.size,
    plannedCopyBytes: copyBytes,
    plannedDownloadBytes,
    blockmapBytes: newMapBytes.length,
    totalDifferentialBodyBytes: normal.rangeBytes + normal.mapBytes,
    savedVsFullPercent: Number(
      ((1 - (normal.rangeBytes + normal.mapBytes) / release.size) * 100).toFixed(2),
    ),
    reconstructionMs: normal.elapsedMs,
    checks,
    existingBuildSelectionPreserved: true,
    cacheBaselineUnmodified: true,
    installedFilesTouched: false,
    NSISInstallerExecuted: false,
    productionChanged: false,
    usesPinnedInternalDownloaderAPI: true,
    strictRangeAndCancellationAdapterRequired: true,
    equalAppVersions: isolatedRequire('semver').eq(baseline.appVersion, release.appVersion),
    semverBuildMetadataIgnored: isolatedRequire('semver').eq(
      `${baseline.appVersion}+build.${baseline.build}`,
      `${baseline.appVersion}+build.${release.build}`,
    ),
  };
  await writeFile(join(root, 'results', 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await new Promise((r) => server.close(r));
}
