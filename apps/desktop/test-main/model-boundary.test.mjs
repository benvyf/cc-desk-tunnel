import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  modelBoundaryIssues,
  assertDesktopModelBoundary,
} from '../../../scripts/model-boundary.mjs';

test('client dependency checks reject model runtimes while leaving the server owner available', () => {
  for (const dependency of [
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
    '@anthropic-ai/claude-code',
    'openai',
    '@ai-sdk/anthropic',
    '@cc-desk-tunnel/server',
  ]) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      assert.equal(
        modelBoundaryIssues(
          'apps/desktop/package.json',
          JSON.stringify({ [field]: { [dependency]: '1' } }),
        ).length,
        1,
      );
    }
    assert.deepEqual(
      modelBoundaryIssues(
        'apps/server/package.json',
        JSON.stringify({ dependencies: { [dependency]: '1' } }),
      ),
      [],
    );
  }
});
test('client model SDK and server-runtime imports are rejected for static and dynamic imports', () => {
  for (const source of [
    "import {query} from '@anthropic-ai/claude-agent-sdk';",
    "const sdk = require('@anthropic-ai/sdk');",
    "await import('openai');",
    "import '../../../server/src/claude.ts';",
    "import {run} from '../../../server/src/native-terminal.ts';",
    "import {run} from '@cc-desk-tunnel/server';",
    "export {query} from '@anthropic-ai/claude-agent-sdk';",
    "import type {Query} from '@anthropic-ai/claude-agent-sdk';",
  ]) {
    assert.equal(
      modelBoundaryIssues('apps/desktop/electron/feature.mjs', source).length,
      1,
      source,
    );
  }
});
test('local preview renderers and the existing protocol remain valid client dependencies', () => {
  assert.deepEqual(
    modelBoundaryIssues(
      'apps/desktop/package.json',
      JSON.stringify({
        dependencies: {
          react: '1',
          'pdfjs-dist': '1',
          '@deepseek-ai/libreoffice-kit': '1',
          '@cc-desk-tunnel/protocol': '1',
        },
      }),
    ),
    [],
  );
  assert.deepEqual(
    modelBoundaryIssues(
      'apps/desktop/src/Preview.tsx',
      "import type {Session} from '@cc-desk-tunnel/protocol'; await import('pdfjs-dist');",
    ),
    [],
  );
  assert.deepEqual(
    modelBoundaryIssues(
      'apps/desktop/src/Help.tsx',
      `const help = "import('openai')"; // require('@anthropic-ai/sdk')`,
    ),
    [],
  );
  assert.deepEqual(
    modelBoundaryIssues(
      'apps/server/src/claude.ts',
      "import {query} from '@anthropic-ai/claude-agent-sdk';",
    ),
    [],
  );
});

test('shared server types do not bring a server runtime into the client', () => {
  for (const source of [
    "import type {State} from '../../server/src/managed-server-http.ts';",
    "type State=import('../../server/src/managed-server-http.ts').State;",
    "import {type State} from '../../server/src/managed-server-http.ts';",
  ])
    assert.deepEqual(modelBoundaryIssues('apps/desktop/src/View.tsx', source), []);
  assert.equal(
    modelBoundaryIssues(
      'apps/desktop/src/View.tsx',
      "import {run} from '../../server/src/managed-server-http.ts';",
    ).length,
    1,
  );
});

test('build checks read the working files and fail before packaging a local model runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-model-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/desktop/src'), { recursive: true });
  await mkdir(join(root, 'apps/desktop/electron'), { recursive: true });
  await writeFile(join(root, 'apps/desktop/package.json'), '{}');
  const entry = join(root, 'apps/desktop/electron/runner.cjs');
  await writeFile(entry, "require('@anthropic-ai/claude-agent-sdk');");
  assert.throws(() => assertDesktopModelBoundary(root), /客户端禁止导入模型/);
  await writeFile(entry, "require('node:path');");
  assert.doesNotThrow(() => assertDesktopModelBoundary(root));
  await writeFile(
    join(root, 'apps/desktop/package.json'),
    JSON.stringify({ dependencies: { openai: '1' } }),
  );
  assert.throws(() => assertDesktopModelBoundary(root), /客户端禁止声明模型/);
});

test('npm dependency aliases cannot add a model SDK to the client', () => {
  for (const target of [
    'npm:@anthropic-ai/sdk@1',
    'npm:@anthropic-ai/claude-agent-sdk',
    'npm:openai@4',
    'npm:@cc-desk-tunnel/server@1',
  ]) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      assert.equal(
        modelBoundaryIssues(
          'apps/desktop/package.json',
          JSON.stringify({ [field]: { model: target } }),
        ).length,
        1,
        target,
      );
  }
  assert.deepEqual(
    modelBoundaryIssues(
      'apps/desktop/package.json',
      JSON.stringify({ dependencies: { office: 'npm:@deepseek-ai/libreoffice-kit@0.2.3' } }),
    ),
    [],
  );
});
