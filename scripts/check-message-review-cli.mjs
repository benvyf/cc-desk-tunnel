// Disposable Linux container only: --network none, no production data or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const reviews = [],
  requests = [];
const review = createHttpsServer(
  { key: await readFile('/lab/fixture.key'), cert: await readFile('/lab/fixture.crt') },
  async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    reviews.push(input);
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: crypto.randomUUID(),
        allowed: !input.text.includes('BLOCK_MESSAGE_FIXTURE'),
      }),
    );
  },
);
const model = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url.startsWith('/v1/messages')) {
    res.writeHead(404).end('{}');
    return;
  }
  requests.push(JSON.parse(raw));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    {
      type: 'message_start',
      message: {
        id: 'msg_offline',
        type: 'message',
        role: 'assistant',
        model: 'offline-fixture',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OFFLINE_STUB_OK' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((r) => review.listen(18443, '127.0.0.1', r));
await new Promise((r) => model.listen(18080, '127.0.0.1', r));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = '/opt/runtime/cli/bin/claude';
let child,
  output = '';
async function wait(predicate, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(50);
  }
  throw Error(label + ' ' + JSON.stringify(output.slice(-2000)));
}
function env(home, entry) {
  return {
    PATH: '/opt/runtime/node/bin:/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    CLAUDE_CONFIG_DIR: home + '/.claude',
    ANTHROPIC_API_KEY: 'offline-placeholder-not-a-real-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
    NODE_EXTRA_CA_CERTS: '/lab/fixture.crt',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENTRYPOINT: entry,
  };
}
async function home(name) {
  const p = '/tmp/' + name;
  await mkdir(p + '/.claude', { recursive: true });
  const c = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    customApiKeyResponses: { approved: ['offline-placeholder-not-a-real-key'.slice(-20)] },
    projects: { [p]: { hasTrustDialogAccepted: true } },
  };
  for (const f of [p + '/.claude.json', p + '/.claude/.claude.json'])
    await writeFile(f, JSON.stringify(c));
  return p;
}
async function stop() {
  if (!child) return;
  const p = child;
  const closed = new Promise((r) => p.once('exit', r));
  p.stdin.write('\x03');
  await delay(100);
  p.stdin.write('\x03');
  const timer = setTimeout(() => p.kill('SIGKILL'), 2000);
  await closed;
  clearTimeout(timer);
  child = undefined;
}
try {
  const terminalHome = await home('cc-message-terminal');
  child = spawn(
    '/usr/bin/script',
    [
      '-q',
      '-e',
      '-c',
      `stty cols 100 rows 35; exec ${cli} --model offline-fixture --permission-mode manual`,
      '/dev/null',
    ],
    { cwd: terminalHome, env: env(terminalHome, 'cli') },
  );
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => (output += b));
  await wait(() => output.includes('manual mode on'), 'terminal ready');
  child.stdin.write('BLOCK_MESSAGE_FIXTURE\r');
  await wait(() => reviews.length > 0, 'terminal message review');
  await wait(
    () => output.includes('UserPromptSubmit operation blocked by hook'),
    'terminal refusal',
  );
  assert.equal(reviews[0].text, 'BLOCK_MESSAGE_FIXTURE');
  assert.equal(requests.length, 0, 'Blocked terminal message reached stub model');
  // The official CLI restores rejected text in its composer for editing.
  child.stdin.write('\x15');
  await delay(100);
  child.stdin.write('Allowed new terminal message\r');
  await wait(
    () => requests.length > 0 && output.includes('OFFLINE_STUB_OK'),
    'allowed terminal message',
  );
  assert.equal(
    reviews.at(-1).text,
    'Allowed new terminal message',
    'History or other input entered review',
  );
  assert.ok(!requests.some((r) => JSON.stringify(r.messages).includes('BLOCK_MESSAGE_FIXTURE')));
  await stop();
  const { query } = await import('/lab/sdk.mjs');
  const sdkHome = await home('cc-message-sdk');
  const before = reviews.length;
  let source;
  const run = query({
    prompt: 'CC SDK message already reviewed upstream',
    options: {
      pathToClaudeCodeExecutable: cli,
      cwd: sdkHome,
      maxTurns: 1,
      model: 'offline-fixture',
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              async (input) => {
                source = input.source ?? 'legacy';
                return {};
              },
            ],
          },
        ],
      },
      env: env(sdkHome, 'sdk-ts'),
    },
  });
  const timeout = setTimeout(() => run.close(), 20000);
  let success = false;
  try {
    for await (const message of run)
      if (message.type === 'result') success = message.subtype === 'success';
  } finally {
    clearTimeout(timeout);
    run.close();
  }
  assert.ok(success, 'SDK did not finish with stub response');
  assert.equal(reviews.length, before, 'SDK duplicate review was not excluded');
  console.log(
    'MESSAGE_REVIEW_CLI_OK ' +
      JSON.stringify({
        terminalBlockedBeforeModel: true,
        terminalExactNewText: true,
        sdkCompleted: true,
        sdkHookSource: source,
        duplicateSdkReviews: 0,
        realProviderRequests: 0,
      }),
  );
} finally {
  await stop();
  for (const server of [review, model]) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
