import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, truncate, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeReviewText, reviewNativeHook } from '../src/native-moderation-hook.ts';

const input = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'offline-session',
  prompt: ' 当前新消息🙂\n保留原文 ',
};
const cli = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const node = {
  endpoint: 'https://offline.invalid/cc-updates/v1/moderation/check',
  nodeId: 'offline-node',
  token: 'x'.repeat(43),
};

test('only the current terminal message is selected, regardless of history or extra fields', () => {
  const event = {
    ...input,
    transcript_path: '/never-open.jsonl',
    custom_instructions: 'NOT_A_MESSAGE',
    tool_calls: [{ tool_response: 'NOT_A_MESSAGE' }],
  };
  assert.deepEqual(nativeReviewText(event, cli), { kind: 'message.send', text: input.prompt });
});

test('explicit user submissions are not skipped by inherited SDK or agent markers', () => {
  assert.deepEqual(
    nativeReviewText(
      { ...input, source: 'user', agent_id: 'worker' },
      {
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      },
    ),
    { kind: 'message.send', text: input.prompt },
  );
  assert.throws(
    () =>
      nativeReviewText(
        { ...input, source: 'unknown' },
        {
          CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        },
      ),
    /Invalid native source/,
  );
});

test('retired hooks, SDK turns and generated prompts do not request a review', async () => {
  let calls = 0;
  const moderation = {
    ...node,
    fetcher: (async () => {
      calls++;
      throw new Error('out of scope');
    }) as typeof fetch,
  };
  for (const event of ['PostToolBatch', 'UserPromptExpansion', 'PreCompact']) {
    assert.equal(nativeReviewText({ hook_event_name: event }, cli), undefined);
    assert.deepEqual(await reviewNativeHook({ hook_event_name: event }, moderation, cli), {});
  }
  assert.equal(nativeReviewText(input, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }), undefined);
  await reviewNativeHook(input, moderation, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
  for (const source of ['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event'])
    await reviewNativeHook({ ...input, source }, moderation, cli);
  await reviewNativeHook({ ...input, agent_id: 'worker' }, moderation, cli);
  assert.equal(calls, 0);
});

test('a terminal message requires an explicit allow and never retries a rejection or network failure', async () => {
  const seen: Record<string, unknown>[] = [];
  let allowed = true;
  const moderation = {
    ...node,
    fetcher: (async (_url, init) => {
      seen.push(JSON.parse(init!.body as string));
      return Response.json({ id: randomUUID(), allowed });
    }) as typeof fetch,
  };
  assert.deepEqual(await reviewNativeHook(input, moderation, cli), {});
  assert.equal(seen[0].text, input.prompt);
  assert.equal(seen[0].kind, 'message.send');
  assert.equal(seen[0].deviceId, 'native-terminal');
  allowed = false;
  await assert.rejects(reviewNativeHook(input, moderation, cli), /操作失败/);
  let failed = 0;
  await assert.rejects(
    reviewNativeHook(
      input,
      {
        ...node,
        fetcher: async () => {
          failed++;
          throw new Error('offline failure');
        },
      },
      cli,
    ),
    /操作失败/,
  );
  assert.equal(seen.length, 2);
  assert.equal(failed, 1);
});

test('64 KiB applies to this complete message, with UTF-8 preserved and invalid inputs refused', () => {
  const text = '中'.repeat(21845) + 'x';
  assert.equal(Buffer.byteLength(text), 65536);
  assert.equal(nativeReviewText({ ...input, prompt: text }, cli)!.text, text);
  for (const event of [
    { ...input, prompt: text + 'x' },
    { ...input, prompt: '  ' },
    { ...input, session_id: 'bad/id' },
    { ...input, source: 'unknown' },
    { ...input, hook_event_name: 'unknown' },
  ])
    assert.throws(() => nativeReviewText(event, cli));
  assert.equal(
    nativeReviewText(input, {})!.text,
    input.prompt,
    'Legacy interactive events without source stay covered',
  );
});

test('command entry reviews a new message without opening a 17 MiB corrupt history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-message-hook-'));
  try {
    const config = join(directory, 'config.json'),
      history = join(directory, 'history.jsonl');
    const observed = join(directory, 'observed.json'),
      preload = join(directory, 'fetch.mjs');
    await writeFile(config, JSON.stringify(node));
    await writeFile(history, '{broken history');
    await truncate(history, 17 * 1024 * 1024);
    await writeFile(
      preload,
      `import {writeFileSync} from 'node:fs';
      import {randomUUID} from 'node:crypto';
      globalThis.fetch=async (_url,init)=>{writeFileSync(process.env.HOOK_OBSERVED,init.body);return Response.json({id:randomUUID(),allowed:true});};`,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        fileURLToPath(new URL('../src/native-moderation-hook.ts', import.meta.url)),
        config,
      ],
      {
        input: JSON.stringify({ ...input, transcript_path: history }),
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', HOOK_OBSERVED: observed },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(JSON.parse(await readFile(observed, 'utf8')).text, input.prompt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('out of scope command hooks return before opening node configuration', () => {
  const script = fileURLToPath(new URL('../src/native-moderation-hook.ts', import.meta.url));
  for (const event of ['PostToolBatch', 'UserPromptExpansion', 'PreCompact', 'UserPromptSubmit']) {
    const result = spawnSync(process.execPath, [script, '/missing-config.json'], {
      input: JSON.stringify({ ...input, hook_event_name: event }),
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: event === 'UserPromptSubmit' ? 'sdk-ts' : 'cli',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(result.stderr, '');
  }
});

test('input and configuration failures block with safe diagnostics', () => {
  const script = fileURLToPath(new URL('../src/native-moderation-hook.ts', import.meta.url));
  for (const prompt of ['PRIVATE_USER_TEXT', '中'.repeat(22000) + 'PRIVATE_USER_TEXT']) {
    const result = spawnSync(process.execPath, [script, '/missing-config.json'], {
      input: JSON.stringify({ ...input, prompt }),
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.decision, 'block');
    assert.equal(value.hookSpecificOutput.suppressOriginalPrompt, true);
    assert.match(
      value.reason,
      prompt.startsWith('中') ? /native_review_input_limit/ : /native_config_failed/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_USER_TEXT|missing-config.json/);
  }
});
