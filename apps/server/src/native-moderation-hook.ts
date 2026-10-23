// Official CLI command hook. This module is not enabled by the current production image.
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
        if (block.is_error) failures.add(block.tool_use_id);
        if (block.is_error || interactive.has(tools.get(block.tool_use_id) ?? ''))
          parts.push(text(block.content));
      } else throw new Error('Unsupported native user content');
    }
  }
  if (input.hook_event_name === 'PostToolBatch') {
    if (!Array.isArray(input.tool_calls)) throw new Error('Missing native tool batch');
    const replies = input.tool_calls.filter(
      (call) => interactive.has(call.tool_name) || failures.has(call.tool_use_id),
    );
    if (!replies.length) return undefined; // Ordinary file/tool output remains outside this text-input gate.
    for (const reply of replies) parts.push(text(reply.tool_response));
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
    let transcript = '';
    try {
      if ((await stat(input.transcript_path)).size > 16 * 1024 * 1024)
        throw new Error('Native transcript limit');
      transcript = await readFile(input.transcript_path, 'utf8');
      if (Buffer.byteLength(transcript) > 16 * 1024 * 1024)
        throw new Error('Native transcript limit');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || event !== 'UserPromptSubmit')
        throw error;
    }
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
