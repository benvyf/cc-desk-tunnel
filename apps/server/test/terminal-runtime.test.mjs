import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  terminalInventory,
  verifyTerminalInventory,
} from '../../../deploy/docker/terminal-runtime.mjs';
import { RUNTIME_LEVEL } from '../../../packages/managed-server/src/index.ts';

test('release identity and publisher advertise the same runtime requirement', () => {
  const identity = JSON.parse(
    readFileSync(new URL('../../../deploy/managed-server.json', import.meta.url)),
  );
  assert.equal(identity.runtimeLevel, RUNTIME_LEVEL);
});

test('terminal inventory rejects a single corrupt JS byte and native addon changes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cc-pty-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dependency = join(root, 'node_modules/node-pty');
  for (const file of [
    'package.json',
    'lib/terminal.js',
    'build/Release/pty.node',
    'build/Release/spawn-helper',
  ]) {
    mkdirSync(dirname(join(dependency, file)), { recursive: true });
    writeFileSync(join(dependency, file), 'original');
  }
  const expected = terminalInventory(root);
  verifyTerminalInventory(root, expected);
  for (const path of ['lib/terminal.js', 'build/Release/pty.node']) {
    writeFileSync(join(dependency, path), 'originaX');
    assert.throws(() => verifyTerminalInventory(root, expected), /digest mismatch/);
    writeFileSync(join(dependency, path), 'original');
  }
  writeFileSync(join(dependency, 'lib/unexpected.js'), 'extra');
  assert.throws(() => verifyTerminalInventory(root, expected), /inventory differs/);
});
