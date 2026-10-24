import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { questions } from '../src/jev.ts';
import { ModerationStore } from '../src/moderation.ts';
import { NodeReviews } from '../src/moderation-nodes.ts';

test('unchanged native input reuses approval across hooks; new input, policy and session require review', async (t) => {
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
    reviews.check('node-1', { ...changed, requestId: 'new-batch', kind: 'approval.reply' }, store),
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
  assert.equal(calls, 7, 'Ordinary user requests keep their existing audit behavior');
  mode = 'deny';
  const denied = { ...changed, text: 'synthetic denied input', requestId: 'denied-1' };
  assert.equal((await reviews.check('node-1', denied, store)).allowed, false);
  assert.equal(
    (await reviews.check('node-1', { ...denied, requestId: 'denied-2' }, store)).allowed,
    false,
  );
  assert.equal(calls, 9, 'Denied inputs never become reusable approvals');
  mode = 'error';
  const failure = { ...changed, text: 'synthetic unavailable input', requestId: 'error-1' };
  assert.equal((await reviews.check('node-1', failure, store)).allowed, false);
  mode = 'allow';
  assert.equal(
    (await reviews.check('node-1', { ...failure, requestId: 'error-2' }, store)).allowed,
    true,
  );
  assert.equal(calls, 11, 'Errors cannot be cached as approvals');
});
