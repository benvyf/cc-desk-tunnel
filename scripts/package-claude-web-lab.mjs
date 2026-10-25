import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '.local/cc-browser-network-lab.tar.gz');
const extra = [
  'scripts/claude-web-lab.ts',
  'scripts/start-claude-web-lab.sh',
  'apps/desktop/test/fixtures/offline-rfb.ts',
  'docs/claude-web-network-lab.md',
];
const tracked = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    '--',
    'apps/server/src',
    'packages/protocol/src',
    'packages/managed-server/src',
  ],
  { cwd: root, encoding: 'utf8', windowsHide: true },
)
  .split('\0')
  .filter(Boolean);
if (!tracked.length || tracked.some((file) => !/\.(?:ts|mjs)$/.test(file)))
  throw new Error('Unexpected server source inventory');
mkdirSync(dirname(output), { recursive: true });
const stage = mkdtempSync(join(root, '.local/browser-lab-package-'));
try {
  const inventory = {};
  for (const file of [...tracked, ...extra].sort()) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error('Expected regular source file');
    const content = readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n');
    mkdirSync(dirname(join(stage, file)), { recursive: true });
    writeFileSync(join(stage, file), content);
    inventory[file] = createHash('sha256').update(content).digest('hex');
  }
  writeFileSync(join(stage, 'LAB-INVENTORY.json'), JSON.stringify(inventory, null, 2) + '\n');
  const list = join(stage, 'files.txt');
  writeFileSync(list, [...Object.keys(inventory), 'LAB-INVENTORY.json'].join('\n') + '\n');
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['--format=ustar', '--no-recursion', '-czf', output, '-C', stage, '-T', list],
    { cwd: root, windowsHide: true },
  );
  console.log(`Synthetic Ubuntu lab: ${output}`);
  console.log(`SHA256 ${createHash('sha256').update(readFileSync(output)).digest('hex')}`);
  console.log(
    `${Object.keys(inventory).length} source/doc files; no dependencies, credentials or browser profile.`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
