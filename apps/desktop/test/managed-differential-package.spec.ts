import { test, expect, _electron } from '@playwright/test';
import { createServer } from 'node:https';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { signIndex, PRODUCT } from '../../../packages/managed-updates/src/index.ts';
const require = createRequire(import.meta.url);
const { signDescriptor } = require('../electron/managed-differential-contract.cjs');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

for (const mode of ['normal', 'ignored-range'])
  test(`packaged mature engine uses Electron HTTPS ${mode}`, async () => {
    test.skip(
      process.platform !== 'win32' || !process.env.WINDOWS_PACKAGE_EXE,
      'Built Windows executable required',
    );
    test.setTimeout(90000);
    const root = await mkdtemp(join(tmpdir(), 'cc-native-differential-'));
    let application: any;
    const old = Buffer.alloc(512 * 1024, 7),
      target = Buffer.from(old);
    target.fill(9, target.length - 8192);
    const seed = join(root, 'stock.exe'),
      targetFile = join(root, 'target.exe');
    await writeFile(seed, old);
    await writeFile(targetFile, target);
    await buildBlockMap(seed, 'gzip', seed + '.blockmap');
    await buildBlockMap(targetFile, 'gzip', targetFile + '.blockmap');
    const maps = [await readFile(seed + '.blockmap'), await readFile(targetFile + '.blockmap')];
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const base = {
      build: 34,
      appVersion: '0.3.10',
      protocol: 24,
      sourceCommit: 'b'.repeat(40),
      filename: 'CC-Space-Setup-0.3.10-x64.exe',
      size: old.length,
      sha256: hash(old),
    };
    const release = {
      ...base,
      build: 35,
      sourceCommit: 'a'.repeat(40),
      sha256: hash(target),
      notes: 'Native packaged differential fixture',
    };
    const descriptors = [base, release].map((r, i) =>
      signDescriptor(
        {
          schema: 1,
          product: 'cc-space-nsis-differential',
          channel: 'pilot',
          platform: 'win32',
          arch: 'x64',
          release: Object.fromEntries(
            ['build', 'appVersion', 'protocol', 'sourceCommit', 'filename', 'size', 'sha256'].map(
              (k) => [k, (r as any)[k]],
            ),
          ),
          sha512: createHash('sha512')
            .update(i ? target : old)
            .digest('base64'),
          blockmap: { size: maps[i].length, sha256: hash(maps[i]), format: 'gzip-json-v2' },
        },
        'fixture',
        privateKey,
      ),
    );
    const index = signIndex(
      {
        schema: 1,
        product: PRODUCT,
        channel: 'pilot',
        platform: 'win32',
        arch: 'x64',
        revision: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        state: 'published',
        release,
      },
      'fixture',
      privateKey,
    );
    const stats = { ranges: 0, full: 0 };
    const server = createServer(defaultCertificate, (req, res) => {
      if (req.url!.includes('/channels/')) {
        res.writeHead(200, { 'content-length': index.length });
        res.end(index);
        return;
      }
      const which = req.url!.includes('/artifacts/34/') ? 0 : 1;
      if (req.url!.endsWith('.differential.json')) {
        res.writeHead(200, { 'content-length': descriptors[which].length });
        res.end(descriptors[which]);
        return;
      }
      if (req.url!.endsWith('.blockmap')) {
        res.writeHead(200, { 'content-length': maps[which].length });
        res.end(maps[which]);
        return;
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (range) {
        stats.ranges++;
        const start = +range[1],
          end = +range[2];
        if (mode === 'ignored-range') {
          res.writeHead(200, { 'content-length': target.length });
          res.end(target);
          return;
        }
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${target.length}`,
          'content-length': end - start + 1,
        });
        res.end(target.subarray(start, end + 1));
        return;
      }
      stats.full++;
      res.writeHead(200, { 'content-length': target.length });
      res.end(target);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `https://127.0.0.1:${(server.address() as any).port}`;
    try {
      const profile = join(root, 'profile');
      await mkdir(profile);
      const env: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        LOCALAPPDATA: join(root, 'local'),
        APPDATA: join(root, 'roaming'),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      application = await _electron.launch({
        executablePath: resolve(process.env.WINDOWS_PACKAGE_EXE!),
        args: ['--smoke-test', `--user-data-dir=${profile}`],
        cwd: root,
        env,
      });
      await application.firstWindow();
      const capabilities = await application.evaluate(() => {
        const require = process
          .getBuiltinModule('module')
          .createRequire(process.resourcesPath + '/app.asar/package.json');
        const fs = require('node:fs');
        const root = process.resourcesPath + '/app.asar/electron/';
        const factory = require(root + 'managed-updates.cjs');
        return {
          requestFactory: typeof factory.createDifferentialRequest,
          bundled:
            fs.existsSync(root + 'managed-differential-engine.cjs') &&
            !/require\(['"]electron-updater/.test(
              fs.readFileSync(root + 'managed-differential-engine.cjs', 'utf8'),
            ),
        };
      });
      expect(capabilities.requestFactory).toBe('function');
      expect(capabilities.bundled).toBe(true);
      const result = await application.evaluate(
        async ({ net, session }: any, options: any) => {
          const require = process
            .getBuiltinModule('module')
            .createRequire(process.resourcesPath + '/app.asar/package.json');
          const crypto = require('node:crypto'),
            fs = require('node:fs');
          session.defaultSession.setCertificateVerifyProc((request: any, callback: any) => {
            let match = false;
            try {
              match =
                request.hostname === '127.0.0.1' &&
                new crypto.X509Certificate(request.certificate.data).fingerprint256 ===
                  options.fingerprint;
            } catch {}
            callback(match ? 0 : -2);
          });
          const folder = process.resourcesPath + '/app.asar/electron/';
          const { ManagedController } = require(folder + 'managed-controller.cjs');
          const contract = require(folder + 'managed-contract.cjs');
          const { createNetwork } = require(folder + 'managed-network.cjs');
          const { createDifferentialRequest } = require(folder + 'managed-updates.cjs');
          const controller = new ManagedController({
            identity: {
              product: 'cc-desk-tunnel-managed',
              channel: 'pilot',
              platform: 'win32',
              arch: 'x64',
              build: 34,
              appVersion: '0.3.10',
              protocol: 24,
              sourceCommit: 'b'.repeat(40),
              origin: options.origin,
              trustedKeys: { fixture: options.publicKey },
            },
            executable: process.execPath,
            localAppData: options.local,
            contract,
            network: createNetwork(net.fetch.bind(net), options.origin),
            createDifferentialRequest: (p: any) => createDifferentialRequest(net, p),
            seedPaths: [options.seed],
            lockName: `\\\\.\\pipe\\cc-native-delta-${process.pid}`,
            processes: async () => [process.pid],
            quit: () => {},
            launchInstaller: async () => {
              throw new Error('No installer may execute in this fixture');
            },
          });
          controller.report({ blocked: false });
          try {
            const state = await controller.download();
            const bytes = fs.readFileSync(controller.file('ready.exe'));
            return {
              phase: state.phase,
              downloadMode: state.downloadMode,
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
              partials: fs
                .readdirSync(controller.directory)
                .filter((name: string) => name.startsWith('differential-')),
            };
          } finally {
            controller.stop();
          }
        },
        {
          origin,
          fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
          publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
          seed,
          local: join(root, 'fixture'),
        },
      );
      expect(result.phase).toBe('ready');
      expect(result.sha256).toBe(release.sha256);
      expect(result.partials).toEqual([]);
      expect(stats.ranges).toBeGreaterThan(0);
      if (mode === 'normal') {
        expect(result.downloadMode).toBe('differential');
        expect(stats.full).toBe(0);
      } else expect(stats.full).toBe(1);
    } finally {
      await application?.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });
