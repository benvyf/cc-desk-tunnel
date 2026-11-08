import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { validateIdentity } = createRequire(import.meta.url)(
  '../apps/desktop/electron/managed-identity.cjs',
);

export function managedBuildIdentity(root) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  if (git('status', '--porcelain'))
    throw new Error('Managed release requires a clean Git worktree');
  const config = JSON.parse(readFileSync(join(root, 'deploy/managed-client.json'), 'utf8'));
  const appVersion = JSON.parse(
    readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'),
  ).version;
  const source = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8');
  const protocol = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(source)?.[1]);
  return validateIdentity({
    ...config,
    appVersion,
    protocol,
    sourceCommit: git('rev-parse', 'HEAD'),
    platform: 'win32',
    arch: 'x64',
  });
}
