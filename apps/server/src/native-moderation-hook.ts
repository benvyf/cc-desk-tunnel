// Administrator-managed review of newly submitted terminal messages.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { moderationConfig, reviewInput, type ModerationOptions } from './moderation.ts';

const failure = '操作失败，请稍后再试。';
const retiredEvents = new Set(['PostToolBatch', 'UserPromptExpansion', 'PreCompact']);
const generatedSources = new Set(['system', 'loop_wakeup', 'schedule_wakeup', 'poll_event']);
type HookInput = {
  hook_event_name: string;
  session_id?: string;
  prompt?: string;
  source?: string;
  agent_id?: string;
};

export function nativeReviewText(input: HookInput, environment: NodeJS.ProcessEnv = process.env) {
  // Old registrations can remain during migration. They no longer review content.
  if (retiredEvents.has(input.hook_event_name)) return;
  if (input.hook_event_name !== 'UserPromptSubmit') throw new Error('Unsupported native hook');
  if (input.source !== undefined && !['user', 'sdk', ...generatedSources].includes(input.source))
    throw new Error('Invalid native source');
  // CC reviews chat messages before passing them to its SDK. SDK control turns,
  // injected notices and agent messages are outside the terminal composer scope.
  if (
    input.source !== 'user' &&
    (environment.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts' ||
      input.agent_id ||
      generatedSources.has(input.source ?? ''))
  )
    return;
  if (typeof input.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.session_id))
    throw new Error('Invalid native session');
  if (typeof input.prompt !== 'string' || !input.prompt.trim())
    throw new Error('Missing native prompt');
  if (Buffer.byteLength(input.prompt) > 65536) throw new Error('Native review input limit');
  return { kind: 'message.send', text: input.prompt };
}

export async function reviewNativeHook(
  input: HookInput,
  moderation: ModerationOptions,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const content = nativeReviewText(input, environment);
  if (content)
    await reviewInput(moderation, {
      requestId: randomUUID(),
      sessionId: input.session_id!,
      deviceId: 'native-terminal',
      ...content,
    });
  return {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let event: string | undefined;
  let sessionId: string | undefined;
  let stage = 'input';
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error('Native hook input limit');
      chunks.push(chunk);
    }
    const input: HookInput = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    event = input.hook_event_name;
    sessionId = input.session_id;
    const content = nativeReviewText(input);
    if (!content) process.stdout.write('{}');
    else {
      // Read only the administrator-controlled config; never open transcript_path.
      stage = 'config';
      const moderation = moderationConfig(
        JSON.parse(
          await readFile(process.argv[2] ?? '/etc/claude-code/moderation-node.json', 'utf8'),
        ),
      );
      stage = 'review';
      await reviewInput(moderation, {
        requestId: randomUUID(),
        sessionId: input.session_id!,
        deviceId: 'native-terminal',
        ...content,
      });
      process.stdout.write('{}');
    }
  } catch (error) {
    const limit = error instanceof Error && error.message === 'Native review input limit';
    const code = limit ? 'native_review_input_limit' : `native_${stage}_failed`;
    console.error(
      'Native input review failed.',
      JSON.stringify({
        code,
        stage,
        ...(event === 'UserPromptSubmit' ? { event } : {}),
        ...(typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
          ? { sessionId }
          : {}),
      }),
    );
    const reason = limit
      ? '本次消息过长，请缩短后重试。'
      : stage === 'config'
        ? '服务端审核配置异常，请联系管理员。'
        : failure;
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `${reason}（${code}）`,
        ...(event === 'UserPromptSubmit'
          ? {
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                suppressOriginalPrompt: true,
              },
            }
          : {}),
      }),
    );
  }
}
