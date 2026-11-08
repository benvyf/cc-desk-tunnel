import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { fileMentionCandidates, producedFiles, remarkFileMentions } from '../src/fileMentions.ts';
import { linkTarget } from '../src/links.ts';
import type { Turn, TranscriptItem } from '../src/transcript.ts';

const place = { projectPath: 'C:\\项目', here: true, browser: false };
const file = 'C:\\成果\\婚礼主持稿_新流程.docx';
const tool = (name: string, path: string, state = 'completed') =>
  ({ kind: 'tool', name, input: JSON.stringify({ file_path: path }), state }) as TranscriptItem;

test('only successful writes and edits from this turn supply file targets', () => {
  const turn = {
    steps: [
      {
        kind: 'work',
        items: [
          tool('Write', file),
          tool('Edit', file),
          tool('Read', 'read.pdf'),
          tool('Write', 'failed.pdf', 'failed'),
          tool('Write', 'pending.pdf', 'running'),
          { ...tool('Write', file), input: '{' },
        ],
      },
    ],
  } as Turn;
  assert.deepEqual(producedFiles(turn), [file]);
  assert.deepEqual(producedFiles({ steps: [] } as unknown as Turn), []);
});

test('unique filenames resolve to their recorded path, including Windows case and separators', () => {
  assert.deepEqual(fileMentionCandidates('婚礼主持稿_新流程.docx', [file], undefined, place), [
    file,
  ]);
  assert.deepEqual(fileMentionCandidates('REPORT.PDF', ['C:/成果/report.pdf'], undefined, place), [
    'C:\\成果\\report.pdf',
  ]);
  assert.deepEqual(
    fileMentionCandidates('report.pdf', ['C:/a/report.pdf', 'C:/b/report.pdf'], undefined, place),
    [],
  );
  assert.deepEqual(fileMentionCandidates('notes.md', [], undefined, place), []);
  assert.deepEqual(fileMentionCandidates('curl report.pdf', [file], undefined, place), []);
});

test('command-produced files use the explicit directory in the reply, never the project root', () => {
  assert.deepEqual(fileMentionCandidates('婚礼主持稿_新流程.pdf', [], 'C:\\成果 文件夹\\', place), [
    'C:\\成果 文件夹\\婚礼主持稿_新流程.pdf',
  ]);
  assert.deepEqual(fileMentionCandidates('./out/report.pdf', [], undefined, place), [
    'C:\\项目\\out\\report.pdf',
  ]);
  assert.deepEqual(fileMentionCandidates('/tmp/report.pdf', [], undefined, place), []);
  assert.deepEqual(fileMentionCandidates('javascript:alert(1)', [], undefined, place), []);
});

test('the Markdown pass annotates inline file references only, retaining directory scope', () => {
  const processor = unified().use(remarkParse).use(remarkFileMentions, { paths: [], place });
  const tree = processor.runSync(
    processor.parse(
      '文件在 `C:\\成果 文件夹\\`：\n\n- `婚礼主持稿_新流程.docx`\n\n```text\nreport.pdf\n```\n\n[`already.pdf`](./already.pdf)',
    ),
  );
  const codes: any[] = [];
  function visit(node: any) {
    if (node.type === 'inlineCode') codes.push(node);
    node.children?.forEach(visit);
  }
  visit(tree);
  assert.equal(codes[0].data, undefined);
  assert.equal(
    codes[1].data.hProperties['data-file-path'],
    'C:\\成果 文件夹\\婚礼主持稿_新流程.docx',
  );
  assert.equal(codes[2].data, undefined, 'do not nest interactive links');
});

test('filesystem paths preserve literal percent escapes and extensionless generated files', () => {
  for (const path of [
    'C:\\成果\\100%20完成.pdf',
    'C:\\成果\\report%2520final.pdf',
    'C:\\成果\\README',
  ]) {
    assert.deepEqual(fileMentionCandidates(path, [path], undefined, place), [path]);
    assert.deepEqual(fileMentionCandidates(path.split('\\').at(-1)!, [path], undefined, place), [
      path,
    ]);
  }
});

test('recorded targets match project-relative references with either separator', () => {
  const path = 'C:\\项目\\out\\report.pdf';
  for (const value of ['out/report.pdf', 'out\\report.pdf', './out/report.pdf']) {
    assert.deepEqual(fileMentionCandidates(value, [path], undefined, place), [path]);
  }
});

test('an explicitly named directory takes precedence over unrelated same-basename writes', () => {
  assert.deepEqual(fileMentionCandidates('report.pdf', ['C:\\a\\report.pdf'], 'C:\\b', place), [
    'C:\\b\\report.pdf',
  ]);
  assert.deepEqual(
    fileMentionCandidates('report.pdf', ['C:\\a\\report.pdf', 'C:\\b\\report.pdf'], 'C:\\b', place),
    ['C:\\b\\report.pdf'],
  );
});

test('directory references support omitted separators, dotted names and drive roots', () => {
  for (const directory of ['C:\\成果', 'C:\\成果.v2', 'C:\\']) {
    const processor = unified().use(remarkParse).use(remarkFileMentions, { paths: [], place });
    const tree: any = processor.runSync(processor.parse(`文件在 \`${directory}\`：\`report.pdf\``));
    const codes = tree.children[0].children.filter((node: any) => node.type === 'inlineCode');
    assert.equal(
      codes[1].data?.hProperties?.['data-file-path'],
      `${directory.replace(/[\\/]$/, '')}\\report.pdf`,
    );
  }
});

test('generated link addresses round-trip raw filenames and retain authored line locations', () => {
  const path = 'C:\\成果\\100%2520完成#L12.ts';
  const processor = unified()
    .use(remarkParse)
    .use(remarkFileMentions, { paths: [path], place });
  const tree: any = processor.runSync(processor.parse(`\`${path}\`，\`${path}:12:3\``));
  const codes = tree.children[0].children.filter((node: any) => node.type === 'inlineCode');
  for (const [index, code] of codes.entries()) {
    const props = code.data?.hProperties;
    assert.equal(props?.['data-file-path'], path);
    assert.deepEqual(linkTarget(props?.['data-file-href'] ?? '', place), {
      kind: 'path',
      path,
      line: index === 1 ? 12 : undefined,
      column: index === 1 ? 3 : undefined,
    });
  }
});

test('an explicit generated file does not become the directory of the next filename', () => {
  const paths = ['C:\\成果\\first.pdf', 'C:\\成果\\second.pdf'];
  const processor = unified().use(remarkParse).use(remarkFileMentions, { paths, place });
  const tree: any = processor.runSync(processor.parse(`\`${paths[0]}\` 和 \`second.pdf\``));
  const codes = tree.children[0].children.filter((node: any) => node.type === 'inlineCode');
  assert.equal(codes[1].data?.hProperties?.['data-file-path'], paths[1]);
});

test('output directories do not override generated files in another section or after a list', () => {
  for (const boundary of [
    '\n\n## Source changes\n\n',
    '\n\n- `report.pdf`\n\n',
    '：`report.pdf`。\n\n',
  ]) {
    const processor = unified()
      .use(remarkParse)
      .use(remarkFileMentions, { paths: ['C:\\项目\\src\\app.ts'], place });
    const tree: any = processor.runSync(
      processor.parse('文件在 `C:\\成果\\`' + boundary + '`app.ts`'),
    );
    const code = tree.children.at(-1).children[0];
    assert.equal(code.data?.hProperties?.['data-file-path'], 'C:\\项目\\src\\app.ts');
  }
});

test('a possible directory keeps the unique recorded fallback until its filesystem kind is known', () => {
  const path = 'C:\\项目\\README';
  const processor = unified()
    .use(remarkParse)
    .use(remarkFileMentions, { paths: [path], place });
  const tree: any = processor.runSync(
    processor.parse('查看 `C:\\docs\\guide.pdf`，生成 `README`。'),
  );
  const code = tree.children[0].children.filter((node: any) => node.type === 'inlineCode')[1];
  assert.equal(code.data?.hProperties?.['data-file-directory'], 'C:\\docs\\guide.pdf');
  assert.equal(code.data?.hProperties?.['data-file-fallback'], path);
});
