import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stagePreviewOffice } from '../../../scripts/package-preview-office.mjs';

test('Office staging preserves workers, engine resources, licenses and native modules without build scripts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-preview-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{}');
  const packages = {
    '@deepseek-ai/libreoffice-kit': {
      dependencies: { saxes: '1' },
      optionalDependencies: { '@deepseek-ai/libreoffice-kit-win32-x64': '1' },
    },
    '@deepseek-ai/libreoffice-kit-win32-x64': {},
    saxes: {},
    koffi: { optionalDependencies: { '@koromix/koffi-win32-x64': '1' } },
    '@koromix/koffi-win32-x64': {},
  };
  for (const [name, extra] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', name);
    await mkdir(join(dir, 'lib'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1', scripts: { install: 'must not run' }, ...extra }),
    );
    await writeFile(join(dir, 'lib/worker.mjs'), 'worker');
    await writeFile(join(dir, 'LICENSE'), 'notice');
  }
  await writeFile(
    join(root, 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/engine.dll'),
    'engine',
  );
  await writeFile(join(root, 'node_modules/@koromix/koffi-win32-x64/koffi.node'), 'native');
  const app = join(root, 'app');
  assert.deepEqual(stagePreviewOffice(root, app, { platform: 'win32', arch: 'x64' }), {
    '@deepseek-ai/libreoffice-kit': '1',
    '@deepseek-ai/libreoffice-kit-win32-x64': '1',
    koffi: '1',
    '@koromix/koffi-win32-x64': '1',
  });
  assert.equal(
    await readFile(
      join(app, 'node_modules/@deepseek-ai/libreoffice-kit-win32-x64/engine.dll'),
      'utf8',
    ),
    'engine',
  );
  assert.equal(
    await readFile(join(app, 'node_modules/@koromix/koffi-win32-x64/koffi.node'), 'utf8'),
    'native',
  );
  for (const name of Object.keys(packages)) {
    assert.equal(await readFile(join(app, 'node_modules', name, 'LICENSE'), 'utf8'), 'notice');
    const manifest = JSON.parse(
      await readFile(join(app, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.scripts, undefined);
  }
  assert.throws(
    () => stagePreviewOffice(root, join(root, 'bad'), { platform: 'win32', arch: 'arm64' }),
    /Cannot find module/,
  );
});
