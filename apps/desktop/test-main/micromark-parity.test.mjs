import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { applyMicromarkPatch, micromarkSourceVariants } from '../../../scripts/patch-micromark.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const profiles = ['commonmark', 'gfm', 'math', 'gfm+math'];

function handcraftedCorpus() {
  const cases = [
    ['empty', ''],
    ['single-data', 'plain'],
    ['soft-lines', 'one\ntwo\nthree\nfour\nfive\n'],
    ['crlf', 'one\r\ntwo  \r\nthree\\\r\nfour\r\n\r\nfive\r\n'],
    ['mixed-line-endings', 'one\rtwo\r\nthree\nfour\r\n'],
    ['hard-break-spaces', 'one  \ntwo   \nthree    \nfour\n'],
    ['hard-break-backslash', 'one\\\ntwo\\\nthree\n'],
    ['trailing-tabs', 'one\t\ntwo \t\nthree\t \nfour  \t  \n'],
    ['leading-tabs', '\tindented code\n\nparagraph\n\tcontinued\n'],
    ['blank-space-lines', 'one\n \n\t\n  \n\nlast\n'],
    ['unicode', '中文、かな 한글 café e\u0301 😀 👩‍💻\nעברית العربية\n𝒜 \u2028 \u2029 end\n'],
    ['unicode-position', '😀*强调* e\u0301\r\n[中文](https://example.com/路)\r\n'],
    ['null-and-controls', 'a\u0000b\u0001c\u007fd\nend\n'],
    ['emphasis', '*a **b _c_** d* and __e *f*__\n***g*** ___h___\n'],
    ['emphasis-delimiters', 'a_b_c a*b*c * a * ** ** ___ _\n**a\nb** *c\nd*\n'],
    ['adjacent-inline', 'a *b* c **d** e `f` g [h](https://example.com) i\n'],
    ['escapes', '\\*a\\* \\[x\\] \\_y\\_ \\`z\\` \\\\ \\! \\.\n'],
    ['entities', '&amp; &#35; &#x1F600; &NotEqualTilde; &unknown; &#0; &#xD800;\n'],
    ['code-spans', '`a b` ``a ` b`` ` a ` `  a  `\n`a\nb` and `unterminated\n'],
    [
      'links-titles',
      '[one](https://example.com "Title") [two](<a b> \'title\')\n[three](url (nested title))\n',
    ],
    ['nested-link-destinations', '[a](a(b(c)d)e) [b](a\\(b\\)) [c](<a\\>b>)\n'],
    ['link-references', '[A][label] [label][] [label] [missing]\n\n[label]: /target "A title"\n'],
    ['reference-normalization', '[x][A  B] [a b]\n\n[a\tb]: /first\n[A B]: /second\n'],
    ['images', '![alt *strong* &amp;](image.png "Title") ![ref][img]\n\n[img]: /image.png\n'],
    ['autolinks-commonmark', '<https://example.com/a?b=c&d=e> <me@example.com>\n'],
    [
      'autolinks-gfm',
      'www.example.com https://example.com/a_(b). me@example.com\n<user@example.com>\n',
    ],
    ['unsafe-destinations', '[x](javascript:alert(1)) ![y](data:text/html,hello)\n'],
    ['headings', '# ATX *one* #\n\nSetext &amp;\n===\n\nsecond\n---\n'],
    ['thematic-breaks', 'before\n\n* * *\n\n---\n\n___\n\nafter\n'],
    ['blockquotes', '> one\n> *two*\n>\n>> nested\n>\n> end\n'],
    ['lists', '- one\n  continued\n  - child *em*\n- two\n\n1. first\n2. second\n'],
    ['list-lazy-continuations', '- one\ncontinued\n\n  paragraph\n\n- two\n\n> quote\nlazy\n'],
    ['tasks', '- [ ] open\n- [x] done *yes*\n- [X] DONE\n- [z] ordinary\n'],
    ['fenced-code', '```js title\nconst x = `a`;\n<>&\n```\n\n~~~\nplain\n~~~\n'],
    ['unclosed-fences', 'before\n\n````md\n```\n*not emphasis*\n'],
    ['html-inline', 'a <em title="x">raw</em> b <!-- comment --> c <br />\n'],
    ['html-block', '<div>\n*raw*\n</div>\n\n<script>alert("x")</script>\n\nend\n'],
    [
      'table',
      '| left | center | right |\n| :--- | :---: | ---: |\n| *a* | `b` | c |\n| d | e | f |\n',
    ],
    ['table-escapes', 'a | b\n--- | ---\n`x\\|y` | a\\|b\nonly one\nextra | cells | ignored\n'],
    ['strikethrough', 'a ~~deleted *inside*~~ b ~single~ c ~~~triple~~~\n~~across\nlines~~\n'],
    [
      'footnotes',
      'one[^note] two[^note] missing[^missing]\n\n[^note]: first *line*\n\n    second paragraph\n',
    ],
    ['footnote-nesting', '> quote[^a]\n\n[^a]: text [link](url)\n\n    - child\n      continued\n'],
    ['math-inline', 'a $x^2 + y^2$ b $$\\alpha + \\beta$$ c\n$ x $ and $x\ny$\n'],
    ['math-display', 'before\n\n$$\n\\frac{a}{b} + \\sqrt{x}\n$$\n\nafter\n'],
    ['math-code-escape', '`$literal$` \\$escaped$ price $5 and $10\n\n```\n$x$\n```\n'],
    ['math-invalid', 'bad $\\unknowncommand{x}$ and $x_{unclosed$\n\n$$ meta\na+b\n'],
    [
      'gfm-math-combined',
      '| formula | changed |\n| --- | --- |\n| $x^2$ | ~~old~~ |\n\n- [x] $y$[^a]\n\n[^a]: $$z$$\n',
    ],
    [
      'malformed-inline',
      '[unclosed](a "title\n![x [nested] *broken ** still\n<https://bad space> &incomplete\n',
    ],
    ['delimiter-boundaries', '*a*\n**b**\n`c`\n[d](e)\n![f](g)\n&amp;\n\\*\nplain\n'],
    [
      'long-soft-paragraph',
      Array.from({ length: 1024 }, (_, i) => `line ${i} plain text`).join('\n'),
    ],
    ['long-alternating-inline', 'plain *emphasis* next **strong** data `code` tail\n'.repeat(192)],
    ['long-trailing-whitespace', 'plain text  \nnext\t \nlast\\\n'.repeat(128)],
  ];
  return cases.map(([id, markdown]) => ({ id, markdown }));
}

async function corpus() {
  const cases = handcraftedCorpus();
  // Explicit repository documents only; never recurse through .local or user data.
  for (const path of [
    'README.md',
    'README.en.md',
    'docs/architecture.md',
    'docs/development.md',
    'packages/protocol/README.md',
  ]) {
    cases.push({ id: `repo:${path}`, markdown: await readFile(join(root, path), 'utf8') });
  }
  assert.ok(cases.length >= 50, 'cover a broad, bounded corpus');
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.ok(
    cases.reduce((bytes, item) => bytes + Buffer.byteLength(item.markdown), 0) < 512 * 1024,
    'keep the regression corpus bounded',
  );
  return cases;
}

async function isolatedPackages(directory) {
  const modules = join(directory, 'node_modules');
  await mkdir(modules, { recursive: true });
  for (const name of ['micromark', 'mdast-util-from-markdown']) {
    await cp(join(root, 'node_modules', name), join(modules, name), { recursive: true });
  }
  const micromarkDirectory = join(modules, 'micromark');
  for (const variant of micromarkSourceVariants) {
    const path = join(micromarkDirectory, variant.path);
    let source = await readFile(path, 'utf8');
    if (hash(source) === variant.patchedSha256) {
      source = source.replace(variant.replacement, variant.original);
    }
    assert.equal(hash(source), variant.originalSha256, `verified stock ${variant.path}`);
    await writeFile(path, source);
  }
  await cp(
    new URL('./fixtures/micromark-parity-worker.mjs', import.meta.url),
    join(directory, 'worker.mjs'),
  );
  return micromarkDirectory;
}

function worker(directory, corpusPath, development) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...(development ? ['--conditions=development'] : []),
        join(directory, 'worker.mjs'),
        corpusPath,
      ],
      {
        cwd: root,
        // Explicitly control conditions rather than inheriting NODE_OPTIONS.
        env: { ...process.env, NODE_OPTIONS: '', DEBUG: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, `parity worker ${code ?? signal}: ${Buffer.concat(stderr)}`);
        assert.equal(Buffer.concat(stderr).toString(), '', 'worker has no parser warnings');
        const result = JSON.parse(Buffer.concat(stdout).toString());
        const expected = development ? '/dev/index.js' : '/index.js';
        for (const [key, name] of [
          ['micromarkEntry', 'micromark'],
          ['mdastEntry', 'mdast-util-from-markdown'],
        ]) {
          assert.equal(
            result[key],
            pathToFileURL(join(directory, 'node_modules', name)).href + expected,
            `resolve ${name} from isolated ${development ? 'development' : 'default'} tree`,
          );
        }
        resolve(result.results);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test(
  'consumer AST, source positions, and HTML match stock micromark in both export conditions',
  {
    timeout: 180_000,
  },
  async (t) => {
    const cases = await corpus();
    const local = join(root, '.local');
    await mkdir(local, { recursive: true });
    // Below the workspace: unchanged pure dependencies resolve to root/node_modules.
    const directory = await mkdtemp(join(local, 'micromark-parity-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const corpusPath = join(directory, 'corpus.json');
    await writeFile(corpusPath, JSON.stringify(cases));
    const stock = join(directory, 'stock');
    const patched = join(directory, 'patched');
    const installedBefore = await Promise.all(
      micromarkSourceVariants.map((variant) =>
        readFile(join(root, 'node_modules/micromark', variant.path)).then(hash),
      ),
    );
    await isolatedPackages(stock);
    const packageDirectory = await isolatedPackages(patched);
    assert.equal(applyMicromarkPatch(packageDirectory).changed.length, 2);
    for (const variant of micromarkSourceVariants) {
      assert.equal(
        hash(await readFile(join(packageDirectory, variant.path))),
        variant.patchedSha256,
      );
    }

    let defaultResults;
    for (const development of [false, true]) {
      // Sequential workers avoid competing with each other during normal test runs.
      const before = await worker(stock, corpusPath, development);
      const after = await worker(patched, corpusPath, development);
      assert.equal(before.length, cases.length * profiles.length);
      for (let i = 0; i < before.length; i++) {
        assert.deepEqual(
          after[i],
          before[i],
          `${development ? 'development' : 'default'}: ${before[i].id} / ${before[i].profile}`,
        );
      }
      if (defaultResults) assert.deepEqual(before, defaultResults, 'both export conditions agree');
      else defaultResults = before;
      t.diagnostic(
        `${development ? 'development' : 'default'}: ${cases.length} cases × ${profiles.length} profiles; complete AST with positions and HTML identical`,
      );
    }
    assert.deepEqual(
      await Promise.all(
        micromarkSourceVariants.map((variant) =>
          readFile(join(root, 'node_modules/micromark', variant.path)).then(hash),
        ),
      ),
      installedBefore,
      'installed micromark sources remain unchanged',
    );
  },
);
