import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runtimeFiles = [
  'scripts/upgrade-message-review.py',
  'scripts/upgrade-terminal-base.py',
  'scripts/install-cc-space-037.py',
  'apps/update-service/src/config.ts',
  'apps/update-service/src/http.ts',
  'apps/update-service/src/main.ts',
  'apps/update-service/src/store.ts',
  'apps/update-service/src/monitor.ts',
  'apps/update-service/src/enrollment.ts',
  'apps/update-service/src/fresh-nodes.ts',
  'apps/update-service/src/jev.ts',
  'apps/update-service/src/moderation.ts',
  'apps/update-service/src/moderation-nodes.ts',
  'apps/update-service/src/password-auth.ts',
  'apps/update-service/src/desktop-access.ts',
  'apps/update-service/src/desktop-server-update.ts',
  'apps/desktop/electron/secure-service.mjs',
  'apps/desktop/electron/system-proxy.mjs',
  'apps/update-service/src/server-distribution.ts',
  'apps/server/src/managed-server-files.ts',
  'packages/managed-server/src/index.ts',
  'scripts/managed-server-publication.mjs',
  'scripts/create-moderation-node.mjs',
  'scripts/create-admin-password-setup.mjs',
  'apps/update-service/web/index.html',
  'apps/update-service/web/app.js',
  'apps/update-service/web/moderation.js',
  'apps/update-service/web/password-login.js',
  'apps/update-service/web/desktop-access.js',
  'apps/update-service/web/monitor.js',
  'apps/update-service/web/navigation.js',
  'apps/update-service/web/enrollment.js',
  'apps/update-service/web/monitor-install.py',
  'apps/update-service/web/server-bootstrap.py',
  'apps/update-service/web/server-upgrade.cjs',
  'apps/update-service/web/server-download.js',
  'apps/update-service/web/fresh-nodes.js',
  'apps/update-service/web/fresh-install.py',
  'apps/update-service/web/style.css',
  'packages/managed-updates/src/index.ts',
  'packages/protocol/src/account-monitor.ts',
  'packages/protocol/src/account-number.ts',
  'deploy/update-service/cc-update-service.service',
  'deploy/update-service/cc-admin-password-setup',
  'deploy/update-service/nginx.conf.example',
  'deploy/update-service/config.example.json',
  'deploy/update-service/cc-server-index-renew.service',
  'deploy/update-service/cc-server-index-renew.timer',
  'deploy/server-bootstrap-profile.json',
  'docs/MANAGED-SERVER-DISTRIBUTION.md',
  'docs/FRESH-UBUNTU-INSTALL.md',
  'docs/UPDATE-SERVICE.md',
  'docs/ACCOUNT-MONITOR.md',
  'docs/ACCOUNT-MONITOR-DEPLOYMENT.md',
  'docs/ADMIN-PASSWORD-LOGIN.md',
  'docs/JEV-SUB2API-REFERENCE.md',
  'docs/MODERATION-NODE-GATE.md',
];

export async function packageUpdateService(root, output) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 required.');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  function clean() {
    if (
      git('status', '--porcelain', '--untracked-files=normal') ||
      git('rev-parse', 'HEAD') !== sourceCommit
    )
      throw new Error('A clean, unchanged source checkout is required.');
  }
  clean();
  const staging = await mkdtemp(join(tmpdir(), 'cc-update-runtime-'));
  try {
    const files = {};
    for (const file of runtimeFiles) {
      git('ls-files', '--error-unmatch', '--', file);
      const info = await lstat(join(root, file));
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('Runtime sources must be ordinary files.');
      await mkdir(dirname(join(staging, file)), { recursive: true });
      await copyFile(join(root, file), join(staging, file));
      files[file] = createHash('sha256')
        .update(await readFile(join(staging, file)))
        .digest('hex');
    }
    const buildInfo = {
      product: 'cc-managed-update-service',
      sourceCommit,
      nodeVersion: process.version,
      createdAt: new Date().toISOString(),
      files,
    };
    await writeFile(join(staging, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
    await writeFile(
      join(staging, 'package.json'),
      JSON.stringify(
        {
          name: 'cc-managed-update-service',
          private: true,
          type: 'module',
          engines: { node: '>=24 <25' },
        },
        null,
        2,
      ) + '\n',
    );
    const archive = join(staging, 'runtime.tar.gz');
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-czf', archive, '-C', staging, 'package.json', 'BUILD-INFO.json', ...runtimeFiles],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    );
    clean();
    await mkdir(dirname(output), { recursive: true });
    await copyFile(archive, output, constants.COPYFILE_EXCL);
    return buildInfo;
  } finally {
    if (dirname(staging) !== tmpdir()) throw new Error('Unexpected packaging directory.');
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Expected optional output path.');
    const info = await packageUpdateService(
      fileURLToPath(new URL('..', import.meta.url)),
      resolve(process.argv[2] ?? 'artifacts/cc-update-service.tar.gz'),
    );
    console.log(
      `Update-service source archive created from ${info.sourceCommit}. No configuration, keys or dependencies included.`,
    );
  } catch {
    console.error(
      'Update-service packaging failed; check Node 24, a clean source tree, tar and a new output path.',
    );
    process.exitCode = 1;
  }
}
