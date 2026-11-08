import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('every public deployment file in release inventory survives the explicit Docker context allowlist', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = execFileSync('git', ['ls-files', 'deploy'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split(/\r?\n/);
  const patterns = readFileSync(new URL('../../../.dockerignore', import.meta.url), 'utf8').split(
    /\r?\n/,
  );
  assert.ok(patterns.includes('!.dockerignore'), 'Descriptor includes .dockerignore itself');
  for (const path of files)
    assert.ok(
      patterns.includes(`!${path}`),
      `Docker image omits descriptor inventory file: ${path}`,
    );
  assert.ok(
    !patterns.includes('!deploy/**'),
    'Ignored local deployment secrets must not enter source builds',
  );
});
