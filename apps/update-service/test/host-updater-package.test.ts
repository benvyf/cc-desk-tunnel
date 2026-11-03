import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hostInstaller, hostEnrollmentCommand } from '../src/host-updater-package.ts';
const { runtimeFiles } = await import(
  new URL('../../../scripts/package-update-service.mjs', import.meta.url).href
);
import type { UpdateConfig } from '../src/config.ts';

test('published runtime includes every host channel file and generated installer matches source bytes', async () => {
  for (const path of [
    'scripts/upgrade-runtime-base.py',
    'apps/update-service/src/host-updates.ts',
    'apps/update-service/src/host-updater-package.ts',
    'apps/update-service/web/node-updates.js',
    'apps/update-service/web/host-updater-agent.py',
    'apps/update-service/web/host-updater-install.py',
    'docs/HOST-UPDATES.md',
  ])
    assert.ok(runtimeFiles.includes(path), `missing runtime file: ${path}`);
  const installer = await hostInstaller({
    origin: 'https://api.ghostapi.org',
    trustedKeys: { fixture: 'public-key-fixture' },
  } as unknown as UpdateConfig);
  assert.ok(installer.length < 262144);
  const encoded = /BUNDLE = '([^']+)'/.exec(installer.toString())![1];
  const bundle = JSON.parse(inflateSync(Buffer.from(encoded, 'base64')).toString());
  const expected = new Map([
    ['agent.py', '../web/host-updater-agent.py'],
    ['server-upgrade.cjs', '../web/server-upgrade.cjs'],
    ['base/upgrade-runtime-base.py', '../../../scripts/upgrade-runtime-base.py'],
    ['base/install-cc-space-037.py', '../../../scripts/install-cc-space-037.py'],
  ]);
  for (const [name, path] of expected)
    assert.deepEqual(
      Buffer.from(bundle.files[name], 'base64'),
      await readFile(new URL(path, import.meta.url)),
    );
  const sha = createHash('sha256').update(installer).digest('hex');
  assert.match(
    hostEnrollmentCommand(bundle.origin, installer, 'ubuntu-cc', 'x'.repeat(43)),
    new RegExp(sha),
  );
});
