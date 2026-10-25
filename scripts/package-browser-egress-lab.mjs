// Private one-run bundle. Never upload this archive to a public download service.
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(root, '.local'), { recursive: true });
const folder = mkdtempSync(join(root, '.local/egress-private-'));
if (process.platform === 'win32') {
  const sid = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  if (!/^S-1-5-[0-9-]+$/.test(sid)) throw new Error('Cannot identify local account');
  execFileSync(
    'icacls.exe',
    [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'],
    { stdio: 'ignore', windowsHide: true },
  );
}
const stage = join(folder, 'bundle');
mkdirSync(join(stage, 'state'), { recursive: true, mode: 0o700 });
const inventory = {};
const files = [
  'scripts/browser-egress-lab.mjs',
  'scripts/start-browser-egress-lab.sh',
  'apps/server/src/browser-proxy.ts',
  'apps/server/src/browser-proxy-target.ts',
  'apps/server/src/throttle.ts',
  'docs/browser-egress-lab.md',
];
for (const file of files) {
  if (!lstatSync(join(root, file)).isFile()) throw new Error('Expected regular input: ' + file);
  const data = readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n');
  mkdirSync(dirname(join(stage, file)), { recursive: true, mode: 0o700 });
  writeFileSync(join(stage, file), data, { mode: 0o600, flag: 'wx' });
}
writeFileSync(join(stage, 'state/token'), randomBytes(32).toString('hex') + '\n', {
  mode: 0o600,
  flag: 'wx',
});
const openssl =
  process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
execFileSync(
  openssl,
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=cc-egress-lab.invalid',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    join(stage, 'state/key.pem'),
    '-out',
    join(stage, 'state/cert.pem'),
  ],
  { stdio: 'ignore', windowsHide: true },
);
const packedFiles = [...files, 'state/token', 'state/key.pem', 'state/cert.pem'].sort();
for (const file of packedFiles)
  inventory[file] = createHash('sha256')
    .update(readFileSync(join(stage, file)))
    .digest('hex');
writeFileSync(join(stage, 'LAB-INVENTORY.json'), JSON.stringify(inventory, null, 2) + '\n', {
  mode: 0o600,
});
const list = join(folder, 'files.txt');
writeFileSync(list, [...packedFiles, 'LAB-INVENTORY.json'].join('\n') + '\n', { mode: 0o600 });
const archive = join(folder, 'egress-lab.tgz');
execFileSync(
  process.platform === 'win32' ? 'tar.exe' : 'tar',
  ['--format=ustar', '--no-recursion', '-czf', archive, '-C', stage, '-T', list],
  { windowsHide: true },
);
const certificate = new X509Certificate(readFileSync(join(stage, 'state/cert.pem')));
const config = {
  url: 'wss://127.0.0.1:18789/ws',
  fingerprint: certificate.fingerprint256,
  token: readFileSync(join(stage, 'state/token'), 'utf8').trim(),
};
writeFileSync(join(folder, 'client.json'), JSON.stringify(config), { mode: 0o600 });
const bytes = readFileSync(archive);
if (bytes.length > 262144) throw new Error('Bundle exceeds bounded receiver size');
console.log(
  JSON.stringify({
    archive,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    files: packedFiles.length + 1,
  }),
);
