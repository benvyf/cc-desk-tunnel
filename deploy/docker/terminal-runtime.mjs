// Local runtime verification only. Never starts Claude or reads service/account configuration.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function terminalInventory(root) {
  const directory = join(root, 'node_modules/node-pty');
  const files = ['package.json'];
  function walk(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative + '/' + entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error('Terminal runtime contains a linked file');
    }
  }
  walk('lib');
  // Linux uses the native addon directly; some builds also carry a spawn helper.
  files.push('build/Release/pty.node');
  if (existsSync(join(directory, 'build/Release/spawn-helper')))
    files.push('build/Release/spawn-helper');
  return Object.fromEntries(
    files.sort().map((path) => [path, digest(readFileSync(join(directory, path)))]),
  );
}

export function verifyTerminalInventory(root, expected) {
  const actual = terminalInventory(root);
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort()))
    throw new Error('Terminal runtime inventory differs');
  for (const [path, hash] of Object.entries(actual))
    if (hash !== expected[path])
      throw new Error('Terminal runtime digest mismatch: node-pty/' + path);
}

export async function probeTerminal(root) {
  const require = createRequire(join(root, 'package.json'));
  const { spawn } = require('node-pty');
  const child = spawn(process.execPath, ['-e', "process.stdout.write('cc-pty-ready')"], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Terminal runtime PTY probe timed out'));
    }, 10000);
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output === 'cc-pty-ready') resolve();
      else reject(new Error('Terminal runtime PTY probe failed'));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    const manifest = '/opt/runtime/terminal-integrity.json';
    const mode = process.argv[2];
    if (mode === '--record') {
      await probeTerminal(root);
      writeFileSync(manifest, JSON.stringify(terminalInventory(root)) + '\n', { mode: 0o644 });
    } else if (mode === '--check' || mode === '--probe') {
      const stat = lstatSync(manifest);
      if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
        throw new Error('Terminal runtime inventory is not protected');
      verifyTerminalInventory(root, JSON.parse(readFileSync(manifest, 'utf8')));
      if (mode === '--probe') await probeTerminal(root);
    } else throw new Error('Expected --record, --check or --probe');
    console.log('Terminal runtime verified: ' + mode);
  } catch (error) {
    console.error('Terminal runtime verification failed:', error.message);
    process.exitCode = 1;
  }
}
