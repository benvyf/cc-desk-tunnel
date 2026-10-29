import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTerminalFile } from '../src/terminal-files.ts';
import { terminalLinks, terminalTarget } from '../../desktop/src/terminalLinks.ts';
import type { Terminal } from '@xterm/xterm';

test('terminal previews are bounded, read-only and confined after realpath', async () => {
  const base = await mkdtemp(join(tmpdir(), 'terminal-files-'));
  try {
    const root = join(base, 'allowed');
    await mkdir(root);
    const text = join(root, '中文 file.html');
    await writeFile(text, '<script>alert(1)</script>');
    assert.deepEqual(await readTerminalFile(text, [root]), {
      mime: 'text/plain',
      encoding: 'utf8',
      data: '<script>alert(1)</script>',
    });
    await writeFile(text, '\ufeff中文\r\n');
    const bom = await readTerminalFile(text, [root]);
    assert.equal(bom.data, '\ufeff中文\r\n'); // Download retains UTF-8 BOM and line endings.
    const outside = join(base, 'secret.txt');
    await writeFile(outside, 'secret');
    await assert.rejects(readTerminalFile(outside, [root]), /工作区/);
    await assert.rejects(readTerminalFile('relative.txt', [root]), /绝对/);
    await assert.rejects(readTerminalFile(join(root, 'missing'), [root]));
    await writeFile(join(root, 'big.txt'), Buffer.alloc(256 * 1024 + 1, 65));
    await assert.rejects(readTerminalFile(join(root, 'big.txt'), [root]), /256 KiB/);
    await writeFile(join(root, 'big.png'), Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(readTerminalFile(join(root, 'big.png'), [root]), /4 MiB/);
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
    await assert.rejects(readTerminalFile(join(root, 'binary'), [root]), /二进制/);
    // Directory symlinks (junctions on Windows) do not require elevated symlink privileges.
    await symlink(base, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readTerminalFile(join(root, 'escape', 'secret.txt'), [root]), /工作区/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('links map soft wrapped CJK cells and activate only on click', () => {
  const rows = [
    ['中', '', '文', '', ' ', '"', 'C', ':', '\\', '测', ''],
    ['试', '', ' ', 'a', '.', 't', 's', '"'],
  ];
  const clicked: string[] = [];
  const terminal = {
    buffer: {
      active: {
        length: 2,
        getLine(y: number) {
          return {
            isWrapped: y === 1,
            length: rows[y].length,
            getCell(x: number) {
              const chars = rows[y][x];
              return {
                getChars: () => chars,
                getWidth: () => (chars === '' ? 0 : /[中文测试]/.test(chars) ? 2 : 1),
              };
            },
          };
        },
      },
    },
  } as unknown as Terminal;
  const provider = terminalLinks(terminal, (value) => clicked.push(value));
  provider.provideLinks(2, (links) => {
    assert.equal(links?.length, 1);
    assert.equal(links![0].text, 'C:\\测试 a.ts');
    assert.deepEqual(links![0].range.start, { x: 7, y: 1 });
    assert.deepEqual(links![0].range.end, { x: 7, y: 2 });
    assert.equal(clicked.length, 0);
    links![0].activate({} as MouseEvent, links![0].text);
  });
  assert.deepEqual(clicked, ['C:\\测试 a.ts']);
  assert.equal(terminalTarget('javascript:alert(1)').kind, 'unknown');
  assert.equal(terminalTarget('./relative.ts').kind, 'unknown');
  assert.equal(terminalTarget('file://other-server/share').kind, 'unknown');
  assert.equal(terminalTarget('file:///C:/a%20b.txt').value, 'C:/a b.txt');
});

test('link detection keeps relative paths relative and handles quoted URIs and UNC paths', () => {
  const text =
    'src/foo.ts ./relative.ts ../parent.ts ~/home.ts HTTPS://example.test "file:///C:/a b.txt" "\\\\host\\share\\a b.txt" /absolute.ts';
  const terminal = {
    buffer: {
      active: {
        length: 1,
        getLine: () => ({
          isWrapped: false,
          length: text.length,
          getCell: (x: number) => ({ getChars: () => text[x], getWidth: () => 1 }),
        }),
      },
    },
  } as unknown as Terminal;
  terminalLinks(terminal, () => {}).provideLinks(1, (links) => {
    assert.deepEqual(
      links?.map((link) => link.text),
      [
        './relative.ts',
        '../parent.ts',
        '~/home.ts',
        'HTTPS://example.test',
        'file:///C:/a b.txt',
        '\\\\host\\share\\a b.txt',
        '/absolute.ts',
      ],
    );
    assert.equal(terminalTarget(links![0].text).kind, 'unknown');
  });
});
