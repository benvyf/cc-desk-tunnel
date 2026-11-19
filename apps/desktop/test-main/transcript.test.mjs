import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation, keepTurns } from '../src/transcript.ts';

let sequence = 0;
const at = (second) => new Date(Date.UTC(2026, 9, 26, 12, 0, second)).toISOString();
const event = (runId, second, payload) => ({
  sessionId: 'session',
  runId,
  sequence: ++sequence,
  createdAt: at(second),
  payload,
});
const said = (runId, second, messageId, text) =>
  event(runId, second, { type: 'text.delta', messageId, text });

test('a finished terminal turn becomes an answer while the terminal remains open', () => {
  const events = [
    event('terminal', 0, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'working',
      connectionId: 'c',
    }),
    event('terminal', 1, { type: 'message.user', messageId: 'q', text: '问', scenario: 'chat' }),
    said('terminal', 2, 'answer', '已经完成的回答'),
    event('terminal', 3, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'idle',
      connectionId: 'c',
    }),
  ];
  assert.equal(conversation(events)[0].answer?.text, '已经完成的回答');
  assert.equal(conversation(events)[0].endedAt, at(2));
  const nextWorking = event('terminal', 4, {
    type: 'run.status',
    status: 'running',
    surface: 'terminal',
    activity: 'working',
    connectionId: 'c',
  });
  assert.equal(conversation([...events, nextWorking])[0].answer?.text, '已经完成的回答');
  const running = [
    ...events,
    event('terminal', 4, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'working',
      connectionId: 'c',
    }),
    event('terminal', 4, {
      type: 'message.user',
      messageId: 'next',
      text: '继续问',
      scenario: 'chat',
    }),
    said('terminal', 5, 'next-answer', '尚在输出'),
  ];
  assert.equal(conversation(running).at(-1).endedAt, undefined);
});

test('an older terminal idle cannot finish a later-imported question while the CLI is working', () => {
  const events = [
    event('terminal', 0, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'working',
      connectionId: 'c',
    }),
    event('terminal', 1, {
      type: 'message.user',
      messageId: 'first',
      text: 'first question',
      scenario: 'chat',
    }),
    said('terminal', 2, 'answer-one', 'first answer'),
    event('terminal', 5, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'idle',
      connectionId: 'c',
    }),
    event('terminal', 6, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'working',
      connectionId: 'c',
    }),
    event('terminal', 4, {
      type: 'message.user',
      messageId: 'second',
      text: 'second question',
      scenario: 'chat',
    }),
    said('terminal', 7, 'answer-two', 'still writing'),
  ];
  const turns = conversation(events);
  assert.equal(turns[0].answer?.text, 'first answer');
  assert.equal(turns[1].endedAt, undefined);
  assert.equal(turns[1].answer, undefined);
});

test('terminal notes follow the completed answer without changing its duration or joining its next question', () => {
  const events = [
    event('terminal', 0, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'working',
      connectionId: 'c',
    }),
    event('terminal', 1, {
      type: 'message.user',
      messageId: 'q1',
      text: 'first',
      scenario: 'chat',
    }),
    event('terminal', 3, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'idle',
      connectionId: 'c',
    }),
    said('terminal', 4, 'answer', 'late final answer'),
    event('terminal', 8, { type: 'native.notice', text: '在终端里执行了 /model' }),
  ];
  const first = conversation(events)[0];
  assert.equal(first.answer?.text, 'late final answer');
  assert.equal(first.endedAt, at(4));
  assert.equal(first.notices[0].text, '在终端里执行了 /model');
  const turns = conversation([
    ...events,
    event('terminal', 10, {
      type: 'message.user',
      messageId: 'q2',
      text: 'second',
      scenario: 'chat',
    }),
  ]);
  assert.equal(turns[1].joined, false);
  assert.equal(turns[1].endedAt, undefined);
});

test('a terminal manual compact finishes on its boundary even without another Stop hook', () => {
  const turns = conversation([
    event('terminal', 0, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity: 'idle',
      connectionId: 'c',
    }),
    event('terminal', 1, {
      type: 'message.user',
      messageId: 'compact',
      text: '/compact',
      scenario: 'chat',
    }),
    event('terminal', 2, { type: 'native.compact', trigger: 'manual', previousTokens: 31000 }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].endedAt, at(2));
  assert.equal(turns[0].steps[0].kind, 'compact');
  assert.equal(turns[0].answer, undefined);
});

test('an automatic compaction is one mark among the steps, with what came after it under it', () => {
  const turns = conversation([
    event('run', 0, { type: 'message.user', messageId: 'question', text: '做事' }),
    said('run', 1, 'before', '压缩前'),
    event('run', 2, { type: 'native.notice', text: 'compacting' }),
    event('run', 3, { type: 'native.notice', text: 'compacting' }),
    event('run', 4, { type: 'native.notice', text: 'compacting' }),
    event('run', 5, { type: 'native.notice', text: 'status' }),
    event('run', 6, { type: 'native.compact', trigger: 'auto', previousTokens: 468496 }),
    said('run', 7, 'after', '压缩后'),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].steps.map((step) => step.kind),
    ['assistant', 'compact', 'assistant'],
  );
  const mark = turns[0].steps[1];
  assert.equal(mark.at, at(2));
  assert.equal(mark.endedAt, at(6));
  assert.equal(mark.previousTokens, 468496);
  assert.deepEqual(turns[0].notices, []);
});

test('"continue" takes the stopped turn up again instead of starting one of its own', () => {
  const stats = (messageId, outputTokens, outputPerSecond) => ({
    type: 'turn.stats',
    messageId,
    requests: 1,
    inputTokens: 1,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelMs: 1000,
    ttftMs: 100,
    outputPerSecond,
    partial: false,
  });
  const turns = conversation([
    event('first', 0, { type: 'message.user', messageId: 'question', text: '做事' }),
    said('first', 1, 'one', '第一段'),
    event('first', 2, { type: 'run.status', status: 'cancelled', reason: '用户停止' }),
    event('first', 2, stats('question', 100, 100)),
    event('second', 62, {
      type: 'message.user',
      messageId: 'again',
      text: '继续',
      continued: true,
    }),
    said('second', 63, 'two', '第二段'),
    event('second', 64, { type: 'run.status', status: 'completed' }),
    event('second', 64, stats('again', 300, 100)),
  ]);
  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.question.text, '做事');
  assert.deepEqual(
    turn.steps.map((step) => step.kind),
    ['assistant', 'notice'],
  );
  assert.equal(turn.answer.text, '第二段');
  assert.equal(turn.outcome, undefined);
  assert.equal(turn.pausedMs, 60000);
  assert.equal(turn.stats.outputTokens, 400);
  assert.equal(turn.stats.outputPerSecond, 100);
});

test("a terminal's turns are marked, and each ends with the last thing recorded of it, not with the terminal", () => {
  const turns = conversation([
    event('terminal', 0, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      connectionId: 'c',
    }),
    event('terminal', 10, {
      type: 'message.user',
      messageId: 'first',
      text: '终端里问的',
      scenario: 'chat',
    }),
    said('terminal', 12, 'one', '第一个回答'),
    event('terminal', 20, {
      type: 'message.user',
      messageId: 'second',
      text: '再问',
      scenario: 'chat',
    }),
    said('terminal', 25, 'two', '第二个回答'),
    event('terminal', 59, {
      type: 'run.status',
      status: 'completed',
      surface: 'terminal',
      connectionId: 'c',
    }),
    event('chat', 59, {
      type: 'message.user',
      messageId: 'chat',
      text: '图形界面里问的',
      scenario: 'chat',
    }),
  ]);
  assert.deepEqual(
    turns.map((turn) => [turn.question.terminal ?? false, turn.endedAt, turn.answer?.text]),
    [
      [true, at(12), '第一个回答'],
      [true, at(25), '第二个回答'],
      [false, undefined, undefined],
    ],
  );
});

test('a subagent’s steps go under its call and are not the turn’s steps, tools or answer', async () => {
  const { calls, transcript } = await import('../src/transcript.ts');
  const tool = (second, toolId, parentToolId) =>
    event('run-a', second, {
      type: 'tool.requested',
      toolId,
      name: toolId === 'agent' || toolId === 'inner' ? 'Agent' : 'Read',
      input: '{}',
      target: 'Linux',
      ...(parentToolId ? { parentToolId } : {}),
    });
  const done = (second, toolId) =>
    event('run-a', second, {
      type: 'tool.result',
      toolId,
      status: 'completed',
      output: toolId,
      exitCode: null,
    });
  const events = [
    event('run-a', 0, { type: 'message.user', messageId: 'q', text: '问', scenario: 'chat' }),
    tool(1, 'agent'),
    event('run-a', 2, {
      type: 'text.delta',
      messageId: 'sub-1',
      text: '子代理的话',
      parentToolId: 'agent',
    }),
    event('run-a', 2, {
      type: 'thinking.delta',
      messageId: 'sub-2',
      text: '子代理在想',
      parentToolId: 'agent',
    }),
    tool(3, 'read-1', 'agent'),
    done(4, 'read-1'),
    tool(5, 'inner', 'agent'),
    tool(6, 'read-2', 'inner'),
    // Asked about before its subagent was known, then placed.
    tool(7, 'late'),
    event('run-a', 8, {
      type: 'tool.input',
      toolId: 'late',
      input: '{"a":1}',
      parentToolId: 'agent',
    }),
    // A subagent's words whose call is not there go nowhere.
    event('run-a', 9, {
      type: 'text.delta',
      messageId: 'lost',
      text: '无主',
      parentToolId: 'missing',
    }),
    done(10, 'agent'),
    said('run-a', 11, 'answer', '主线回答'),
    event('run-a', 12, { type: 'run.status', status: 'completed', connectionId: 'c' }),
  ];
  const [turn] = conversation(events);
  assert.equal(turn.answer?.text, '主线回答');
  assert.equal(turn.tools, 1);
  const work = turn.steps.find((step) => step.kind === 'work');
  assert.deepEqual(
    work.items.map((item) => item.id),
    ['agent'],
  );
  const agent = work.items[0];
  assert.deepEqual(
    agent.children.map((item) => [item.kind, item.id]),
    [
      ['assistant', 'sub-1'],
      ['thinking', 'thinking-sub-2'],
      ['tool', 'read-1'],
      ['tool', 'inner'],
      ['tool', 'late'],
    ],
  );
  assert.equal(agent.children[2].output, 'read-1');
  assert.equal(agent.children[4].input, '{"a":1}');
  assert.equal(agent.children[4].parentId, 'agent');
  assert.deepEqual(
    agent.children[3].children.map((item) => item.id),
    ['read-2'],
  );
  assert.deepEqual(
    calls([agent]).map((item) => item.id),
    ['agent', 'read-1', 'inner', 'read-2', 'late'],
  );
  assert.ok(!transcript(events).some((item) => item.id === 'lost'));
});

test('steps recorded before subagents were placed stay where they were', () => {
  const plain = [
    event('run-b', 0, { type: 'message.user', messageId: 'q2', text: '问', scenario: 'chat' }),
    event('run-b', 1, {
      type: 'tool.requested',
      toolId: 'a',
      name: 'Agent',
      input: '{}',
      target: 'Linux',
    }),
    event('run-b', 2, {
      type: 'tool.requested',
      toolId: 'r',
      name: 'Read',
      input: '{}',
      target: 'Linux',
    }),
    said('run-b', 3, 'ans', '答'),
    event('run-b', 4, { type: 'run.status', status: 'completed', connectionId: 'c' }),
  ];
  const [turn] = conversation(plain);
  assert.equal(turn.tools, 2);
  assert.deepEqual(
    turn.steps[0].items.map((item) => [item.id, item.children]),
    [
      ['a', undefined],
      ['r', undefined],
    ],
  );
});

test('an approval asked deep in a subagent is what its step waits on', async () => {
  const { summarize } = await import('../src/activity.ts');
  const events = [
    event('run-c', 0, { type: 'message.user', messageId: 'q3', text: '问', scenario: 'chat' }),
    event('run-c', 1, {
      type: 'tool.requested',
      toolId: 'ag',
      name: 'Agent',
      input: '{}',
      target: 'Linux',
    }),
    event('run-c', 2, {
      type: 'tool.requested',
      toolId: 'bash',
      name: 'Bash',
      input: '{}',
      target: 'Linux',
      parentToolId: 'ag',
    }),
    event('run-c', 3, { type: 'approval.requested', approvalId: 'ap', toolId: 'bash' }),
  ];
  const work = conversation(events)[0].steps.find((step) => step.kind === 'work');
  const { waiting, label } = summarize(work, true, true);
  assert.equal(waiting, true);
  assert.equal(label, '等待审批');
});

test('a reply keeps the model of its first piece that named one', () => {
  const events = [
    event('run-m', 0, { type: 'message.user', messageId: 'qm', text: '问', scenario: 'chat' }),
    event('run-m', 1, {
      type: 'text.delta',
      messageId: 'am',
      text: '一',
      model: 'claude-opus-4-7',
    }),
    event('run-m', 2, { type: 'text.delta', messageId: 'am', text: '二' }),
    event('run-m', 3, { type: 'run.status', status: 'completed', connectionId: 'c' }),
  ];
  const [turn] = conversation(events);
  assert.equal(turn.answer.text, '一二');
  assert.equal(turn.answer.model, 'claude-opus-4-7');
  assert.equal(
    conversation([events[0], said('run-m', 1, 'x', '旧'), events[3]])[0].answer.model,
    undefined,
  );
});

test('two models among a session’s replies, a step’s included, are many; a snapshot of one is one', async () => {
  const { manyModels } = await import('../src/transcript.ts');
  const { modelName } = await import('../src/modelName.ts');
  const name = (model) => modelName(undefined, model);
  const run = (runId, second, steps) => [
    event(runId, second, {
      type: 'message.user',
      messageId: `q-${runId}`,
      text: '问',
      scenario: 'chat',
    }),
    ...steps.map(([id, model], index) =>
      event(runId, second + 1 + index, { type: 'text.delta', messageId: id, text: id, model }),
    ),
    event(runId, second + 5, { type: 'run.status', status: 'completed', connectionId: 'c' }),
  ];
  // A step on one model, the answer on another, in one turn.
  const mixed = conversation(
    run('mx', 0, [
      ['step', 'claude-sonnet-4-6'],
      ['ans', 'claude-opus-4-7'],
    ]).flatMap((item, index, all) =>
      index === 1
        ? [
            item,
            event('mx', 1, {
              type: 'tool.requested',
              toolId: 'tt',
              name: 'Read',
              input: '{}',
              target: 'Linux',
            }),
          ]
        : [item],
    ),
  );
  assert.equal(manyModels(mixed, name), true);
  const same = conversation([
    ...run('s1', 10, [['a1', 'claude-opus-4-7']]),
    ...run('s2', 20, [['a2', 'claude-opus-4-7-20260101']]),
  ]);
  assert.equal(manyModels(same, name), false);
});

test('turns drawn again are taken back as they were unless they changed', () => {
  const turn = (run, second) => [
    event(run, second, { type: 'run.status', status: 'running', connectionId: 'c' }),
    event(run, second, {
      type: 'message.user',
      messageId: `q-${run}`,
      text: run,
      scenario: 'chat',
    }),
    event(run, second + 1, {
      type: 'tool.requested',
      toolId: `t-${run}`,
      name: 'Write',
      input: JSON.stringify({ file_path: `D:\\${run}.ts` }),
      target: 'Windows',
    }),
  ];
  const done = (run, second) => [
    event(run, second, {
      type: 'tool.result',
      toolId: `t-${run}`,
      status: 'completed',
      output: 'ok',
      exitCode: null,
    }),
    said(run, second, `a-${run}`, `回答 ${run}`),
    event(run, second + 1, { type: 'run.status', status: 'completed', connectionId: 'c' }),
  ];
  let events = [...turn('one', 0), ...done('one', 2), ...turn('two', 10)];
  const first = conversation(events);
  const again = keepTurns(first, conversation(events));
  assert.equal(again, first, 'nothing changed: the same list');

  // The second turn's call returns: only that turn is another.
  events = [
    ...events,
    event('two', 12, {
      type: 'tool.result',
      toolId: 't-two',
      status: 'completed',
      output: 'ok',
      exitCode: null,
    }),
  ];
  const drawn = conversation(events);
  const kept = keepTurns(again, drawn);
  assert.notEqual(kept, again);
  assert.equal(kept[0], again[0], 'the finished turn is kept');
  assert.notEqual(kept[1], again[1]);
  assert.deepEqual(kept, drawn, 'what is kept is what was drawn');

  // Stats arriving late, and a new turn, change only what they touch.
  events = [
    ...events,
    ...done('two', 13).slice(1),
    event('one', 20, {
      type: 'turn.stats',
      messageId: 'q-one',
      durationMs: 1000,
      inputTokens: 1,
      outputTokens: 1,
    }),
  ];
  const later = conversation(events);
  const next = keepTurns(kept, later);
  assert.deepEqual(next, later);
  assert.ok(later[0].stats, 'the stats reach the first turn');
  assert.notEqual(next[0], kept[0], 'a turn whose stats came is another');
  // A turn gone (history replaced) is not taken back.
  const replaced = conversation(turn('three', 30));
  const after = keepTurns(next, replaced);
  assert.deepEqual(after, replaced);
  assert.equal(after.length, 1);
});

test('a key set to undefined is not taken for a key left out', () => {
  const kept = [{ id: 'a', steps: [], endedAt: 't', outcome: undefined }];
  const next = [{ id: 'a', steps: [], endedAt: 't', stats: { requests: 1 } }];
  const result = keepTurns(kept, next);
  assert.notEqual(result, kept);
  assert.equal(result[0], next[0]);
});
