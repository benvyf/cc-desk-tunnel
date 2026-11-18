import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Effort, EventPayload, PermissionMode } from '@cc-desk-tunnel/protocol';

const jsonObject = z.record(z.string(), z.unknown());
// What a local command printed, for the page's Markdown. /context prints Markdown of its own; /usage and the like
// print lines laid out in columns, whose dollar amounts would be taken for formulas and whose line breaks would be
// lost: those are kept as they are, in a block of plain text.
export function printed(output: string) {
  const text = output.replace(/\u001b\[[\d;]*m/g, '').trimEnd();
  if (/^\s*(#|\|)/m.test(text)) return text;
  const fence = '`'.repeat(
    Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)),
  );
  return `${fence}text\n${text}\n${fence}`;
}
// Behind a gateway, a CLI in auto mode tells of how its classifier is billed on every turn. In a terminal the user
// acknowledges it and it rests a day; a CLI the service runs has no one to acknowledge it, so it is shown once a day.
// (Ported from upstream c619dd1.)
const DAILY = /^We're changing auto mode to no longer charge for classifier requests/;
const DAY_MS = 86_400_000;
let dailyShownAt = -Infinity;
export function shownToday(text: string, now = Date.now()) {
  if (!DAILY.test(text)) return false;
  if (now - dailyShownAt < DAY_MS) return true;
  dailyShownAt = now;
  return false;
}
// What a subagent's call returned is kept up to this many characters: a subagent may take hundreds of steps, each
// recorded with the session. The subagent's own answer, the result of its Agent call, is kept whole.
export const SUBAGENT_OUTPUT_LIMIT = 8000;
export function clipped(text: string, limit = SUBAGENT_OUTPUT_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，共 ${text.length.toLocaleString('en-US')} 字符）`;
}
// A tool result's content as text. A subagent's results keep only their text: a picture is named, not carried.
function resultText(content: unknown, subagent: boolean) {
  if (typeof content === 'string') return subagent ? clipped(content) : content;
  if (!subagent) return JSON.stringify(content);
  const blocks = Array.isArray(content) ? content : [content];
  return clipped(
    blocks
      .map((block) =>
        block && typeof block === 'object' && 'type' in block
          ? block.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : `[${String(block.type)}]`
          : JSON.stringify(block),
      )
      .join('\n'),
  );
}
// A model's ID as the CLI reports it; not a stand-in such as <synthetic>, which the CLI writes for what no model said.
function modelOf(value: unknown) {
  return typeof value === 'string' && value && value.length <= 200 && !/^<.*>$/.test(value)
    ? value
    : undefined;
}
export type NativeTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  finished: boolean;
  denied?: boolean;
  // The subagent call it was made in.
  parent?: string;
};
export class ClaudeStream {
  emit: (event: EventPayload) => void;
  tools = new Map<string, NativeTool>();
  messageId = randomUUID();
  streamed = false;
  thinkingStreamed = false;
  // A model request began in this turn. A turn without one is a local command's: its answer is what it printed.
  requested = false;
  // Model requests seen since the counter was last cleared; the service waits for as many call-log records.
  requests = 0;
  // The model answering the request streaming now, as the CLI reported it.
  model?: string;
  result: { failed: boolean; text: string } | null = null;
  blocks = new Map<number, string>();
  requestedPermissionMode?: PermissionMode;
  requestedEffort?: Effort | null;
  // The subagent call each task was started by: a permission request names the subagent by its task, not its call.
  agents = new Map<string, string>();
  constructor(
    emit: (event: EventPayload) => void,
    permissionMode?: PermissionMode,
    effort?: Effort | null,
  ) {
    this.emit = emit;
    this.requestedPermissionMode = permissionMode;
    this.requestedEffort = effort;
  }
  tool(
    name: string,
    input: Record<string, unknown>,
    id: string = randomUUID(),
    parent?: string,
  ): NativeTool {
    const sameId = this.tools.get(id);
    if (sameId) {
      sameId.input = input;
      // A call asked about before the CLI said whose it was learns its subagent now.
      const placed = parent && !sameId.parent && parent !== id ? parent : undefined;
      if (placed) sameId.parent = placed;
      this.emit({
        type: 'tool.input',
        toolId: id,
        input: JSON.stringify(input, null, 2),
        ...(placed ? { parentToolId: placed } : {}),
      });
      return sameId;
    }
    const tool: NativeTool = {
      id,
      name,
      input,
      finished: false,
      ...(parent && parent !== id ? { parent } : {}),
    };
    this.tools.set(id, tool);
    this.emit({
      type: 'tool.requested',
      toolId: id,
      name,
      input: JSON.stringify(input, null, 2),
      target: 'Linux',
      ...(tool.parent ? { parentToolId: tool.parent } : {}),
    });
    return tool;
  }
  // The subagent call a permission request's agent was started by, once its task has been reported.
  parentOf(agentId: string | undefined) {
    return agentId ? this.agents.get(agentId) : undefined;
  }
  accept(value: unknown) {
    const message = jsonObject.parse(value);
    // A message from inside a subagent names the Agent call that started it.
    const parent =
      typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id
        ? message.parent_tool_use_id
        : undefined;
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        this.emit({
          type: 'native.session',
          nativeSessionId: z.uuid().parse(message.session_id),
          model: String(message.model ?? ''),
          version: String(message.claude_code_version ?? ''),
          requestedPermissionMode: this.requestedPermissionMode,
          permissionMode:
            typeof message.permissionMode === 'string' ? message.permissionMode : undefined,
          requestedEffort: this.requestedEffort,
          effort:
            typeof message.effort === 'string'
              ? (message.effort as Effort)
              : message.effort === null
                ? null
                : undefined,
        });
        if (
          this.requestedPermissionMode &&
          message.permissionMode !== this.requestedPermissionMode
        ) {
          this.emit({
            type: 'native.notice',
            text: `请求审批模式 ${this.requestedPermissionMode}；原生进程实际报告 ${String(message.permissionMode ?? '未知')}。`,
          });
        }
      } else if (message.subtype === 'compact_boundary') {
        const metadata = jsonObject.parse(message.compact_metadata ?? {});
        this.emit({
          type: 'native.compact',
          trigger: String(metadata.trigger ?? 'unknown'),
          previousTokens: typeof metadata.pre_tokens === 'number' ? metadata.pre_tokens : null,
        });
      } else if (message.subtype === 'local_command_output') {
        // What a local command printed, where the CLI reports it this way; Claude Code 2.1.293 answers /context and
        // /usage with a whole assistant message instead (see `result`). Either is a reply of its own.
        this.emit({
          type: 'text.delta',
          messageId: randomUUID(),
          text: printed(String(message.content ?? '')),
        });
      } else if (message.subtype === 'task_started') {
        // A call of the turn's that waits on a task of its own: a command or a subagent run in the foreground.
        const toolId = message.tool_use_id;
        if (typeof toolId === 'string' && typeof message.task_id === 'string')
          this.agents.set(message.task_id, toolId);
        if (
          message.is_backgrounded === false &&
          typeof toolId === 'string' &&
          typeof message.task_id === 'string' &&
          this.tools.has(toolId)
        )
          this.emit({ type: 'tool.task', toolId, taskId: message.task_id });
      } else if (message.subtype === 'session_writes_lost') {
        // The CLI could not save all it wrote as it exited: the server's disk was full, or its quota used up.
        const lost = Array.isArray(message.lost) ? message.lost : [];
        const disk =
          message.error_code === 'EDQUOT' ? '服务器的磁盘配额已用完' : '服务器的磁盘已满';
        this.emit({
          type: 'native.notice',
          text: `${disk}，Claude Code 有内容没能保存：${[
            ...(lost.includes('transcript')
              ? ['会话记录缺了一部分，之后继续这个会话时 Claude 可能看不到这段对话']
              : []),
            ...(lost.includes('global_config') ? ['它自己的配置（~/.claude.json）的改动'] : []),
          ].join('；')}。请清理服务器磁盘。`,
        });
      } else if (message.subtype === 'status' && message.status === null) {
        // The status the CLI was in is over; what it was over for (a compaction) says so itself.
      } else if (['status', 'informational'].includes(String(message.subtype))) {
        const text =
          typeof message.content === 'string'
            ? message.content
            : typeof message.message === 'string'
              ? message.message
              : String(message.status ?? message.subtype);
        if (!shownToday(text)) this.emit({ type: 'native.notice', text });
      }
    }
    if (message.type === 'tool_progress') {
      this.emit({
        type: 'tool.progress',
        toolId: z.string().parse(message.tool_use_id),
        elapsedSeconds: z.number().nonnegative().parse(message.elapsed_time_seconds),
      });
    }
    // A subagent's streaming is not shown as it comes: its whole messages are. Nor are its requests counted: the
    // service waits for the main loop's (server.ts, turnStats), and the reply streaming now is not the subagent's.
    if (message.type === 'stream_event' && parent) return;
    if (message.type === 'assistant' && parent) {
      const assistant = jsonObject.parse(message.message);
      for (const value of z.array(jsonObject).parse(assistant.content)) {
        // Each block a message of its own: the blocks of one response come one message each, between its calls.
        if (value.type === 'text' && typeof value.text === 'string' && value.text)
          this.emit({
            type: 'text.delta',
            messageId: randomUUID(),
            text: clipped(value.text),
            parentToolId: parent,
            ...(modelOf(assistant.model) ? { model: modelOf(assistant.model) } : {}),
          });
        if (value.type === 'thinking' && typeof value.thinking === 'string' && value.thinking)
          this.emit({
            type: 'thinking.delta',
            messageId: randomUUID(),
            text: clipped(value.thinking),
            parentToolId: parent,
          });
        if (value.type === 'tool_use')
          this.tool(
            z.string().parse(value.name),
            jsonObject.parse(value.input),
            z.string().parse(value.id),
            parent,
          );
      }
      return;
    }
    if (message.type === 'stream_event') {
      const event = jsonObject.parse(message.event);
      if (event.type === 'message_start') {
        this.requests++;
        this.requested = true;
        this.model = modelOf(jsonObject.safeParse(event.message).data?.model);
        this.messageId = randomUUID();
        this.streamed = false;
        this.thinkingStreamed = false;
        this.blocks.clear();
      }
      if (event.type === 'content_block_start') {
        const block = jsonObject.parse(event.content_block);
        if (block.type === 'tool_use') {
          const tool = this.tool(
            z.string().parse(block.name),
            jsonObject.parse(block.input),
            z.string().parse(block.id),
          );
          this.blocks.set(z.number().parse(event.index), tool.id);
        }
      }
      if (event.type === 'content_block_delta') {
        const delta = jsonObject.parse(event.delta);
        if (delta.type === 'text_delta') {
          this.streamed = true;
          this.emit({
            type: 'text.delta',
            messageId: this.messageId,
            text: z.string().parse(delta.text),
            ...(this.model ? { model: this.model } : {}),
          });
        }
        // A model that keeps its reasoning to itself still sends the block, with nothing in it.
        if (delta.type === 'thinking_delta' && delta.thinking) {
          this.thinkingStreamed = true;
          this.emit({
            type: 'thinking.delta',
            messageId: this.messageId,
            text: z.string().parse(delta.thinking),
          });
        }
        if (delta.type === 'input_json_delta') {
          const toolId = this.blocks.get(z.number().parse(event.index));
          if (toolId)
            this.emit({
              type: 'tool.input.delta',
              toolId,
              text: z.string().parse(delta.partial_json),
            });
        }
      }
    }
    if (message.type === 'assistant') {
      const assistant = jsonObject.parse(message.message);
      for (const value of z.array(jsonObject).parse(assistant.content)) {
        if (value.type === 'text' && !this.streamed) {
          const text = z.string().parse(value.text);
          // A local command's answer was written by no model.
          // A message that names a stand-in (<synthetic>, an error the CLI wrote) was written by none, not by
          // the model of the request before it; one that names no model at all is the streaming request's.
          const model = !this.requested
            ? undefined
            : typeof assistant.model === 'string'
              ? modelOf(assistant.model)
              : this.model;
          this.emit({
            type: 'text.delta',
            messageId: this.messageId,
            text: this.requested ? text : printed(text),
            ...(model ? { model } : {}),
          });
        }
        if (
          value.type === 'thinking' &&
          !this.thinkingStreamed &&
          typeof value.thinking === 'string' &&
          value.thinking
        )
          this.emit({ type: 'thinking.delta', messageId: this.messageId, text: value.thinking });
        if (value.type === 'tool_use')
          this.tool(
            z.string().parse(value.name),
            jsonObject.parse(value.input),
            z.string().parse(value.id),
          );
      }
    }
    if (message.type === 'user') {
      const user = jsonObject.parse(message.message);
      if (!Array.isArray(user.content)) return;
      for (const value of z.array(jsonObject).parse(user.content)) {
        if (value.type !== 'tool_result') continue;
        const toolId = z.string().parse(value.tool_use_id);
        const tool = this.tools.get(toolId);
        if (tool) tool.finished = true;
        // A subagent's results are clipped; its prompt, a user message of text, shows nowhere.
        const output = resultText(value.content, !!(parent || tool?.parent));
        const exitCode: number | null = null;
        const status: 'completed' | 'failed' | 'denied' | 'cancelled' = tool?.denied
          ? 'denied'
          : value.is_error
            ? 'failed'
            : 'completed';
        this.emit({ type: 'tool.result', toolId, status, output: output ?? '', exitCode });
      }
    }
    if (message.type === 'result') {
      // The turn is over. What comes next may be a whole message with no request streamed before it: the
      // answer of a local command such as /context or /usage.
      this.streamed = false;
      this.thinkingStreamed = false;
      this.requested = false;
      this.model = undefined;
      this.messageId = randomUUID();
      this.result = {
        failed: message.is_error === true || message.subtype !== 'success',
        text: String(
          message.result ?? (Array.isArray(message.errors) ? message.errors.join('\n') : ''),
        ),
      };
      if (this.result.failed)
        this.emit({
          type: 'run.error',
          code: String(message.subtype ?? 'cli_failure'),
          message: this.result.text || 'Claude Code run failed.',
        });
    }
  }
}
