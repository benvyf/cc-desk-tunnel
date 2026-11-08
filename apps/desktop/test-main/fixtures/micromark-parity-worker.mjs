// Copied beside each isolated node_modules tree so bare imports exercise that
// tree's micromark, including mdast-util-from-markdown's transitive import.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { math, mathHtml } from 'micromark-extension-math';

const corpus = JSON.parse(await readFile(process.argv[2], 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const profiles = [
  { name: 'commonmark', extensions: [], mdastExtensions: [], htmlExtensions: [] },
  {
    name: 'gfm',
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
    htmlExtensions: [gfmHtml()],
  },
  {
    name: 'math',
    extensions: [math()],
    mdastExtensions: [mathFromMarkdown()],
    htmlExtensions: [mathHtml({ throwOnError: false, strict: 'ignore' })],
  },
  {
    name: 'gfm+math',
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
    htmlExtensions: [gfmHtml(), mathHtml({ throwOnError: false, strict: 'ignore' })],
  },
];

const results = [];
for (const { id, markdown } of corpus) {
  for (const profile of profiles) {
    // Serialize the complete tree: no filtering, including all source positions.
    const ast = JSON.stringify(fromMarkdown(markdown, profile));
    const html = micromark(markdown, profile);
    results.push({
      id,
      profile: profile.name,
      ast: hash(ast),
      html: hash(html),
      astBytes: Buffer.byteLength(ast),
      htmlBytes: Buffer.byteLength(html),
    });
  }
}

process.stdout.write(
  JSON.stringify({
    micromarkEntry: import.meta.resolve('micromark'),
    mdastEntry: import.meta.resolve('mdast-util-from-markdown'),
    results,
  }),
);
