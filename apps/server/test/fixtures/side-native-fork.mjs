import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { WebSocket } from 'ws';

// Use the real SDK's fork/read algorithms over isolated in-memory native transcripts. Only query()
// is simulated: this exercises the server adapter without launching a CLI or contacting a model.
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const transcripts = new Map();
const memory = {
  async load({ sessionId }) {
    return transcripts.get(sessionId);
  },
  async append({ sessionId }, entries) {
    transcripts.set(sessionId, [...(transcripts.get(sessionId) ?? []), ...entries]);
  },
};
const calls = [],
  prompts = [],
  forks = [],
  deleted = [];
let nextFailure,
  beforeFork,
  failNextCopyRead = false,
  failNextDelete = false;
const unreadableCopies = new Set();
function entry(sessionId, type, content, parentUuid = null) {
  return {
    type,
    sessionId,
    uuid: randomUUID(),
    parentUuid,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: { role: type, content },
  };
}
mock.module('@anthropic-ai/claude-agent-sdk', {
  exports: {
    ...sdk,
    getSessionInfo: (id, options) => sdk.getSessionInfo(id, { ...options, sessionStore: memory }),
    getSessionMessages: (id, options) => {
      if (unreadableCopies.delete(id)) throw new Error('Test-only native copy read failure');
      return sdk.getSessionMessages(id, { ...options, sessionStore: memory });
    },
    async forkSession(id, options) {
      forks.push({ id, ...options });
      const hook = beforeFork;
      beforeFork = undefined;
      await hook?.();
      const copied = await sdk.forkSession(id, { ...options, sessionStore: memory });
      if (failNextCopyRead) {
        failNextCopyRead = false;
        unreadableCopies.add(copied.sessionId);
      }
      return copied;
    },
    async deleteSession(id) {
      deleted.push(id);
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error('Test-only native copy cleanup failure');
      }
      transcripts.delete(id);
    },
    query(args) {
      calls.push(args.options);
      const failure = nextFailure;
      nextFailure = undefined;
      return {
        initializationResult: async () => ({ account: {}, models: [], commands: [] }),
        close() {},
        async *[Symbol.asyncIterator]() {
          const id = args.options.resume ?? args.options.sessionId;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: id,
            model: 'fake',
            claude_code_version: 'fake',
          };
          if (failure === 'before-input') throw new Error('Failed before consuming the question');
          const input = (await args.prompt.next()).value;
          prompts.push(input.message.content);
          const native = entry(
            id,
            'user',
            input.message.content,
            transcripts.get(id)?.at(-1)?.uuid,
          );
          native.uuid = input.uuid;
          await memory.append({ sessionId: id }, [native]);
          if (failure === 'after-input') throw new Error('Failed after persisting the question');
          yield {
            type: 'assistant',
            user_message_uuid: input.uuid,
            message: { content: [{ type: 'text', text: 'Side answer' }] },
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            user_message_uuid: input.uuid,
            result: 'Side answer',
            modelUsage: {},
            usage: {},
            num_turns: 1,
          };
        },
      };
    },
  },
});
Object.defineProperty(process, 'platform', { value: 'linux' });
const { createProxyServer } = await import('../../src/server.ts');
const { PROTOCOL_VERSION } = await import('@cc-desk-tunnel/protocol');
const directory = mkdtempSync(join(tmpdir(), 'cc-side-fork-'));
const token = 'fake-native-fork-' + randomUUID();
const server = createProxyServer({
  token,
  dataDir: directory,
  claude: { executable: 'never-executed' },
  tunnel: {},
  reverseProxy: true,
});
const socket = new WebSocket((await server.listen(0)).replace('http', 'ws') + '/ws');
const messages = [];
socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
async function wait(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out: ' + JSON.stringify(messages).slice(0, 1000));
}
async function request(command, ok = true) {
  const requestId = command.requestId ?? randomUUID();
  socket.send(JSON.stringify({ ...command, requestId }));
  const response = await wait((m) => m.type === 'response' && m.requestId === requestId);
  assert.equal(response.ok, ok, JSON.stringify(response));
  return response;
}
const ended = (id, status) =>
  wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === id &&
      m.event.payload.type === 'run.status' &&
      m.event.payload.status === status,
  );
try {
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token,
      deviceName: 'Fake device',
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  await wait((m) => m.type === 'ready');
  const { sessionId: parent } = await request({ type: 'server.session.create', title: 'Main' });
  const run = randomUUID();
  server.store.append(parent, run, {
    type: 'native.session',
    nativeSessionId: parent,
    model: 'fake',
    version: 'fake',
  });
  server.store.append(parent, run, {
    type: 'tool.output',
    toolId: 'large',
    stream: 'stdout',
    text: 'Huge output'.repeat(60_000),
  });
  server.store.append(parent, run, {
    type: 'approval.requested',
    approvalId: randomUUID(),
    toolId: 'large',
  });
  server.store.append(parent, run, {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: randomUUID(),
  });
  const question = entry(parent, 'user', 'Original task');
  const tool = entry(
    parent,
    'assistant',
    [{ type: 'tool_use', id: 'large', name: 'Bash', input: { command: 'echo example' } }],
    question.uuid,
  );
  const output = entry(
    parent,
    'user',
    [{ type: 'tool_result', tool_use_id: 'large', content: 'Huge output'.repeat(60_000) }],
    tool.uuid,
  );
  const answer = entry(
    parent,
    'assistant',
    [{ type: 'text', text: 'Frozen native answer' }],
    output.uuid,
  );
  transcripts.set(parent, [question, tool, output, answer]);
  const sourceSequence = server.store.lastSequence(parent);
  beforeFork = () => {
    // The parent can grow between reading the boundary and copying; those messages must stay out.
    transcripts.get(parent).push(entry(parent, 'assistant', 'Late answer', answer.uuid));
    server.store.append(parent, run, {
      type: 'text.delta',
      messageId: randomUUID(),
      text: 'Late answer',
    });
  };
  const create = {
    type: 'session.side.create',
    requestId: randomUUID(),
    sessionId: parent,
    title: 'Long native side',
  };
  const { sessionId: child } = await request(create);
  assert.equal(calls.length, 0, 'creating a side never starts a model');
  assert.equal(forks[0].upToMessageId, answer.uuid);
  assert.equal(
    forks[0].dir,
    join(directory, 'native', server.store.get(parent).session.nativeRoot),
  );
  const inherited = await sdk.getSessionMessages(child, {
    sessionStore: memory,
    dir: forks[0].dir,
  });
  assert.ok(JSON.stringify(inherited).includes('Huge output'));
  assert.ok(JSON.stringify(inherited).includes('Frozen native answer'));
  assert.ok(!JSON.stringify(inherited).includes('Late answer'));
  assert.notEqual(inherited[0].uuid, question.uuid, 'real SDK remaps native message IDs');
  assert.equal(server.store.get(child).session.sideConversation.throughSequence, sourceSequence);
  assert.equal(server.store.get(child).session.activeRun, null);
  assert.equal(server.store.get(parent).session.activeRun.id, run);
  assert.deepEqual(server.store.snapshot(child).events, []);
  assert.ok(server.store.sideContext(child).length < 200);
  assert.equal((await request(create)).sessionId, child);
  assert.equal(forks.length, 1, 'request retry does not fork again');
  assert.equal((await request({ ...create, title: 'Conflict' }, false)).code, 'request_conflict');
  await request({ type: 'session.subscribe', sessionId: child, retain: true });
  assert.equal(
    (await request({ type: 'run.continue', sessionId: child }, false)).code,
    'side_question_required',
  );
  assert.equal(
    (await request({ type: 'session.compact', sessionId: child }, false)).code,
    'side_question_required',
  );
  assert.equal(calls.length, 0);
  nextFailure = 'before-input';
  await request({ type: 'message.send', sessionId: child, text: 'First question' });
  await ended(child, 'failed');
  assert.ok(server.store.sidePrompt(child));
  await request({
    type: 'message.send',
    sessionId: child,
    text: 'Retry question with selected quote',
  });
  await ended(child, 'completed');
  assert.equal(calls[0].resume, child);
  assert.equal(calls[1].resume, child);
  assert.equal(calls[1].sessionId, undefined);
  assert.ok(prompts[0].length < 1000, 'inherited transcript is not serialized into the prompt');
  assert.match(prompts[0], /Do not continue/);
  assert.ok(prompts[0].endsWith('Retry question with selected quote'));
  await request({ type: 'message.send', sessionId: child, text: 'Later question' });
  await ended(child, 'completed');
  assert.equal(prompts[1], 'Later question');

  const consumed = (
    await request({ type: 'session.side.create', sessionId: child, title: 'Nested native side' })
  ).sessionId;
  nextFailure = 'after-input';
  await request({ type: 'message.send', sessionId: consumed, text: 'Consumed question' });
  await ended(consumed, 'failed');
  assert.match(prompts[2], new RegExp(consumed));
  await request({ type: 'message.send', sessionId: consumed, text: 'Retry consumed question' });
  await ended(consumed, 'completed');
  assert.equal(
    prompts[3],
    'Retry consumed question',
    'native receipt recovery does not duplicate the guard',
  );

  const lost = (
    await request({ type: 'session.side.create', sessionId: parent, title: 'Missing fork' })
  ).sessionId;
  transcripts.delete(lost);
  const queryCount = calls.length;
  await request({ type: 'message.send', sessionId: lost, text: 'Must not start fresh' });
  const missing = await wait(
    (m) =>
      m.type === 'session.event' &&
      m.event.sessionId === lost &&
      m.event.payload.type === 'run.error',
  );
  assert.equal(missing.event.payload.code, 'native_context_missing');
  await ended(lost, 'failed');
  assert.equal(calls.length, queryCount);

  const beforeFailure = server.store.list().length;
  const oldCreate = server.store.createSide;
  server.store.createSide = () => {
    throw new Error('Simulated database write failure');
  };
  const rolledBack = await request(
    { type: 'session.side.create', sessionId: parent, title: 'Rollback' },
    false,
  );
  server.store.createSide = oldCreate;
  assert.equal(rolledBack.code, 'native_side_fork_failed');
  assert.equal(server.store.list().length, beforeFailure);
  assert.ok(deleted.length > 0);
  assert.equal(
    transcripts.has(deleted.at(-1)),
    false,
    'failed proxy write cleans up the native fork',
  );

  const parentEntries = transcripts.get(parent);
  transcripts.delete(parent);
  const unavailable = await request(
    { type: 'session.side.create', sessionId: parent, title: 'Missing source' },
    false,
  );
  assert.equal(unavailable.code, 'native_context_missing');
  assert.equal(
    server.store.list().length,
    beforeFailure,
    'missing native source cannot silently use the oversized UI history',
  );
  transcripts.set(parent, parentEntries);

  const compactParent = (await request({ type: 'server.session.create', title: 'Compacted main' }))
    .sessionId;
  server.store.append(compactParent, randomUUID(), {
    type: 'native.session',
    nativeSessionId: compactParent,
    model: 'fake',
    version: 'fake',
  });
  const compactQuestion = entry(compactParent, 'user', 'Before compaction');
  const compactBoundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: randomUUID(),
    parentUuid: null,
    logicalParentUuid: compactQuestion.uuid,
    sessionId: compactParent,
    timestamp: new Date().toISOString(),
    compactMetadata: { trigger: 'manual', preTokens: 10000 },
  };
  const summary = {
    ...entry(compactParent, 'user', 'Existing native compact summary', compactBoundary.uuid),
    isCompactSummary: true,
  };
  transcripts.set(compactParent, [compactQuestion, compactBoundary, summary]);
  const compactChild = (
    await request({
      type: 'session.side.create',
      sessionId: compactParent,
      title: 'Compacted side',
    })
  ).sessionId;
  assert.ok(transcripts.get(compactChild).some((record) => record.subtype === 'compact_boundary'));
  assert.ok(
    transcripts
      .get(compactChild)
      .some(
        (record) =>
          record.isCompactSummary && record.message.content === 'Existing native compact summary',
      ),
  );
  assert.equal(calls.length, queryCount, 'copying compacted native state does not start a model');

  const safetyParent = (
    await request({ type: 'server.session.create', title: 'Tool boundary main' })
  ).sessionId;
  const safetyRun = randomUUID();
  server.store.append(safetyParent, safetyRun, {
    type: 'native.session',
    nativeSessionId: safetyParent,
    model: 'fake',
    version: 'fake',
  });
  server.store.append(safetyParent, safetyRun, {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: randomUUID(),
  });
  const safeQuestion = entry(safetyParent, 'user', 'Current task');
  const safeText = entry(
    safetyParent,
    'assistant',
    [{ type: 'text', text: 'Safe saved explanation' }],
    safeQuestion.uuid,
  );
  const pendingTools = entry(
    safetyParent,
    'assistant',
    [
      { type: 'tool_use', id: 'parallel-a', name: 'Bash', input: { command: 'test-only a' } },
      { type: 'tool_use', id: 'parallel-b', name: 'Bash', input: { command: 'test-only b' } },
    ],
    safeText.uuid,
  );
  const resultA = entry(
    safetyParent,
    'user',
    [{ type: 'tool_result', tool_use_id: 'parallel-a', content: 'A complete' }],
    pendingTools.uuid,
  );
  const resultB = entry(
    safetyParent,
    'user',
    [{ type: 'tool_result', tool_use_id: 'parallel-b', content: 'B failed', is_error: true }],
    resultA.uuid,
  );
  async function assertSafeFork(title, entries, expectedBoundary, expectedCalls) {
    transcripts.set(safetyParent, entries);
    const before = server.store.snapshot(safetyParent);
    const result = await request({ type: 'session.side.create', sessionId: safetyParent, title });
    assert.equal(forks.at(-1).upToMessageId, expectedBoundary, title);
    const blocks = transcripts
      .get(result.sessionId)
      .flatMap((record) => (Array.isArray(record.message?.content) ? record.message.content : []));
    const uses = blocks.filter((block) => block.type === 'tool_use');
    const results = blocks.filter((block) => block.type === 'tool_result');
    assert.equal(uses.length, expectedCalls, title);
    assert.deepEqual(
      new Set(uses.map((block) => block.id)),
      new Set(results.map((block) => block.tool_use_id)),
      'fork contains no unpaired tool calls',
    );
    assert.deepEqual(
      server.store.snapshot(safetyParent),
      before,
      'boundary selection never changes the running source',
    );
  }
  await assertSafeFork(
    'Waiting for approval',
    [safeQuestion, safeText, pendingTools],
    safeText.uuid,
    0,
  );
  await assertSafeFork(
    'One parallel tool still running',
    [safeQuestion, safeText, pendingTools, resultA],
    safeText.uuid,
    0,
  );
  await assertSafeFork(
    'All parallel tools settled',
    [safeQuestion, safeText, pendingTools, resultA, resultB],
    resultB.uuid,
    2,
  );
  const misleadingText = entry(
    safetyParent,
    'assistant',
    [{ type: 'text', text: 'Text after an open call is not a safe cut' }],
    pendingTools.uuid,
  );
  await assertSafeFork(
    'Open tool followed by text',
    [safeQuestion, safeText, pendingTools, misleadingText],
    safeText.uuid,
    0,
  );
  const orphan = entry(
    safetyParent,
    'user',
    [{ type: 'tool_result', tool_use_id: 'missing-call', content: 'Unmatched result' }],
    safeText.uuid,
  );
  await assertSafeFork('Unmatched result tail', [safeQuestion, safeText, orphan], safeText.uuid, 0);
  const thinking = entry(
    safetyParent,
    'assistant',
    [{ type: 'thinking', thinking: 'Incomplete assistant response', signature: 'test-only' }],
    safeText.uuid,
  );
  await assertSafeFork(
    'Isolated thinking tail',
    [safeQuestion, safeText, thinking],
    safeText.uuid,
    0,
  );

  transcripts.set(safetyParent, [{ ...pendingTools, parentUuid: null }]);
  const beforeUnsafe = server.store.list().length;
  const beforeUnsafeForks = forks.length;
  const unsafe = await request(
    { type: 'session.side.create', sessionId: safetyParent, title: 'No safe prefix' },
    false,
  );
  assert.equal(unsafe.code, 'native_side_no_safe_boundary');
  assert.equal(server.store.list().length, beforeUnsafe);
  assert.equal(
    forks.length,
    beforeUnsafeForks,
    'no native file is copied when no safe prefix exists',
  );

  const compactPending = entry(
    compactParent,
    'assistant',
    [{ type: 'tool_use', id: 'after-compact', name: 'Bash', input: { command: 'test-only' } }],
    summary.uuid,
  );
  transcripts.get(compactParent).push(compactPending);
  const compactSafe = (
    await request({
      type: 'session.side.create',
      sessionId: compactParent,
      title: 'Compacted source with open tool',
    })
  ).sessionId;
  assert.equal(forks.at(-1).upToMessageId, summary.uuid);
  assert.ok(transcripts.get(compactSafe).some((record) => record.subtype === 'compact_boundary'));
  assert.ok(!JSON.stringify(transcripts.get(compactSafe)).includes('after-compact'));
  assert.equal(calls.length, queryCount, 'safe boundary selection never starts a model');

  // The SDK merges sibling blocks for display. Their physical order can still put a tool result past
  // the selected text UUID, so checking only the displayed source prefix is insufficient.
  const siblingA = entry(
    safetyParent,
    'assistant',
    [{ type: 'tool_use', id: 'sibling-a', name: 'Bash', input: {} }],
    safeQuestion.uuid,
  );
  const siblingB = entry(
    safetyParent,
    'assistant',
    [{ type: 'tool_use', id: 'sibling-b', name: 'Bash', input: {} }],
    safeQuestion.uuid,
  );
  siblingA.message.id = siblingB.message.id = 'same-native-answer';
  const siblingResultB = entry(
    safetyParent,
    'user',
    [{ type: 'tool_result', tool_use_id: 'sibling-b', content: 'B finished' }],
    siblingB.uuid,
  );
  const siblingText = entry(
    safetyParent,
    'assistant',
    [{ type: 'text', text: 'Saved answer before a late sibling result' }],
    siblingResultB.uuid,
  );
  siblingText.message.id = 'next-native-answer';
  const siblingResultA = entry(
    safetyParent,
    'user',
    [{ type: 'tool_result', tool_use_id: 'sibling-a', content: 'A finished' }],
    siblingA.uuid,
  );
  const duration = {
    type: 'system',
    subtype: 'turn_duration',
    uuid: randomUUID(),
    parentUuid: siblingText.uuid,
    sessionId: safetyParent,
    timestamp: new Date().toISOString(),
    durationMs: 10,
  };
  transcripts.set(safetyParent, [
    safeQuestion,
    siblingA,
    siblingB,
    siblingResultB,
    siblingText,
    siblingResultA,
    duration,
  ]);
  async function assertUnsafeCopyRejected(title) {
    const count = server.store.list().length;
    const nativeCount = transcripts.size;
    const response = await request(
      { type: 'session.side.create', sessionId: safetyParent, title },
      false,
    );
    assert.equal(response.code, 'native_side_unsafe_copy');
    assert.equal(server.store.list().length, count, 'unsafe copy never enters the session catalog');
    assert.equal(transcripts.size, nativeCount, 'unsafe native copy is removed');
    assert.equal(calls.length, queryCount, 'unsafe copy never starts a model');
  }
  await assertUnsafeCopyRejected('SDK sibling display order differs from file order');
  transcripts.set(safetyParent, [safeQuestion, safeText]);
  beforeFork = () => {
    transcripts.set(safetyParent, [
      safeQuestion,
      {
        ...safeText,
        message: {
          ...safeText.message,
          content: [
            ...safeText.message.content,
            { type: 'tool_use', id: 'changed-during-copy', name: 'Bash', input: {} },
          ],
        },
      },
    ]);
  };
  await assertUnsafeCopyRejected('Source boundary changed during the async copy');

  transcripts.set(safetyParent, [safeQuestion, safeText]);
  const beforeReadFailure = { sessions: server.store.list().length, native: transcripts.size };
  failNextCopyRead = true;
  const unreadable = await request(
    { type: 'session.side.create', sessionId: safetyParent, title: 'Copy read failure' },
    false,
  );
  assert.equal(unreadable.code, 'native_side_fork_failed');
  assert.equal(server.store.list().length, beforeReadFailure.sessions);
  assert.equal(
    transcripts.size,
    beforeReadFailure.native,
    'unreadable copy is removed before replying',
  );

  const beforeDeleteFailure = { sessions: server.store.list().length, native: transcripts.size };
  beforeFork = () => {
    transcripts.set(safetyParent, [
      safeQuestion,
      {
        ...safeText,
        message: {
          ...safeText.message,
          content: [
            ...safeText.message.content,
            { type: 'tool_use', id: 'cleanup-failure-tail', name: 'Bash', input: {} },
          ],
        },
      },
    ]);
  };
  failNextDelete = true;
  const cleanupFailure = await request(
    { type: 'session.side.create', sessionId: safetyParent, title: 'Cleanup failure' },
    false,
  );
  assert.equal(
    cleanupFailure.code,
    'native_side_unsafe_copy',
    'cleanup error must not mask the original unsafe-copy error',
  );
  assert.equal(
    server.store.list().length,
    beforeDeleteFailure.sessions,
    'failed cleanup never publishes an unsafe side',
  );
  assert.equal(transcripts.size, beforeDeleteFailure.native + 1);
  transcripts.delete(deleted.at(-1)); // Remove the deliberately retained lab-only orphan.
  transcripts.set(safetyParent, [safeQuestion, safeText]);
  await request({
    type: 'session.side.create',
    sessionId: safetyParent,
    title: 'Recovered after cleanup failure',
  });
  assert.equal(calls.length, queryCount, 'error paths and recovery never start a model');

  let release, copying;
  const started = new Promise((resolve) => {
    copying = resolve;
  });
  beforeFork = () => {
    copying();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = request({ type: 'session.side.create', sessionId: parent, title: 'Pending' });
  await started;
  assert.equal(
    (await request({ type: 'session.side.create', sessionId: parent, title: 'Concurrent' }, false))
      .code,
    'session_busy',
  );
  assert.equal(
    (await request({ type: 'session.delete', sessionId: parent }, false)).code,
    'session_busy',
  );
  release();
  await pending;
  server.store.append(parent, run, {
    type: 'run.status',
    status: 'completed',
    connectionId: randomUUID(),
  });
  await request({ type: 'session.delete', sessionId: parent });
  assert.equal(transcripts.has(parent), false);
  assert.ok(transcripts.has(child), 'source deletion keeps the independent native fork');
  assert.equal(calls.length, queryCount);
} finally {
  socket.terminate();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
}
