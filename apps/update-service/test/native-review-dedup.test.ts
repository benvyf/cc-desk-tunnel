import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { questions } from '../src/jev.ts';
import { ModerationStore } from '../src/moderation.ts';
import { NodeReviews } from '../src/moderation-nodes.ts';
import { nativeReviewText } from '../../server/src/native-moderation-hook.ts';

test('exact input shares approval across entry points; new input, policy and session require review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-native-dedup-'));
  await mkdir(join(root, 'private'));
  const store = await ModerationStore.open(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const edit = () => {
    const { apiKeyConfigured, enforcement, rulesVersion, ...value } = store.config();
    return value;
  };
  store.save({ ...edit(), mode: 'api_only', apiKey: 'synthetic_fixture_key' }, 'fixture');
  const review = store.review.bind(store);
  let calls = 0;
  let mode: 'allow' | 'deny' | 'error' = 'allow';
  const fetcher: typeof fetch = async () => {
    calls++;
    // Yield to prove simultaneous tool hooks share the in-flight review.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (mode === 'error') throw new Error('synthetic provider failure');
    return Response.json({
      model: 'synthetic-jev',
      usage: { input_tokens: 100, output_tokens: 10 },
      answers: Object.fromEntries(
        Object.keys(questions).map((name) => [
          name,
          { type: 'noul', noul: mode === 'deny' ? 1 : 0 },
        ]),
      ),
    });
  };
  store.review = (text, actor, kind, context) => review(text, actor, kind, context, fetcher);
  const reviews = new NodeReviews();
  const value = {
    nodeId: 'node-1',
    requestId: 'prompt-1',
    sessionId: 'session-1',
    deviceId: 'native-terminal',
    kind: 'message.send',
    text: 'one unchanged user question',
  };
  const first = await reviews.check('node-1', value, store);
  assert.equal(first.allowed, true);
  for (let n = 0; n < 8; n++)
    assert.deepEqual(
      await reviews.check(
        'node-1',
        { ...value, requestId: `batch-${n}`, kind: 'approval.reply' },
        store,
      ),
      first,
    );
  assert.equal(calls, 1);
  assert.equal(store.usage().requests, 1);
  assert.equal(store.events().filter((event) => event.kind === 'node.review').length, 1);
  await assert.rejects(
    reviews.check('node-1', { ...value, text: 'conflicting request' }, store),
    /conflict/,
  );
  const changed = { ...value, text: value.text + '\nnew user answer', requestId: 'new-prompt' };
  const concurrent = await Promise.all([
    reviews.check('node-1', changed, store),
    reviews.check(
      'node-1',
      { ...changed, requestId: 'new-batch', deviceId: 'desktop', kind: 'approval.reply' },
      store,
    ),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(calls, 2);
  await reviews.check(
    'node-1',
    { ...changed, sessionId: 'other-session', requestId: 'session-2' },
    store,
  );
  await reviews.check('node-2', { ...changed, nodeId: 'node-2', requestId: 'node-2' }, store);
  assert.equal(calls, 4);
  assert.deepEqual(
    await reviews.check(
      'node-1',
      { ...value, requestId: 'return-first', deviceId: 'desktop' },
      store,
    ),
    first,
  );
  assert.equal(calls, 4, 'A -> B -> A retains the earlier exact approval');
  store.save({ ...edit(), apiKey: null }, 'fixture');
  // Reusing the exact request ID cannot retain an approval across a policy revision.
  await reviews.check('node-1', changed, store);
  assert.equal(calls, 5);
  await reviews.check(
    'node-1',
    { ...changed, requestId: 'ordinary-1', deviceId: 'desktop' },
    store,
  );
  await reviews.check(
    'node-1',
    { ...changed, requestId: 'ordinary-2', deviceId: 'desktop' },
    store,
  );
  assert.equal(calls, 5, 'Ordinary and native entry points share the same exact approval');
  mode = 'deny';
  const denied = { ...changed, text: 'synthetic denied input', requestId: 'denied-1' };
  assert.equal((await reviews.check('node-1', denied, store)).allowed, false);
  assert.equal(
    (await reviews.check('node-1', { ...denied, requestId: 'denied-2' }, store)).allowed,
    false,
  );
  assert.equal(calls, 7, 'Denied inputs never become reusable approvals');
  mode = 'error';
  const failure = { ...changed, text: 'synthetic unavailable input', requestId: 'error-1' };
  assert.equal((await reviews.check('node-1', failure, store)).allowed, false);
  mode = 'allow';
  assert.equal(
    (await reviews.check('node-1', { ...failure, requestId: 'error-2' }, store)).allowed,
    true,
  );
  assert.equal(calls, 9, 'Errors cannot be cached as approvals');
});

test('desktop input and native hooks share exact content, while extra history and feedback require review', async () => {
  const reviews = new NodeReviews();
  let calls = 0;
  const store = {
    config: () => ({ revision: 6 }),
    review: async () => ({ id: `fixture-${++calls}`, allowed: true }),
  } as unknown as ModerationStore;
  const value = {
    nodeId: 'node',
    requestId: 'desktop',
    sessionId: 'session',
    deviceId: 'desktop',
    kind: 'message.send',
    text: 'Current question',
  };
  const first = await reviews.check('node', value, store);
  const hook = {
    session_id: 'session',
    transcript_path: '/unused',
    hook_event_name: 'UserPromptSubmit',
    prompt: value.text,
  };
  assert.deepEqual(
    await reviews.check(
      'node',
      { ...value, ...nativeReviewText(hook, ''), requestId: 'native', deviceId: 'native-terminal' },
      store,
    ),
    first,
  );
  assert.equal(calls, 1);
  const history = JSON.stringify({ type: 'user', message: { content: 'Earlier context' } });
  await reviews.check(
    'node',
    {
      ...value,
      ...nativeReviewText(hook, history),
      requestId: 'with-history',
      deviceId: 'native-terminal',
    },
    store,
  );
  assert.equal(calls, 2, 'A single-message approval cannot authorize a larger history');
  const row = (type: string, content: unknown) => JSON.stringify({ type, message: { content } });
  const answers = [
    history,
    row('assistant', [
      { type: 'tool_use', id: 'a', name: 'AskUserQuestion' },
      { type: 'tool_use', id: 'b', name: 'AskUserQuestion' },
    ]),
    row('user', [
      { type: 'tool_result', tool_use_id: 'a', content: 'Answer A' },
      { type: 'tool_result', tool_use_id: 'b', content: 'Answer B' },
    ]),
  ].join('\n');
  const batch = {
    ...hook,
    hook_event_name: 'PostToolBatch',
    tool_calls: [
      { tool_use_id: 'a', tool_name: 'AskUserQuestion', tool_response: 'Answer A' },
      { tool_use_id: 'b', tool_name: 'AskUserQuestion', tool_response: 'Answer B' },
    ],
  };
  const checked = await reviews.check(
    'node',
    {
      ...value,
      ...nativeReviewText(batch, answers),
      requestId: 'answers',
      deviceId: 'native-terminal',
    },
    store,
  );
  const after =
    answers +
    '\n' +
    row('user', [{ type: 'tool_result', tool_use_id: 'c', content: 'ordinary output' }]);
  const ordinary = {
    ...batch,
    tool_calls: [{ tool_use_id: 'c', tool_name: 'Read', tool_response: 'ordinary output' }],
  };
  assert.deepEqual(
    await reviews.check(
      'node',
      {
        ...value,
        ...nativeReviewText(ordinary, after),
        requestId: 'after-answers',
        deviceId: 'native-terminal',
      },
      store,
    ),
    checked,
  );
  assert.equal(calls, 3, 'Persisted answers and the following tool batch pay for one review');
  const amended = after + '\n' + row('user', 'New permission amendment');
  await reviews.check(
    'node',
    {
      ...value,
      ...nativeReviewText(ordinary, amended),
      requestId: 'amended',
      deviceId: 'native-terminal',
    },
    store,
  );
  assert.equal(calls, 4, 'New user permission text must still be reviewed');
});

test('full content cache retains policy-refreshed approvals and evicts the oldest entry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const reviews = new NodeReviews();
  let calls = 0;
  let revision = 1;
  const store = {
    config: () => ({ revision }),
    review: async () => ({ id: `fixture-${++calls}`, allowed: true }),
  } as unknown as ModerationStore;
  let request = 0;
  const check = (text: string) => {
    t.mock.timers.tick(300001); // Expire request-ID entries, independently of the content cache.
    return reviews.check(
      'node',
      {
        nodeId: 'node',
        sessionId: 'session',
        deviceId: 'desktop',
        kind: 'message.send',
        requestId: `request-${++request}`,
        text,
      },
      store,
    );
  };
  const first = await check('text-0');
  for (let n = 1; n < 512; n++) await check(`text-${n}`);
  assert.equal(calls, 512);
  revision++;
  const refreshed = await check('text-0');
  assert.notDeepEqual(refreshed, first, 'A new policy must review the old content again');
  assert.equal(calls, 513);
  await check('text-512');
  assert.equal(calls, 514);
  assert.deepEqual(
    await check('text-0'),
    refreshed,
    'The freshly reviewed approval must survive capacity eviction',
  );
  assert.equal(calls, 514, 'Repeating the refreshed content must not pay for another review');
  await check('text-1');
  assert.equal(calls, 515, 'The oldest approval is evicted and reviewed again');
});
