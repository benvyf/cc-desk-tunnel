import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nativeReviewText,
  readNativeTranscript,
  reviewNativeHook,
} from '../src/native-moderation-hook.ts';

const input = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'offline-session',
  transcript_path: '/unused.jsonl',
  prompt: 'Normal current message',
};
const transcript = [
  { type: 'user', message: { content: [{ type: 'text', text: 'Previous user message' }] } },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'question-id' }] },
  },
  {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'question-id', content: 'User answer fixture' },
      ],
    },
  },
]
  .map((row) => JSON.stringify(row))
  .join('\n');

test('native prompt includes prior user messages and answers, without forwarding raw normal tool output', () => {
  const fixture =
    transcript +
    '\n' +
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'read-id', content: 'FILE_OUTPUT_NOT_USER_INPUT' },
        ],
      },
    });
  const value = nativeReviewText(input, fixture)!;
  assert.match(value.text, /Previous user message/);
  assert.match(value.text, /User answer fixture/);
  assert.match(value.text, /Normal current message/);
  assert.doesNotMatch(value.text, /FILE_OUTPUT_NOT_USER_INPUT/);
});

test('native interactive reply and permission failure are reviewed before continuation', () => {
  const batch = {
    ...input,
    hook_event_name: 'PostToolBatch',
    tool_calls: [
      {
        tool_name: 'AskUserQuestion',
        tool_use_id: 'question-id',
        tool_response: 'BLOCK_REPLY_FIXTURE',
      },
    ],
  };
  assert.match(nativeReviewText(batch, transcript)!.text, /BLOCK_REPLY_FIXTURE/);
  const failure =
    transcript +
    '\n' +
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'bash-id',
            content: 'BLOCK_DENIAL_FIXTURE',
            is_error: true,
          },
        ],
      },
    });
  batch.tool_calls = [
    { tool_name: 'Bash', tool_use_id: 'bash-id', tool_response: 'BLOCK_DENIAL_FIXTURE' },
  ];
  assert.match(nativeReviewText(batch, failure)!.text, /BLOCK_DENIAL_FIXTURE/);
  batch.tool_calls = [
    { tool_name: 'Read', tool_use_id: 'read-id', tool_response: 'normal file output' },
  ];
  const ordinary =
    transcript +
    '\n' +
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'read-id', content: 'normal file output' }],
      },
    });
  assert.match(nativeReviewText(batch, ordinary)!.text, /Previous user message/);
  assert.doesNotMatch(nativeReviewText(batch, ordinary)!.text, /normal file output/);
  const amendment =
    transcript +
    '\n' +
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'bash-id', content: 'ordinary successful result' },
          { type: 'text', text: 'BLOCK_AMENDMENT_FIXTURE' },
        ],
      },
    });
  batch.tool_calls = [
    { tool_name: 'Bash', tool_use_id: 'bash-id', tool_response: 'ordinary successful result' },
  ];
  assert.match(nativeReviewText(batch, amendment)!.text, /BLOCK_AMENDMENT_FIXTURE/);
});

test('native batch waits for its persisted result and amendment; stale history cannot be approved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-native-batch-'));
  const path = join(directory, 'history.jsonl');
  const batch = {
    ...input,
    transcript_path: path,
    hook_event_name: 'PostToolBatch',
    tool_calls: [
      { tool_name: 'Bash', tool_use_id: 'current-bash', tool_response: 'ordinary result' },
    ],
  };
  const persisted =
    transcript +
    '\n' +
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'current-bash', content: 'ordinary result' },
          { type: 'text', text: 'BLOCK_LATE_AMENDMENT' },
        ],
      },
    });
  let calls = 0;
  const moderation = {
    endpoint: 'https://offline.invalid/cc-updates/v1/moderation/check',
    nodeId: 'offline-node',
    token: 'x'.repeat(43),
    fetcher: (async (_url, init) => {
      calls++;
      assert.match(JSON.parse(init!.body as string).text, /BLOCK_LATE_AMENDMENT/);
      return Response.json({ id: randomUUID(), allowed: false });
    }) as typeof fetch,
  };
  let save: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;
  try {
    await writeFile(path, transcript);
    await assert.rejects(reviewNativeHook(batch, transcript, moderation), /not been persisted/);
    assert.equal(calls, 0);
    save = setTimeout(() => {
      saving = writeFile(path, persisted);
    }, 150);
    const snapshot = await readNativeTranscript(batch);
    await assert.rejects(reviewNativeHook(batch, snapshot, moderation), /操作失败/);
    assert.equal(calls, 1);
    await writeFile(path, transcript);
    await assert.rejects(readNativeTranscript(batch), /not been persisted/);
    assert.equal(calls, 1, 'Persistence timeout must not retry the review service');
  } finally {
    clearTimeout(save);
    await saving;
    await rm(directory, { recursive: true, force: true });
  }
});

test('native prompt expansion stays restricted; compaction is reviewed and invalid or oversized history refuses', () => {
  assert.throws(
    () =>
      nativeReviewText(
        { ...input, hook_event_name: 'UserPromptExpansion', prompt: '/fixture argument' },
        transcript,
      ),
    /expansion is not supported/,
  );
  assert.match(
    nativeReviewText(
      { ...input, hook_event_name: 'PreCompact', custom_instructions: 'COMPACT_FIXTURE' },
      transcript,
    )!.text,
    /COMPACT_FIXTURE/,
  );
  assert.throws(() => nativeReviewText(input, '{broken'));
  assert.throws(
    () => nativeReviewText({ ...input, prompt: 'x'.repeat(65537) }, transcript),
    /limit/,
  );
  assert.throws(
    () => nativeReviewText({ ...input, hook_event_name: 'Unknown' }, transcript),
    /Unsupported/,
  );
});

test('native hook uses the existing node review contract and refuses denial or unavailable service', async () => {
  const seen: Record<string, unknown>[] = [];
  let allowed = true;
  const moderation = {
    endpoint: 'https://offline.invalid/cc-updates/v1/moderation/check',
    nodeId: 'offline-node',
    token: 'x'.repeat(43),
    fetcher: (async (_url, init) => {
      seen.push(JSON.parse(init!.body as string));
      return Response.json({ id: randomUUID(), allowed });
    }) as typeof fetch,
  };
  assert.deepEqual(await reviewNativeHook(input, transcript, moderation), {});
  assert.equal(seen[0].deviceId, 'native-terminal');
  assert.equal(seen[0].kind, 'message.send');
  allowed = false;
  await assert.rejects(reviewNativeHook(input, transcript, moderation), /操作失败/);
  await assert.rejects(
    reviewNativeHook(input, transcript, {
      ...moderation,
      fetcher: async () => {
        throw new Error('Offline network fixture');
      },
    }),
    /操作失败/,
  );
});
