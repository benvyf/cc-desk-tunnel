import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { nativeReviewText, reviewNativeHook } from '../src/native-moderation-hook.ts';

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
  assert.match(nativeReviewText(batch, transcript)!.text, /Previous user message/);
  assert.doesNotMatch(nativeReviewText(batch, transcript)!.text, /normal file output/);
  const amendment =
    transcript +
    '\n' +
    JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'text', text: 'BLOCK_AMENDMENT_FIXTURE' }],
      },
    });
  batch.tool_calls = [
    { tool_name: 'Bash', tool_use_id: 'bash-id', tool_response: 'ordinary successful result' },
  ];
  assert.match(nativeReviewText(batch, amendment)!.text, /BLOCK_AMENDMENT_FIXTURE/);
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
