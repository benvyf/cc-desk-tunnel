import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';

// A separate, simulated Ubuntu actor. Only the SDK/CLI producer is replaced:
// runClaude, NativeInput, approvals, model HTTP and native SSH are exercised.
const [directory, endpoint, configPath] = process.argv.slice(2);
const sdk = await import('@anthropic-ai/claude-agent-sdk');
let invoked = 0;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    ...sdk,
    query(args) {
      invoked++;
      assert.match(
        args.options.systemPrompt.append,
        /Bash with the non-interactive SSH environment/,
      );
      assert.ok(args.options.systemPrompt.append.includes(JSON.stringify(configPath)));
      assert.doesNotMatch(args.options.systemPrompt.append, /CC_DESK_TUNNEL_SCHEDULES/);
      return {
        initializationResult: async () => ({ account: {}, models: [], commands: [] }),
        close() {},
        async *[Symbol.asyncIterator]() {
          const sessionId = args.options.sessionId;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
            model: 'test-only',
            claude_code_version: 'test-only',
          };
          const message = (await args.prompt.next()).value;
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pid: process.pid, text: message.message.content }),
          });
          assert.equal(response.status, 200);
          const { script } = await response.json();
          const decision = await args.options.canUseTool(
            'Bash',
            { command: 'test-only SSH command' },
            {
              toolUseID: 'test-tool',
              signal: args.options.abortController.signal,
            },
          );
          assert.equal(decision.behavior, 'allow');
          const result = await new Promise((resolve, reject) => {
            const child = execFile(
              'ssh',
              ['-F', configPath, 'device-script'],
              {
                windowsHide: true,
                timeout: 10000,
              },
              (error, stdout) => {
                // The controlled target returns code 7 for a normal fixture command.
                if (error && error.code !== 7) reject(error);
                else resolve({ code: error?.code ?? 0, stdout });
              },
            );
            child.stdin.on('error', () => {});
            child.stdin.end(script);
          });
          assert.equal(result.code, 7);
          assert.equal(result.stdout, script);
          yield {
            type: 'assistant',
            user_message_uuid: message.uuid,
            message: { content: [{ type: 'text', text: 'Observed target result' }] },
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            user_message_uuid: message.uuid,
            result: 'Observed target result',
            usage: {},
            modelUsage: {},
            num_turns: 1,
          };
        },
      };
    },
  },
});
// runClaude is intentionally Linux-only. This fixture does not claim to be an
// actual Linux OS; the SSH transport and processes still run on the test host.
Object.defineProperty(process, 'platform', { value: 'linux' });
const { runClaude } = await import('../../../server/src/claude.ts');
const { NativeInput } = await import('../../../server/src/native-input.ts');
const sessionId = randomUUID();
const events = [];
const input = new NativeInput(sessionId, (event) => events.push(event));
input.submit(randomUUID(), 'Run controlled target task');
let approvals = 0;
const status = await runClaude(
  { executable: 'never-started-test-cli' },
  {
    sessionId,
    nativeRoot: sessionId,
    projectPath: '/home/dev/project',
    platform: 'linux',
    viaSsh: true,
    permissionMode: 'default',
    input,
    dataDir: directory,
    resume: false,
    signal: new AbortController().signal,
    ssh: { configPath },
    emit: (event) => events.push(event),
    approve: async () => {
      approvals++;
      return { allowed: true };
    },
    waiting() {},
    turnEnded() {},
    controls: {},
  },
);
assert.equal(
  status,
  'completed',
  JSON.stringify(events.filter((event) => event.type === 'run.error')),
);
assert.equal(invoked, 1);
assert.equal(approvals, 1);
assert.ok(events.some((event) => event.type === 'message.delivery' && event.status === 'received'));
console.log(
  'PASS: simulated Ubuntu queried the loopback model and ran approved SSH against the target',
);
