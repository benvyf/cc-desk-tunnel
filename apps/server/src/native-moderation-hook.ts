// Official CLI command hook. This module is not enabled by the current production image.
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { moderationConfig, reviewInput, type ModerationOptions } from './moderation.ts';

const failure = '操作失败，请稍后再试。';
const interactive = new Set(['AskUserQuestion', 'ExitPlanMode']);
type Block = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Block[];
};
type HookInput = {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  prompt?: string;
  custom_instructions?: string;
  tool_calls?: { tool_name: string; tool_use_id: string; tool_response: string | Block[] }[];
};
type Row = { type?: string; message?: { content?: string | Block[] } };

class PendingNativeBatch extends Error {}

function text(value: string | Block[] | undefined): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw new Error('Invalid native text');
  return value
    .map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string')
        throw new Error('Unsupported native content');
      return block.text;
    })
    .join('\n');
}

export function nativeReviewText(input: HookInput, transcript: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.session_id)) throw new Error('Invalid native session');
  // The official event exposes the typed command, not the expanded skill body.
  // Keep direct prompt expansions closed until that body can be reviewed before transmission.
  if (input.hook_event_name === 'UserPromptExpansion')
    throw new Error('Native prompt expansion is not supported by input review');
  const kinds: Record<string, string> = {
    UserPromptSubmit: 'message.send',
    UserPromptExpansion: 'message.send',
    PostToolBatch: 'approval.reply',
    PreCompact: 'session.compact',
  };
  const kind = kinds[input.hook_event_name];
  if (!kind) throw new Error('Unsupported native hook');
  const rows: Row[] = transcript
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const tools = new Map<string, string>();
  const parts: string[] = [];
  const failures = new Set<string>();
  const results = new Set<string>();
  const reviewedResults = new Map<string, string>();
  for (const row of rows) {
    const blocks = row.message?.content;
    if (row.type === 'assistant' && Array.isArray(blocks)) {
      for (const block of blocks)
        if (block.type === 'tool_use' && block.id && block.name) tools.set(block.id, block.name);
    }
    if (row.type !== 'user' || blocks === undefined) continue;
    if (typeof blocks === 'string') {
      parts.push(blocks);
      continue;
    }
    for (const block of blocks) {
      if (block.type === 'text') parts.push(text([block]));
      else if (block.type === 'tool_result' && block.tool_use_id) {
        results.add(block.tool_use_id);
        if (block.is_error) failures.add(block.tool_use_id);
        if (block.is_error || interactive.has(tools.get(block.tool_use_id) ?? '')) {
          const content = text(block.content);
          if (reviewedResults.get(block.tool_use_id) !== content) parts.push(content);
          reviewedResults.set(block.tool_use_id, content);
        }
      } else throw new Error('Unsupported native user content');
    }
  }
  if (input.hook_event_name === 'PostToolBatch') {
    if (!Array.isArray(input.tool_calls) || !input.tool_calls.length)
      throw new Error('Missing native tool batch');
    // The CLI persists permission amendments with the tool-result row asynchronously.
    // An older transcript can look valid while omitting the just-submitted amendment.
    if (input.tool_calls.some((call) => !call.tool_use_id || !results.has(call.tool_use_id)))
      throw new PendingNativeBatch('Native tool batch has not been persisted');
    const replies = input.tool_calls.filter(
      (call) => interactive.has(call.tool_name) || failures.has(call.tool_use_id),
    );
    // Permission-dialog amendments can add a new user message after a successful tool result,
    // without UserPromptSubmit or an error/interactive tool. Review user history at every batch.
    // Ordinary file/tool output itself remains outside this text-input gate.
    for (const reply of replies) {
      const content = text(reply.tool_response);
      // The persisted result is already in parts. Retain differing hook content:
      // it can contain user feedback that must not be silently omitted.
      if (reviewedResults.get(reply.tool_use_id) !== content) parts.push(content);
      reviewedResults.set(reply.tool_use_id, content);
    }
  }
  if (['UserPromptSubmit', 'UserPromptExpansion'].includes(input.hook_event_name)) {
    if (typeof input.prompt !== 'string' || !input.prompt.trim())
      throw new Error('Missing native prompt');
    parts.push(input.prompt);
  }
  if (input.custom_instructions) parts.push(input.custom_instructions);
  const combined = parts
    .filter((part, index) => part.trim() && part !== parts[index - 1])
    .join('\n\n');
  if (!combined.trim() || Buffer.byteLength(combined) > 65536)
    throw new Error('Native review input limit');
  return { kind, text: combined };
}

export async function reviewNativeHook(
  input: HookInput,
  transcript: string,
  moderation: ModerationOptions,
) {
  const content = nativeReviewText(input, transcript);
  if (content)
    await reviewInput(moderation, {
      requestId: randomUUID(),
      sessionId: input.session_id,
      deviceId: 'native-terminal',
      ...content,
    });
  return {};
}

export async function readNativeTranscript(input: HookInput) {
  const deadline = Date.now() + 1000;
  for (;;) {
    let transcript = '';
    try {
      if ((await stat(input.transcript_path)).size > 16 * 1024 * 1024)
        throw new Error('Native transcript limit');
      transcript = await readFile(input.transcript_path, 'utf8');
      if (Buffer.byteLength(transcript) > 16 * 1024 * 1024)
        throw new Error('Native transcript limit');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        input.hook_event_name !== 'UserPromptSubmit'
      )
        throw error;
    }
    try {
      nativeReviewText(input, transcript);
      return transcript;
    } catch (error) {
      if (!(error instanceof PendingNativeBatch) || Date.now() >= deadline) throw error;
      // Retry only local persistence, never moderation or model requests.
      await delay(50);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let event: string | undefined;
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
    const transcript = await readNativeTranscript(input);
    // The managed hook reads an administrator-controlled, read-only mount, never workspace-writable config.
    const moderation = moderationConfig(
      JSON.parse(
        await readFile(process.argv[2] ?? '/etc/claude-code/moderation-node.json', 'utf8'),
      ),
    );
    process.stdout.write(JSON.stringify(await reviewNativeHook(input, transcript, moderation)));
  } catch {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: failure,
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
