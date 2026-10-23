// Disposable Linux lab only: real CLI/PTYS, loopback-only model/review stubs, no production account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const marker = 'BLOCK_ANSWER_OFFLINE_FIXTURE';
const cli = process.env.LAB_CLI ?? '/opt/claude/claude';
const reviews = [],
  requests = [];
let scenario;
let asked = false;
const review = createHttpsServer(
  { key: await readFile('/lab/fixture-ca.key'), cert: await readFile('/lab/fixture-ca.crt') },
  async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.equal(request.headers.authorization, 'Bearer ' + 'x'.repeat(43));
    const input = JSON.parse(body);
    reviews.push(input);
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        allowed: scenario === 'resume-seed' || !input.text.includes(marker),
      }),
    );
  },
);
const model = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url.split('?')[0] !== '/v1/messages') {
    response.writeHead(404).end('{}');
    return;
  }
  const input = JSON.parse(body);
  requests.push(input);
  const question =
    scenario === 'question' &&
    !asked &&
    input.tools?.some((tool) => tool.name === 'AskUserQuestion');
  const permission =
    scenario.startsWith('permission') &&
    !asked &&
    input.tools?.some((tool) => tool.name === 'Bash');
  if (question || permission) asked = true;
  const toolName = question ? 'AskUserQuestion' : 'Bash';
  const toolId = question ? 'toolu_offline_question' : 'toolu_offline_permission';
  const toolInput = question
    ? {
        questions: [
          {
            question: 'Which offline fixture color?',
            header: 'Color',
            options: [
              { label: 'Blue', description: 'Fixture blue' },
              { label: 'Green', description: 'Fixture green' },
            ],
            multiSelect: false,
          },
        ],
      }
    : {
        command: 'printf OFFLINE_PERMISSION_FIXTURE > /tmp/offline-permission-fixture.txt',
        description: 'Offline permission fixture',
      };
  if (scenario === 'queue' && input.tools?.length) await delay(2000);
  const stubText = input.output_config?.format?.schema?.properties?.title
    ? '{"title":"Offline fixture"}'
    : 'OFFLINE_STUB_OK';
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_offline_' + requests.length,
        type: 'message',
        role: 'assistant',
        model: 'offline-fixture',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block:
        question || permission
          ? { type: 'tool_use', id: toolId, name: toolName, input: {} }
          : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta:
        question || permission
          ? {
              type: 'input_json_delta',
              partial_json: JSON.stringify(toolInput),
            }
          : { type: 'text_delta', text: stubText },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: question || permission ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise((resolve) => review.listen(18443, '127.0.0.1', resolve));
await new Promise((resolve) => model.listen(18080, '127.0.0.1', resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child,
  output = '';

async function wait(predicate, label) {
  const until = Date.now() + 18000;
  while (Date.now() < until) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(
    'Offline PTY timeout: ' +
      label +
      '\n' +
      JSON.stringify({
        reviews,
        requests: requests.map((value) => ({
          model: value.model,
          hasMarker: JSON.stringify(value.messages).includes(marker),
        })),
      }) +
      '\n' +
      JSON.stringify(output.slice(-5000)),
  );
}
async function start(name, { homeName = name, extraArgs = '' } = {}) {
  scenario = name;
  asked = false;
  output = '';
  reviews.length = 0;
  requests.length = 0;
  const home = '/tmp/pty-' + homeName;
  await mkdir(`${home}/.claude`, { recursive: true });
  if (name === 'skill') {
    await mkdir(`${home}/.claude/commands`, { recursive: true });
    await writeFile(
      `${home}/.claude/commands/audit-fixture.md`,
      `---\ndescription: Offline fixture command\n---\nExpanded offline fixture ${marker}. Arguments: $ARGUMENTS`,
    );
  }
  const fixture = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    customApiKeyResponses: { approved: ['offline-placeholder-not-a-real-key'.slice(-20)] },
    projects: { [home]: { hasTrustDialogAccepted: true } },
  };
  for (const path of [`${home}/.claude/.claude.json`, `${home}/.claude.json`])
    await writeFile(path, JSON.stringify(fixture));
  child = spawn(
    '/opt/pty-script',
    [
      '-q',
      '-e',
      '-c',
      `stty cols 100 rows 35; exec ${cli} --model offline-fixture --permission-mode manual ${extraArgs}`,
      '/dev/null',
    ],
    {
      cwd: home,
      env: {
        PATH: '/usr/bin:/bin:/opt',
        HOME: home,
        TERM: 'xterm-256color',
        CLAUDE_CONFIG_DIR: `${home}/.claude`,
        ANTHROPIC_API_KEY: 'offline-placeholder-not-a-real-key',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
        NODE_EXTRA_CA_CERTS: '/lab/fixture-ca.crt',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      },
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk;
    });
  await wait(() => output.includes('manual mode on'), 'CLI ready');
}
async function stop() {
  if (!child) return;
  const process = child;
  const closed = new Promise((resolve) => process.once('exit', resolve));
  process.stdin.write('\x03');
  await delay(150);
  process.stdin.write('\x03');
  const timer = setTimeout(() => process.kill('SIGKILL'), 2000);
  await closed;
  clearTimeout(timer);
  child = undefined;
}

async function extendedPaths() {
  const selected = process.env.LAB_PATH;
  const result = {};
  const noMarker = () =>
    assert.ok(
      !requests.some((value) => JSON.stringify(value.messages).includes(marker)),
      'Rejected extended input reached simulated model',
    );
  if (!selected || selected === 'queue') {
    await start('queue');
    child.stdin.write('Ordinary offline fixture\r');
    await wait(
      () => requests.some((value) => value.tools?.length),
      'initial queued scenario request',
    );
    child.stdin.write(marker + '\r');
    await wait(
      () => reviews.some((value) => value.text.includes(marker)),
      'queued prompt reviewed',
    );
    await wait(() => output.includes('操作失败，请稍后再试。'), 'queued prompt rejected');
    await wait(
      () => output.includes('OFFLINE_STUB_OK'),
      'initial response completed after queue refusal',
    );
    noMarker();
    result.queuedPromptReviewed = true;
    await stop();
  }
  if (!selected || selected === 'skill') {
    await start('skill');
    child.stdin.write('Ordinary offline fixture\r');
    await wait(() => output.includes('OFFLINE_STUB_OK'), 'skill seed response');
    const before = requests.length;
    child.stdin.write('/audit-fixture ordinary-argument\r');
    await wait(
      () => output.includes('UserPromptExpansion operation blocked by hook'),
      'unsupported command expansion refused',
    );
    assert.equal(requests.length, before, 'Unsupported command expansion reached simulated model');
    noMarker();
    result.unsupportedCommandExpansionBlocked = true;
    await stop();
  }
  if (!selected || selected === 'resume') {
    await start('resume-seed');
    child.stdin.write('Ordinary fixture with ' + marker + '\r');
    await wait(() => output.includes('OFFLINE_STUB_OK'), 'seed transcript saved');
    await stop();
    await start('resume', { homeName: 'resume-seed', extraArgs: '--continue' });
    child.stdin.write('Continue ordinary offline fixture\r');
    await wait(
      () => reviews.some((value) => value.text.includes(marker)),
      'resumed history reviewed',
    );
    await wait(
      () => output.includes('UserPromptSubmit operation blocked by hook'),
      'resumed history rejected',
    );
    assert.equal(requests.length, 0, 'Rejected resumed history reached simulated model');
    result.resumedHistoryReviewed = true;
    await stop();
  }
  for (const mode of ['permission', 'permission-amend']) {
    if (selected && selected !== mode) continue;
    await start(mode);
    child.stdin.write('Ordinary offline fixture\r');
    await wait(
      () => output.includes('Bash command') && output.includes('Esc to cancel'),
      'permission dialog',
    );
    child.stdin.write(mode === 'permission' ? '4' : '\t');
    await delay(500);
    child.stdin.write(marker + '\r');
    await wait(
      () => reviews.some((value) => value.text.includes(marker)),
      'permission feedback reviewed',
    );
    await wait(() => output.includes('操作失败，请稍后再试。'), 'permission feedback blocked');
    noMarker();
    result[
      mode === 'permission' ? 'permissionDenialFeedbackReviewed' : 'permissionAmendFeedbackReviewed'
    ] = true;
    await stop();
  }
  return result;
}

try {
  let answerResult = {};
  if (process.env.LAB_EXTENDED_ONLY) answerResult = await extendedPaths();
  if (!process.env.LAB_SDK_ONLY && !process.env.LAB_EXTENDED_ONLY) {
    await start('submit');
    child.stdin.write(marker + '\r');
    await wait(
      () => reviews.some((value) => value.kind === 'message.send' && value.text.includes(marker)),
      'prompt reviewed',
    );
    await wait(
      () => output.includes('UserPromptSubmit operation blocked by hook'),
      'prompt rejected',
    );
    assert.equal(requests.length, 0, 'Rejected initial prompt reached simulated model');
    await stop();
    await start('question');
    child.stdin.write('Ordinary offline fixture\r');
    await wait(() => output.includes('Which offline fixture color?'), 'question rendered');
    child.stdin.write('3');
    await delay(600);
    child.stdin.write(marker + '\r');
    await wait(
      () => output.includes('PostToolBatch hook stopped continuation'),
      'answer blocked before continuation',
    );
    assert.ok(reviews.some((value) => value.kind === 'message.send'));
    assert.ok(
      reviews.some((value) => value.kind === 'approval.reply' && value.text.includes(marker)),
    );
    assert.ok(!requests.some((value) => JSON.stringify(value.messages).includes(marker)));
    answerResult = {
      nativeQuestionAnswerReviewed: true,
      rejectedAnswerReachedSimulatedModel: false,
      compactInstructionsReviewed: true,
      rejectedCompactReachedSimulatedModel: false,
      nativePromptReviewed: true,
      rejectedPromptReachedSimulatedModel: false,
    };
    await stop();

    await start('compact');
    child.stdin.write('Ordinary offline fixture\r');
    await wait(() => output.includes('OFFLINE_STUB_OK'), 'ordinary response');
    const before = requests.length;
    child.stdin.write('/compact ' + marker + '\r');
    await wait(
      () =>
        reviews.some((value) => value.kind === 'session.compact' && value.text.includes(marker)),
      'compact instructions reviewed',
    );
    await delay(1000);
    assert.equal(requests.length, before, 'Rejected compaction reached simulated model');
    await stop();
  }
  let sdkCompatible = null;
  if (process.env.LAB_SDK) {
    scenario = 'sdk';
    reviews.length = 0;
    requests.length = 0;
    const home = '/tmp/sdk-native-hook';
    await mkdir(home, { recursive: true });
    const { query } = await import('/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
    let callback = false,
      success = false;
    const run = query({
      prompt: 'Ordinary SDK offline fixture',
      options: {
        pathToClaudeCodeExecutable: '/opt/runtime/cli/bin/claude',
        cwd: home,
        permissionMode: 'default',
        maxTurns: 1,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  callback = true;
                  return {};
                },
              ],
            },
          ],
        },
        env: {
          HOME: home,
          CLAUDE_CONFIG_DIR: `${home}/.claude`,
          ANTHROPIC_API_KEY: 'offline-placeholder-not-a-real-key',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
          NODE_EXTRA_CA_CERTS: '/lab/fixture-ca.crt',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
        },
      },
    });
    const timer = setTimeout(() => run.close(), 20000);
    try {
      for await (const message of run)
        if (message.type === 'result') success = message.subtype === 'success';
    } finally {
      clearTimeout(timer);
      run.close();
    }
    assert.ok(
      success && callback && reviews.some((value) => value.kind === 'message.send'),
      'Existing SDK/root-hook integration failed',
    );
    assert.equal(requests.length, 1, 'SDK fixture must use exactly one simulated model request');
    sdkCompatible = true;
  }
  if (process.env.LAB_EXTENDED) answerResult = { ...answerResult, ...(await extendedPaths()) };
  console.log(
    'NATIVE_PTY_LAB_RESULT ' +
      JSON.stringify({
        ...answerResult,
        sdkCompatible,
        realModelRequests: 0,
        realJevRequests: 0,
        productionChanged: false,
      }),
  );
} finally {
  await stop();
  for (const server of [review, model]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
