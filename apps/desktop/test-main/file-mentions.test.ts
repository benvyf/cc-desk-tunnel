import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { fileMentionCandidates, producedFiles, remarkFileMentions } from '../src/fileMentions.ts';
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
