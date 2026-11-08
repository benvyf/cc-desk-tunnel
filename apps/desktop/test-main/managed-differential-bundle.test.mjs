import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));

test(
  'bundles a pinned standalone differential engine and reconstructs offline without development dependencies',
  { timeout: 30_000 },
  async (t) => {
    const { bundleDifferentialEngine } =
      await import('../../../scripts/bundle-differential-engine.mjs');
    const temporary = await mkdtemp(join(tmpdir(), 'managed-engine-bundle-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const app = join(temporary, 'app');
    await mkdir(join(app, 'electron'), { recursive: true });
    await writeFile(join(app, 'electron', 'keep.cjs'), 'keep');
    await writeFile(
      join(app, 'electron', 'managed-differential-engine.cjs'),
      'throw new Error("development shim")',
    );
    await bundleDifferentialEngine(root, app);
    const filename = resolve(app, 'electron', 'managed-differential-engine.cjs');
    const content = await readFile(filename, 'utf8');
    assert.ok(
      Buffer.byteLength(content) < 300_000,
      'only the differential engine should be bundled',
    );
    assert.deepEqual((await readdir(join(app, 'electron'))).sort(), [
      'keep.cjs',
      'managed-differential-engine.LICENSE.md',
      'managed-differential-engine.cjs',
    ]);
    const notices = await readFile(
      join(app, 'electron', 'managed-differential-engine.LICENSE.md'),
      'utf8',
    );
    assert.match(notices, /electron-updater/);
    assert.match(notices, /MIT/);
    assert.match(notices, /Permission is hereby granted/);
    assert.equal(await readFile(join(app, 'electron', 'keep.cjs'), 'utf8'), 'keep');
    const script = `
    const assert=require('node:assert/strict');
    const Module=require('node:module');
    const fs=require('node:fs');
    const path=require('node:path');
    const crypto=require('node:crypto');
    const filename=process.argv[1];
    const original=Module._resolveFilename;
    Module._resolveFilename=function(specifier,...args){
      if (!Module.isBuiltin(specifier) && specifier!==filename) throw new Error('External runtime dependency: '+specifier);
      return original.call(this,specifier,...args);
    };
    const engine=require(filename);
    assert.equal(engine.version,'6.8.10');
    assert.deepEqual(Object.keys(engine).sort(),['CancellationError','CancellationToken','GenericDifferentialDownloader','HttpExecutor','OperationKind','computeOperations','version'].sort());
    const bytes=Buffer.from('offline SDK cache copy');
    const oldFile=path.resolve('old.exe'),newFile=path.resolve('new.exe');
    fs.writeFileSync(oldFile,bytes);
    const map={version:'2',files:[{name:'file',offset:0,sizes:[bytes.length],checksums:['same']}]};
    const log={info(){},warn(){},error(){}};
    assert.deepEqual(engine.computeOperations(map,map,log),[{kind:engine.OperationKind.COPY,start:0,end:bytes.length}]);
    const token=new engine.CancellationToken();
    const downloader=new engine.GenericDifferentialDownloader({size:bytes.length,sha512:crypto.createHash('sha512').update(bytes).digest('base64')},{createRequest(){throw new Error('Offline copy must not access network');}},{oldFile,newFile,newUrl:new URL('https://updates.test/installer.exe'),logger:log,requestHeaders:{},isUseMultipleRangeRequest:false,cancellationToken:token,onProgress(){}});
    downloader.download(map,map).then(()=>{assert.deepEqual(fs.readFileSync(newFile),bytes);token.dispose();process.stdout.write('standalone SDK copy verified');}).catch(error=>{console.error(error);process.exitCode=1;});
  `;
    const result = await run(process.execPath, ['-e', script, filename], {
      cwd: temporary,
      timeout: 10_000,
      env: { ...process.env, NODE_PATH: '' },
    });
    assert.equal(result.stdout, 'standalone SDK copy verified');
  },
);
