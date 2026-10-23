// Run only in the disposable --network none lab, with a loopback model stub and fixture credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const directory = '/tmp/native-hook-lab';
const cli = process.env.LAB_CLI ?? '/opt/claude/claude';
await mkdir(directory, { recursive: true });
let modelRequests = 0;
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!request.url.startsWith('/v1/messages')) {
    response.writeHead(404).end('{}');
    return;
  }
  modelRequests++;
  const input = JSON.parse(body);
  assert.equal(input.stream, true);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
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
  ];
  for (const event of events)
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise((resolve) => server.listen(18080, '127.0.0.1', resolve));

async function run(
  name,
  mode,
  { prompt = 'Ordinary offline fixture', settings, blocked = true, extraArgs = [] } = {},
) {
  const home = `${directory}/${name}`;
  await mkdir(`${home}/.claude`, { recursive: true });
  await writeFile(`${home}/.claude.json`, JSON.stringify({ hasCompletedOnboarding: true }));
  const log = `${home}/hook-input.json`;
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--model',
    'offline-fixture',
    '--no-session-persistence',
  ];
  if (settings) args.push('--settings', JSON.stringify(settings));
  args.push(...extraArgs);
  const before = modelRequests;
  const child = spawn(cli, args, {
    cwd: home,
    env: {
      PATH: '/usr/bin:/bin:/opt',
      HOME: home,
      TERM: 'dumb',
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      ANTHROPIC_API_KEY: 'offline-placeholder-not-a-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      LAB_HOOK_MODE: mode,
      LAB_HOOK_LOG: log,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk;
    });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  await writeFile(`${home}/output.log`, output);
  const attempts = modelRequests - before;
  let hook;
  try {
    hook = JSON.parse(await readFile(log, 'utf8'));
  } catch {}
  if (blocked) assert.equal(attempts, 0, `${name} reached the simulated model`);
  else {
    assert.equal(attempts, 1, `${name} did not reach the simulated model exactly once`);
    assert.ok(output.includes('OFFLINE_STUB_OK'), `${name} failed to render stub response`);
    assert.equal(code, 0);
  }
  if (mode !== 'missing') {
    assert.equal(hook?.hook_event_name, 'UserPromptSubmit', `${name} did not invoke the hook`);
    assert.equal(hook.prompt, prompt, `${name} changed submitted text`);
  }
  const result = {
    name,
    passed: true,
    hookInvoked: Boolean(hook),
    simulatedModelRequests: attempts,
    exitCode: code,
  };
  console.log(JSON.stringify(result));
  return result;
}

try {
  const results = [];
  if (process.env.LAB_FLAGS_ONLY) {
    results.push(await run('bare-managed', 'reject', { extraArgs: ['--bare'] }));
    results.push(await run('safe-mode-managed', 'reject', { extraArgs: ['--safe-mode'] }));
  } else {
    results.push(await run('reject', 'reject'));
    results.push(await run('timeout', 'timeout'));
    results.push(await run('crash', 'crash'));
    results.push(await run('invalid-json', 'invalid'));
    results.push(await run('missing-program', 'missing'));
    results.push(
      await run('cannot-disable-managed', 'reject', { settings: { disableAllHooks: true } }),
    );
    results.push(
      await run('multiline', 'reject', { prompt: 'First offline line\nSecond offline line 中文' }),
    );
    results.push(await run('allow', 'allow', { blocked: false }));
  }
  console.log(
    'NATIVE_HOOK_LAB_RESULT ' +
      JSON.stringify({
        version: '2.1.295',
        results,
        realModelRequests: 0,
        realJevRequests: 0,
        productionChanged: false,
        scope: 'real CLI print-mode policy checks; PTY paths are checked separately',
      }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
