import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { defaultThresholds, evaluateJev, questions } from '../src/jev.ts';
import { checkText, ModerationStore } from '../src/moderation.ts';

const key = 'test_only_never_a_production_key';
const text = 'private prompt fixture';
const policy = {
  revision: 0,
  mode: 'keyword_and_api' as const,
  keywords: ['BLOCK'],
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  apiKey: key,
  timeoutMs: 1000,
  retentionDays: 7,
  thresholds: { ...defaultThresholds },
};
function answer(score = 0.01) {
  return {
    model: 'jev-fixture-1',
    usage: { input_tokens: 120, output_tokens: 18 },
    answers: Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: 'noul', noul: score }]),
    ),
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cc-moderation-'));
  await mkdir(join(root, 'private'));
  let store = await ModerationStore.open(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get store() {
      return store;
    },
    async reopen() {
      store.close();
      store = await ModerationStore.open(root);
    },
  };
}
function editable(store: ModerationStore) {
  const { apiKeyConfigured, enforcement, rulesVersion, ...value } = store.config();
  return { ...value, apiKey: null as string | null };
}

test('native JEV HTTP contract and threshold boundary use every category and actual response model', async (t) => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/systemone');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(data.model, 'jev-latest');
    assert.equal(data.state, text);
    assert.deepEqual(data.questions, questions);
    const result = answer();
    result.answers.sexual!.noul = defaultThresholds.sexual!;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const fetcher: typeof fetch = (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.redirect, 'error');
    return fetch(`http://127.0.0.1:${address.port}/v1/systemone`, init);
  };
  const result = await checkText(policy, text, fetcher);
  assert.equal(result.allowed, false);
  assert.equal(result.action, 'jev_block');
  assert.equal(result.model, 'jev-fixture-1');
  assert.deepEqual(result.categories, ['sexual']);
  assert.equal(calls, 1);
});

test('usage totals count reported tokens and unknown failures, survive pruning and never count keyword or missing-key paths', async (t) => {
  const f = await fixture(t);
  const settings = { ...editable(f.store), apiKey: key, keywords: ['BLOCK'] };
  f.store.save(settings, 'admin');
  await f.store.preview('BLOCK', 'admin', async () => {
    throw new Error('must not call');
  });
  assert.equal(f.store.usage().requests, 0);
  const good = await f.store.preview(text, 'admin', async () => Response.json(answer()));
  assert.deepEqual(good.usage, { inputTokens: 120, outputTokens: 18 });
  const missingUsage = { ...answer(), usage: undefined };
  await f.store.preview(text, 'admin', async () => Response.json(missingUsage));
  await f.store.preview(
    text,
    'admin',
    async () => new Response('do not log provider body', { status: 429 }),
  );
  const invalid = { ...answer(), answers: {} };
  const failed = await f.store.preview(text, 'admin', async () => Response.json(invalid));
  assert.equal(failed.allowed, false);
  assert.deepEqual(failed.usage, { inputTokens: 120, outputTokens: 18 });
  const totals = f.store.usage();
  assert.equal(totals.requests, 4);
  assert.equal(totals.errorRequests, 2);
  assert.equal(totals.reportedRequests, 2);
  assert.equal(totals.unreportedRequests, 2);
  assert.equal(totals.inputTokens, 240);
  assert.equal(totals.outputTokens, 36);
  assert.equal(totals.totalTokens, 276);
  assert.equal(totals.remainingBalance, null);
  assert.equal(totals.remainingTokens, null);
  const db = new DatabaseSync(join(f.root, 'private/moderation.sqlite'));
  db.prepare('UPDATE events SET at=0').run();
  db.close();
  assert.deepEqual(f.store.events(), []);
  await f.reopen();
  assert.deepEqual(f.store.usage(), totals);
  f.store.save({ ...editable(f.store), apiKey: '' }, 'admin');
  await f.store.preview(text, 'admin');
  assert.deepEqual(f.store.usage(), totals);
});

test('rule upgrade adds missing policy categories once, preserves credentials and existing thresholds, and conflicts stale edits', async (t) => {
  const f = await fixture(t);
  f.store.save({ ...editable(f.store), apiKey: key }, 'admin');
  const db = new DatabaseSync(join(f.root, 'private/moderation.sqlite'));
  const old = JSON.parse(db.prepare('SELECT value FROM policy WHERE id=1').get()!.value as string);
  delete old.thresholds['policy/jailbreak-extraction'];
  delete old.thresholds['policy/model-distillation'];
  old.thresholds.sexual = 0.42;
  db.prepare('UPDATE policy SET value=? WHERE id=1').run(JSON.stringify(old));
  db.close();
  await f.reopen();
  const migrated = f.store.config();
  assert.equal(migrated.apiKeyConfigured, true);
  assert.equal(migrated.revision, old.revision + 1);
  assert.equal(migrated.thresholds.sexual, 0.42);
  assert.equal(Object.keys(migrated.thresholds).length, 20);
  assert.equal(migrated.thresholds['policy/jailbreak-extraction'], 0.35);
  assert.equal(migrated.thresholds['policy/model-distillation'], 0.35);
  const stale = { ...editable(f.store), revision: old.revision };
  assert.throws(() => f.store.save(stale, 'admin'), /changed/);
  assert.equal(f.store.events().filter((event) => event.kind === 'config.migrated').length, 1);
  await f.reopen();
  assert.equal(f.store.config().revision, migrated.revision);
  assert.equal(f.store.events().filter((event) => event.kind === 'config.migrated').length, 1);
});

test('jailbreak and distillation independently block at the strict boundary and require both answers', async () => {
  for (const category of ['policy/jailbreak-extraction', 'policy/model-distillation']) {
    const response = answer();
    response.answers[category]!.noul = 0.35;
    const blocked = await checkText(policy, text, async () => Response.json(response));
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.categories, [category]);
    response.answers[category]!.noul = 0.34;
    assert.equal(
      (await checkText(policy, text, async () => Response.json(response))).allowed,
      true,
    );
    delete response.answers[category];
    const incomplete = await checkText(policy, text, async () => Response.json(response));
    assert.equal(incomplete.allowed, false);
    assert.equal(incomplete.error, 'jev_response_invalid');
  }
});

test('selected policy blocks keywords without a model call and sends non-hits to JEV', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json(answer());
  };
  assert.equal(
    (await checkText(policy, 'code with bLoCk inside', fetcher)).action,
    'keyword_block',
  );
  assert.equal(calls, 0);
  assert.equal((await checkText(policy, text, fetcher)).allowed, true);
  assert.equal(calls, 1);
  assert.equal((await checkText({ ...policy, mode: 'keyword_only' }, text, fetcher)).allowed, true);
  assert.equal(calls, 1);
  assert.equal(
    (await checkText({ ...policy, mode: 'keyword_triggered_jev' }, text, fetcher)).allowed,
    true,
  );
  assert.equal(calls, 1);
  const apiOnly = await checkText({ ...policy, mode: 'api_only' }, 'BLOCK', fetcher);
  assert.equal(apiOnly.allowed, true);
  assert.equal(apiOnly.matchedKeyword, undefined);
  assert.equal(calls, 2);
});

test('missing keys, HTTP errors, invalid or oversized results and timeout never become permission to proceed', async () => {
  let calls = 0;
  const neverFetch: typeof fetch = async () => {
    calls++;
    throw new Error(key + text);
  };
  const missing = await checkText({ ...policy, apiKey: '' }, text, neverFetch);
  assert.equal(missing.error, 'jev_key_missing');
  assert.equal(missing.allowed, false);
  assert.equal(calls, 0);
  const invalids = [
    {},
    { ...answer(), model: '' },
    { ...answer(), answers: {} },
    { ...answer(), answers: { ...answer().answers, sexual: { type: 'choice', noul: 0 } } },
    { ...answer(), answers: { ...answer().answers, sexual: { type: 'noul', noul: '0' } } },
    answer(1.1),
    answer(-1),
  ];
  const fetchers: (typeof fetch)[] = [
    ...[401, 429, 500, 529].map((status) => async () => new Response(key + text, { status })),
    ...invalids.map((result) => async () => Response.json(result)),
    async () => new Response('not json ' + key + text),
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    neverFetch,
  ];
  for (const fetcher of fetchers) {
    const result = await checkText(policy, text, fetcher);
    assert.equal(result.action, 'error');
    assert.equal(result.allowed, false);
    assert.ok(result.error?.startsWith('jev_'));
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!JSON.stringify(result).includes(text));
  }
  // Keep an event-loop handle while AbortSignal.timeout fires in this isolated fixture.
  const timed: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture timeout not cancelled')), 2000);
      init!.signal!.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error(key));
        },
        { once: true },
      );
    });
  const result = await checkText({ ...policy, timeoutMs: 20 }, text, timed);
  assert.equal(result.error, 'jev_timeout');
  assert.equal(result.allowed, false);
  await assert.rejects(evaluateJev(policy, 'x'.repeat(65537)), /jev_input_invalid/);
});

test('private settings persist, secrets stay masked, stale saves conflict and records omit raw prompts', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.config().mode, 'keyword_and_api');
  assert.equal(f.store.config().enforcement, 'not-connected');
  const initial = editable(f.store);
  const saved = f.store.save({ ...initial, apiKey: key, keywords: ['block'] }, 'admin');
  assert.equal(saved.apiKeyConfigured, true);
  assert.equal(saved.revision, 1);
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.throws(() => f.store.save(initial, 'admin'), /changed/);
  await f.reopen();
  assert.equal(f.store.config().apiKeyConfigured, true);
  f.store.save({ ...editable(f.store), timeoutMs: 2000 }, 'admin');
  let sentKey = '';
  const result = await f.store.preview(text, 'admin', async (_url, init) => {
    sentKey = (init!.headers as Record<string, string>).authorization!;
    return Response.json(answer());
  });
  assert.equal(sentKey, `Bearer ${key}`);
  assert.equal(result.allowed, true);
  const events = f.store.events();
  const preview = events.find((event) => event.id === result.id)!;
  assert.equal(preview.detail.textBytes, Buffer.byteLength(text));
  assert.match(preview.detail.textSha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(events).includes(text));
  assert.ok(!JSON.stringify(events).includes(key));
  assert.equal(preview.revision, 2);
  f.store.save({ ...editable(f.store), apiKey: '' }, 'admin');
  assert.equal(f.store.config().apiKeyConfigured, false);
  const failed = await f.store.preview(text, 'admin');
  assert.equal(failed.allowed, false);
  assert.equal(failed.error, 'jev_key_missing');
});

test('configuration validates contract fields and rejects unsafe URLs, invalid scores and oversized inputs', async (t) => {
  const { store } = await fixture(t);
  const current = editable(store);
  for (const override of [
    { extra: true },
    { mode: 'unknown' },
    { baseUrl: 'http://api.typesafe.ai' },
    { baseUrl: 'https://user:pass@example.invalid' },
    { baseUrl: 'https://api.typesafe.ai/v1' },
    { apiKey: 'key\nAuthorization: injected' },
    { timeoutMs: 0 },
    { retentionDays: 999 },
    { keywords: [''] },
    { thresholds: {} },
    { thresholds: { ...current.thresholds, sexual: NaN } },
  ])
    assert.throws(() => store.save({ ...current, ...override }, 'admin'), /Invalid moderation/);
  await assert.rejects(store.preview('', 'admin'), /Expected non-empty/);
  await assert.rejects(store.preview('x'.repeat(65537), 'admin'), /Expected non-empty/);
  assert.equal(store.config().revision, 0);
});
