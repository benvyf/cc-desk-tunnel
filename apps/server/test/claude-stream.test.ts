import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { ClaudeStream, shownToday } from '../src/claude-stream.ts';

test('native partial text/thinking are not duplicated by complete assistant events', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    claude_code_version: '2.1.286',
  });
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
  });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '公开推理' } },
  });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '公开推理' }] },
  });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '实际增量' } },
  });
  stream.accept({ type: 'assistant', message: { content: [{ type: 'text', text: '实际增量' }] } });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: '实际增量' });
  assert.equal(events.filter((event) => event.type === 'text.delta').length, 1);
  assert.equal(events.filter((event) => event.type === 'thinking.delta').length, 1);
  assert.equal(stream.result?.failed, false);
});
test('native Bash input, permission identity and unmodified tool results remain correlated', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  const toolId = 'call_native_not_uuid';
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} },
    },
  });
  stream.accept({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ssh -F config windows"}' },
    },
  });
  stream.accept({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Bash',
          input: { command: 'ssh -F config windows' },
        },
      ],
    },
  });
  assert.equal(stream.tool('Bash', { command: 'ssh -F config windows' }, toolId).id, toolId);
  stream.accept({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          is_error: true,
          content: 'D:\\中文\nExit code 5',
        },
      ],
    },
  });
  assert.equal(events.filter((event) => event.type === 'tool.requested').length, 1);
  const result = events.find((event) => event.type === 'tool.result');
  assert.ok(result?.type === 'tool.result');
  assert.equal(result.toolId, toolId);
  assert.equal(result.exitCode, null);
  assert.equal(result.status, 'failed');
  assert.match(result.output, /D:\\中文/);
});
test('native denials and upstream failures are represented without inventing a policy', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'example' }, 'native-tool').denied = true;
  stream.accept({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'native-tool',
          is_error: true,
          content: 'Permission denied',
        },
      ],
    },
  });
  assert.ok(events.some((event) => event.type === 'tool.result' && event.status === 'denied'));
  stream.accept({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Upstream failed'],
  });
  assert.equal(stream.result?.failed, true);
  assert.ok(
    events.some((event) => event.type === 'run.error' && event.message === 'Upstream failed'),
  );
});
test('identical concurrent native calls keep their IDs and progress uses real SDK events', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'same' }, 'call-1');
  stream.tool('Bash', { command: 'same' }, 'call-2');
  assert.equal(stream.tools.size, 2);
  stream.accept({ type: 'tool_progress', tool_use_id: 'call-2', elapsed_time_seconds: 3 });
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.progress' && event.toolId === 'call-2' && event.elapsedSeconds === 3,
    ),
  );
  stream.accept({ type: 'system', subtype: 'status', status: 'compacting' });
  stream.accept({ type: 'system', subtype: 'status', status: null });
  assert.deepEqual(
    events.filter((event) => event.type === 'native.notice').map((event) => event.text),
    ['compacting'],
  );
  stream.accept({ type: 'system', subtype: 'informational', content: 'Native notice' });
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text === 'Native notice'),
  );
});
test("a call waiting on a foreground task names it; a background task or another agent's call does not", () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'npm test' }, 'call-1');
  const started = { type: 'system', subtype: 'task_started', description: 'npm test' };
  stream.accept({ ...started, task_id: 'b1', tool_use_id: 'call-1', is_backgrounded: false });
  stream.accept({ ...started, task_id: 'b2', tool_use_id: 'call-1', is_backgrounded: true });
  stream.accept({ ...started, task_id: 'b3', tool_use_id: 'elsewhere', is_backgrounded: false });
  stream.accept({ ...started, task_id: 'b4', is_backgrounded: false });
  assert.deepEqual(
    events.filter((event) => event.type === 'tool.task'),
    [{ type: 'tool.task', toolId: 'call-1', taskId: 'b1' }],
  );
});

test('requested and effective native approval modes remain distinct', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event), 'auto');
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    permissionMode: 'default',
  });
  const init = events.find((event) => event.type === 'native.session');
  assert.ok(init?.type === 'native.session');
  assert.equal(init.requestedPermissionMode, 'auto');
  assert.equal(init.permissionMode, 'default');
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text.includes('default')),
  );
});

test('native compact metadata and effective effort are forwarded without local summarization', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event), 'plan', 'high');
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    permissionMode: 'plan',
    effort: 'medium',
  });
  stream.accept({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 5432 },
  });
  const session = events.find((event) => event.type === 'native.session');
  assert.ok(session?.type === 'native.session');
  assert.equal(session.requestedEffort, 'high');
  assert.equal(session.effort, 'medium');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'native.compact' &&
        event.previousTokens === 5432 &&
        event.trigger === 'manual',
    ),
  );
});

test('the model requests of a turn are counted from their start events', () => {
  const stream = new ClaudeStream(() => {});
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({ type: 'stream_event', event: { type: 'message_stop' } });
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(stream.requests, 2);
  stream.requests = 0;
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(stream.requests, 1);
});

test('what a local command printed becomes a reply of its own, without terminal colours', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'local_command_output',
    content: '\u001b[1mContext\u001b[0m 12%',
    uuid: randomUUID(),
    session_id: randomUUID(),
  });
  assert.equal(events.length, 1);
  assert.ok(events[0].type === 'text.delta');
  assert.equal(events[0].text, '```text\nContext 12%\n```');
});

test('a local command that prints plain text is shown as printed, its dollars no formula', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  const usage =
    'Total cost:            $0.0919 (costs may be inaccurate)\nUsage by model:\n  gpt-5.6-terra:  16.2k input ($0.0919)';
  stream.accept({ type: 'assistant', message: { content: [{ type: 'text', text: usage }] } });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: usage });
  // A reply of the model that is plain text stays as it came.
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '$x$ 是变量' }] },
  });
  const texts = events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
  assert.deepEqual(texts, ['```text\n' + usage + '\n```', '$x$ 是变量']);
});

test('a local command answered after a streamed reply is shown as a reply of its own', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '模型的回答' } },
  });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '模型的回答' }] },
  });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: '模型的回答' });
  // Claude Code 2.1.293 answers /context and /usage with a whole message, and no model request before it.
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '## Context Usage' }] },
  });
  stream.accept({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '## Context Usage',
  });
  const texts = events.filter((event) => event.type === 'text.delta');
  assert.deepEqual(
    texts.map((event) => event.text),
    ['模型的回答', '## Context Usage'],
  );
  assert.notEqual(texts[0].messageId, texts[1].messageId);
});

// Ported from upstream c619dd1: CLI 2.1.321 says on its way out that a full disk kept it from saving the session.
test('a CLI that could not save what it wrote on exit is told in the conversation', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'session_writes_lost',
    error_code: 'ENOSPC',
    lost: ['transcript'],
    transcript_session_ids: ['x'],
  });
  stream.accept({
    type: 'system',
    subtype: 'session_writes_lost',
    error_code: 'EDQUOT',
    lost: ['global_config'],
  });
  const notices = events.flatMap((event) => (event.type === 'native.notice' ? [event.text] : []));
  assert.equal(notices.length, 2);
  assert.match(notices[0], /磁盘已满.*会话记录缺了一部分/);
  assert.match(notices[1], /磁盘配额已用完.*~\/\.claude\.json/);
});

test('the gateway notice of auto mode is shown once a day, other notices every time', () => {
  const billing =
    "We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through api.example.com.";
  const day = 86_400_000;
  assert.equal(shownToday(billing, 10 * day), false);
  assert.equal(shownToday(billing, 10 * day + 1000), true);
  assert.equal(shownToday(billing, 11 * day - 1), true);
  assert.equal(shownToday(billing, 11 * day), false);
  assert.equal(shownToday('Native notice', 11 * day), false);
  assert.equal(shownToday('Native notice', 11 * day), false);
});

test('a subagent’s calls, words and results are named by the Agent call that started them', async () => {
  const { clipped, SUBAGENT_OUTPUT_LIMIT } = await import('../src/claude-stream.ts');
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: {} }] },
  });
  const main = stream.messageId;
  stream.accept({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'agent',
    description: 'd',
    is_backgrounded: false,
  });
  // The subagent's prompt echo and its streaming are not shown, nor are its requests counted.
  stream.accept({
    type: 'user',
    parent_tool_use_id: 'agent',
    message: { content: [{ type: 'text', text: '子代理收到的提示' }] },
  });
  stream.accept({
    type: 'stream_event',
    parent_tool_use_id: 'agent',
    event: { type: 'message_start' },
  });
  stream.accept({
    type: 'stream_event',
    parent_tool_use_id: 'agent',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '流' } },
  });
  stream.streamed = true;
  stream.accept({
    type: 'assistant',
    parent_tool_use_id: 'agent',
    message: {
      content: [
        { type: 'thinking', thinking: '子代理在想' },
        { type: 'text', text: '先看目录' },
        { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/a' } },
      ],
    },
  });
  stream.accept({
    type: 'user',
    parent_tool_use_id: 'agent',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read',
          content: [
            { type: 'text', text: 'x'.repeat(SUBAGENT_OUTPUT_LIMIT + 5) },
            { type: 'image' },
          ],
        },
      ],
    },
  });
  stream.accept({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'y'.repeat(9000) }],
    },
  });
  assert.equal(stream.requests, 1);
  assert.equal(stream.messageId, main);
  assert.equal(
    events.filter((event) => event.type === 'text.delta' && event.text === '流').length,
    0,
  );
  const text = events.find((event) => event.type === 'text.delta');
  const thinking = events.find((event) => event.type === 'thinking.delta');
  assert.deepEqual(
    [
      text?.type === 'text.delta' && text.parentToolId,
      thinking?.type === 'thinking.delta' && thinking.parentToolId,
    ],
    ['agent', 'agent'],
  );
  assert.notEqual(text?.type === 'text.delta' && text.messageId, main);
  const requested = events.filter((event) => event.type === 'tool.requested');
  assert.deepEqual(
    requested.map((event) => event.type === 'tool.requested' && [event.toolId, event.parentToolId]),
    [
      ['agent', undefined],
      ['read', 'agent'],
    ],
  );
  const results = events.filter((event) => event.type === 'tool.result');
  const read = results[0].type === 'tool.result' ? results[0].output : '';
  assert.ok(read.startsWith('x'.repeat(SUBAGENT_OUTPUT_LIMIT)));
  assert.match(read, /已截断，共 8,013 字符/);
  assert.ok(!read.includes('[image]'), 'the picture is past the limit');
  // The Agent call's own result, the subagent's answer, is whole.
  assert.equal(results[1].type === 'tool.result' && results[1].output, 'y'.repeat(9000));
  assert.equal(clipped('short'), 'short');
  assert.equal(clipped('abcdef', 3), 'abc\n…（已截断，共 6 字符）');
});

test('a subagent’s call asked about before its message is placed under its Agent call', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Agent', {}, 'agent');
  stream.accept({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task-1',
    tool_use_id: 'agent',
    description: 'd',
  });
  // Known by its task: placed from the start.
  stream.tool('Bash', { command: 'ls' }, 'early', stream.parentOf('task-1'));
  // Not known: placed when the CLI's message names it.
  stream.tool('Bash', { command: 'pwd' }, 'late', stream.parentOf('unknown'));
  stream.accept({
    type: 'assistant',
    parent_tool_use_id: 'agent',
    message: {
      content: [
        { type: 'tool_use', id: 'early', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'late', name: 'Bash', input: { command: 'pwd' } },
      ],
    },
  });
  const early = events.find((event) => event.type === 'tool.requested' && event.toolId === 'early');
  assert.equal(early?.type === 'tool.requested' && early.parentToolId, 'agent');
  const inputs = events.filter((event) => event.type === 'tool.input');
  assert.deepEqual(
    inputs.map((event) => event.type === 'tool.input' && [event.toolId, event.parentToolId]),
    [
      ['early', undefined],
      ['late', 'agent'],
    ],
  );
  assert.equal(stream.parentOf(undefined), undefined);
});

test('a subagent’s result keeps its text and names what is not text', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Agent', {}, 'agent');
  stream.accept({
    type: 'assistant',
    parent_tool_use_id: 'agent',
    message: { content: [{ type: 'tool_use', id: 'shot', name: 'Screenshot', input: {} }] },
  });
  stream.accept({
    type: 'user',
    parent_tool_use_id: 'agent',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'shot',
          content: [
            { type: 'text', text: '截图如下' },
            { type: 'image', source: { data: 'AAAA' } },
          ],
        },
      ],
    },
  });
  const result = events.find((event) => event.type === 'tool.result');
  assert.equal(result?.type === 'tool.result' && result.output, '截图如下\n[image]');
});
