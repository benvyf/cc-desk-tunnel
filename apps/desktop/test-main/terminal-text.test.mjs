import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { readTerminalText } = createRequire(import.meta.url)('../electron/terminal-text.cjs');

test('local terminal text previews are bounded, non-executing and refuse network or relative paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-text-'));
  try {
    const path = join(directory, 'unsafe.html');
    await writeFile(path, '<script>throw new Error("must not execute")</script>中文');
    assert.equal(
      await readTerminalText(path),
      '<script>throw new Error("must not execute")</script>中文',
    );
    await assert.rejects(readTerminalText('relative.txt'), /绝对路径/);
    await assert.rejects(readTerminalText('\\\\server\\share\\x.txt'), /绝对路径/);
    await assert.rejects(readTerminalText(directory), /普通文件/);
    await writeFile(path, Buffer.alloc(256 * 1024 + 1, 65));
    await assert.rejects(readTerminalText(path), /256 KiB/);
    await writeFile(path, Buffer.from([0, 1, 2]));
    await assert.rejects(readTerminalText(path), /二进制/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
