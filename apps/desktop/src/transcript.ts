import { resultPictures } from './pictures.ts';
import type { Pictures } from './pictures.ts';
import type { SessionEvent, TurnStats } from '@cc-desk-tunnel/protocol';

export type ToolState =
  | 'requested'
  | 'approval'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'denied'
  | 'failed'
  | 'unknown';
export type TranscriptItem =
  | {
      kind: 'user' | 'assistant' | 'thinking';
      id: string;
      runId: string;
      text: string;
      delivery?: string;
      // Stands for the "continue" button: there is no message of the user's to show, edit or copy.
      continued?: boolean;
      // Asked in a terminal that continued the session; recorded as its turn ended.
      terminal?: boolean;
      at: string;
      // A reply: when its last text arrived, which is when it was done (`at` is when it began).
      doneAt?: string;
      // A reply: the model that wrote it, where the CLI said.
      model?: string;
    }
  | { kind: 'notice'; id: string; runId: string; text: string; error: boolean; at: string }
  // What the CLI said along the way, in its place among the steps.
  | { kind: 'note'; id: string; runId: string; text: string; at: string }
  | {
      kind: 'compact';
      id: string;
      runId: string;
      trigger?: string;
      at: string;
      // Set once the CLI reported the context compacted; without it the compaction is under way, or was cut off.
      endedAt?: string;
      previousTokens?: number | null;
    }
  | {
      kind: 'tool';
      id: string;
      runId: string;
      name: string;
      input: string;
      target: string;
      approvalId?: string;
      resolved: boolean;
      status: string;
      state: ToolState;
      at: string;
      // Set once the result arrived; a tool without it is still running or was left unfinished.
      endedAt?: string;
      output?: string;
      // The pictures in the output, read once per result (pictures.ts).
      pictures?: Pictures;
      liveOutput?: string;
      elapsedSeconds?: number;
      // The task the call waits on in the foreground, which may be ended or sent to the background until it returns.
      taskId?: string;
      exitCode?: number | null;
      // A subagent's call: the steps the subagent took, its calls and what it said, in order.
      children?: (Tool | Text)[];
      // The subagent call this one was made in.
      parentId?: string;
      // Where its approval was asked among the session's events: approvals are answered in the order asked, whatever
      // subagent they come from.
      askedAt?: number;
    };

// A session nothing has been said in yet: no question, reply, step or notice to show. Such a session opens on the
// new-session layout (spec §5.10–5.11). A session of many events has surely had something said.
export const isBlank = (events: SessionEvent[]) =>
  events.length < 200 && transcript(events).length === 0;

export function transcript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  const byApproval = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  let compacting: Compact | undefined;
  const terminals = new Set<string>();
  // The runs that said why they failed: their error is the notice, and their failed status adds none.
  const errored = new Set(
    events.filter((event) => event.payload.type === 'run.error').map((event) => event.runId),
  );
  function add(item: TranscriptItem) {
    items.push(item);
    byId.set(item.id, item);
  }
  // A step taken inside a subagent goes under the subagent's call. One whose call is not there — a subagent's
  // call from before protocol 25 has no parent named — stays where it is.
  function subagent(parentToolId: string | undefined) {
    const parent = parentToolId ? byId.get(parentToolId) : undefined;
    return parent?.kind === 'tool' ? parent : undefined;
  }
  function place(parent: Tool, item: Tool | Text) {
    (parent.children ??= []).push(item);
    if (item.kind === 'tool') item.parentId = parent.id;
    byId.set(item.id, item);
  }
  for (const { runId, sequence, payload, createdAt: at } of events) {
    if (payload.type === 'run.status' && payload.surface === 'terminal') terminals.add(runId);
    // What the "continue" button sent is no words of the user's: the turn it starts shows a mark for it.
    if (payload.type === 'message.user')
      add({
        kind: 'user',
        id: payload.messageId,
        runId,
        text: payload.continued ? '继续' : payload.text,
        ...(payload.continued ? { continued: true } : {}),
        ...(terminals.has(runId) ? { terminal: true } : {}),
        at,
      });
    if (payload.type === 'message.delivery') {
      const item = byId.get(payload.messageId);
      if (item?.kind === 'user')
        item.delivery = {
          submitted: '已提交',
          queued: '等待原生处理',
          received: '原生已接收',
          not_sent: '未送达原生',
          unconfirmed: '接收未确认',
        }[payload.status];
    }
    // What a subagent said goes under its call, or nowhere: out of place, it would be taken for the answer.
    if (payload.type === 'text.delta') {
      const existing = byId.get(payload.messageId);
      const parent = subagent(payload.parentToolId);
      const model = payload.model ? { model: payload.model } : {};
      if (existing?.kind === 'assistant') {
        existing.text += payload.text;
        existing.doneAt = at;
        existing.model ??= payload.model;
      } else if (parent)
        place(parent, {
          kind: 'assistant',
          id: payload.messageId,
          runId,
          text: payload.text,
          at,
          ...model,
        });
      else if (!payload.parentToolId)
        add({ kind: 'assistant', id: payload.messageId, runId, text: payload.text, at, ...model });
    }
    // Sessions recorded before summaries were requested hold thinking with nothing in it.
    if (payload.type === 'thinking.delta' && payload.text) {
      const id = `thinking-${payload.messageId}`;
      const existing = byId.get(id);
      const parent = subagent(payload.parentToolId);
      if (existing?.kind === 'thinking') existing.text += payload.text;
      else if (parent) place(parent, { kind: 'thinking', id, runId, text: payload.text, at });
      else if (!payload.parentToolId) add({ kind: 'thinking', id, runId, text: payload.text, at });
    }
    if (payload.type === 'tool.requested') {
      const tool: Tool = {
        kind: 'tool',
        id: payload.toolId,
        runId,
        name: payload.name,
        input: payload.input,
        target: payload.target,
        resolved: false,
        status: '已请求',
        state: 'requested',
        at,
      };
      const parent = subagent(payload.parentToolId);
      if (parent && parent.id !== tool.id) place(parent, tool);
      else add(tool);
    }
    if (payload.type === 'approval.requested') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.approvalId = payload.approvalId;
        tool.askedAt = sequence;
        tool.status = '等待审批';
        tool.state = 'approval';
        byApproval.set(payload.approvalId, tool);
      }
    }
    // A call asked about before its subagent was known moves under it.
    if (payload.type === 'tool.input' && payload.parentToolId) {
      const tool = byId.get(payload.toolId);
      const parent = subagent(payload.parentToolId);
      const index = tool ? items.indexOf(tool) : -1;
      if (tool?.kind === 'tool' && parent && parent !== tool && !tool.parentId && index >= 0) {
        items.splice(index, 1);
        place(parent, tool);
      }
    }
    if (payload.type === 'tool.input' || payload.type === 'tool.input.delta') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool')
        tool.input =
          payload.type === 'tool.input'
            ? payload.input
            : (tool.input === '{}' ? '' : tool.input) + payload.text;
    }
    if (payload.type === 'approval.resolved') {
      const tool = byApproval.get(payload.approvalId);
      if (tool?.kind === 'tool') {
        tool.resolved = true;
        tool.status = payload.allowed ? '运行中' : '已拒绝';
        tool.state = payload.allowed ? 'running' : 'denied';
      }
    }
    if (payload.type === 'tool.result') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.resolved = true;
        tool.status = {
          completed: '已完成',
          cancelled: '已取消',
          denied: '已拒绝',
          failed: '失败',
          unknown: '结果未知',
        }[payload.status];
        tool.state = payload.status;
        tool.endedAt = at;
        tool.output = payload.output;
        tool.pictures = resultPictures(payload);
        tool.exitCode = payload.exitCode;
      }
    }
    if (payload.type === 'tool.output') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.liveOutput = (tool.liveOutput ?? '') + payload.text;
        tool.status = '运行中';
        tool.state = 'running';
      }
    }
    if (payload.type === 'tool.task') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') tool.taskId = payload.taskId;
    }
    if (payload.type === 'tool.progress') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.elapsedSeconds = payload.elapsedSeconds;
        tool.status = '运行中';
        tool.state = 'running';
      }
    }
    // The CLI tells of a compaction with a status, often several times over, and of its end with a boundary: one
    // mark from the first to the boundary. A status that is no longer compacting says nothing; sessions recorded
    // earlier hold it as the word "status".
    if (payload.type === 'native.notice') {
      if (payload.text === 'compacting') {
        if (compacting?.runId !== runId) {
          compacting = { kind: 'compact', id: `compact-${sequence}`, runId, at };
          add(compacting);
        }
      } else if (!['null', 'status', 'requesting', 'idle'].includes(payload.text))
        add({ kind: 'note', id: `native-${sequence}`, runId, text: payload.text, at });
    }
    if (payload.type === 'native.compact') {
      let mark = compacting?.runId === runId ? compacting : undefined;
      if (!mark) {
        mark = { kind: 'compact', id: `compact-${sequence}`, runId, at };
        add(mark);
      }
      mark.trigger = payload.trigger;
      mark.previousTokens = payload.previousTokens;
      mark.endedAt = at;
      compacting = undefined;
    }
    if (payload.type === 'run.error')
      items.push({
        kind: 'notice',
        id: `error-${sequence}`,
        runId,
        text: payload.message,
        error: true,
        at,
      });
    // A run that failed without saying why still says that it failed, once, where the turn ends (spec §5.9).
    if (payload.type === 'run.status' && payload.status === 'failed' && !errored.has(runId))
      items.push({
        kind: 'notice',
        id: `status-${sequence}`,
        runId,
        text: payload.reason ?? '本轮执行失败',
        error: true,
        at,
      });
    if (payload.type === 'run.status' && payload.status === 'cancelled')
      items.push({
        kind: 'notice',
        id: `status-${sequence}`,
        runId,
        text: payload.reason ?? '已停止',
        error: false,
        at,
      });
  }
  return items;
}

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Text = Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'thinking' }>;
// Whether more than one model answered in these turns, named as people read them (`name`, modelName.ts), so that a
// dated snapshot and its base are one. Replies then name their model; with one, it would be noise. A subagent's
// words are under its call, not among the steps, and do not count.
export function manyModels(turns: Turn[], name: (model: string) => string) {
  const names = new Set<string>();
  for (const turn of turns)
    for (const step of [...turn.steps, ...(turn.answer ? [turn.answer] : [])])
      if (step.kind === 'assistant' && step.model) names.add(name(step.model));
  return names.size > 1;
}
// The calls among some steps, with those their subagents made, at any depth: a call deep in a subagent may wait on
// an approval as well as one of the main conversation.
export function calls(items: (Tool | Text)[]): Tool[] {
  return items.flatMap((item) =>
    item.kind === 'tool' ? [item, ...calls(item.children ?? [])] : [],
  );
}
export type Compact = Extract<TranscriptItem, { kind: 'compact' }>;
export type Notice = Extract<TranscriptItem, { kind: 'notice' | 'note' }>;
// What happened between two pieces of text the reader was shown: tools and thinking, folded into one line.
export type Work = { kind: 'work'; id: string; items: (Tool | Text)[] };
// A compaction is part of the work on a question, between the steps before and after it.
export type Step = Text | Work | Compact | Notice;
// One question and everything up to the next one. Once finished, only the question, the time taken and the
// answer stay in view; `steps` holds the rest.
export type Turn = {
  id: string;
  question?: Text;
  // The question was added while the previous one was still being worked on, inside the same run.
  joined?: boolean;
  steps: Step[];
  answer?: Text;
  notices: Notice[];
  startedAt: string;
  endedAt?: string;
  // The "continue" button takes a stopped turn up again: the messages it sent, and how long the turn stood stopped.
  continuations: string[];
  pausedMs: number;
  tools: number;
  // What the turn used, reported by the service a moment after it ended.
  stats?: TurnStats;
  // How the run that ended the turn ended, when it did not finish: stopped by the user, or failed.
  outcome?: 'cancelled' | 'failed';
};

export function conversation(events: SessionEvent[]): Turn[] {
  // A run that goes on only for its background tasks has finished its turn; the turn a task starts reopens it.
  const ended = new Map<string, string>();
  const endedHow = new Map<string, string>();
  // Each time a run stopped working, finished or not: a question put in later ends the turn at the last of them.
  const stops = new Map<string, string[]>();
  const terminalIdle = new Map<string, { at: string; sequence: number }[]>();
  const terminalActivity = new Map<string, string>();
  for (const { runId, createdAt, payload, sequence } of events) {
    if (payload.type === 'run.status' && payload.surface === 'terminal' && payload.activity)
      terminalActivity.set(runId, payload.activity);
    if (payload.type !== 'run.status') continue;
    else if (
      ['completed', 'cancelled', 'failed'].includes(payload.status) ||
      payload.waiting === 'background'
    ) {
      ended.set(runId, createdAt);
      endedHow.set(runId, payload.status);
      stops.set(runId, [...(stops.get(runId) ?? []), createdAt]);
    } else if (payload.surface === 'terminal' && payload.activity === 'idle') {
      stops.set(runId, [...(stops.get(runId) ?? []), createdAt]);
      terminalIdle.set(runId, [...(terminalIdle.get(runId) ?? []), { at: createdAt, sequence }]);
    } else if (payload.status === 'running' && payload.surface !== 'terminal') {
      ended.delete(runId);
      endedHow.delete(runId);
    }
  }
  // How the run ended, when it did not finish.
  const outcome = (runId: string) => {
    const how = endedHow.get(runId);
    return how === 'cancelled' || how === 'failed' ? how : undefined;
  };
  const turns: Turn[] = [];
  // A terminal's turns are all of one run, which goes on while the terminal stays open, long after the last of them
  // perhaps: each ends with the last thing recorded of it.
  const seen = new Map<Turn, string>();
  const close = (turn: Turn, at: string | undefined) => {
    turn.endedAt = turn.question?.terminal ? (seen.get(turn) ?? at) : at;
  };
  let runId = '';
  for (const item of transcript(events)) {
    let turn = turns.at(-1);
    // What the turn was told on stopping stays where it was said, and the work goes on under it.
    if (turn && item.kind === 'user' && item.continued) {
      turn.steps.push(...turn.notices);
      turn.notices = [];
      turn.continuations.push(item.id);
      const stopped = ended.get(runId);
      if (stopped) turn.pausedMs += Math.max(0, Date.parse(item.at) - Date.parse(stopped));
      runId = item.runId;
      continue;
    }
    if (!turn || item.kind === 'user') {
      const joined = !!turn && item.runId === runId && !(item.kind === 'user' && item.terminal);
      // The next question closes the turn before it. One put in while the same run goes on closes it where the run
      // last stopped working, or else at the question; how the run ends later belongs to the turn it ends in.
      if (turn && !turn.endedAt && joined) {
        const from = turn.startedAt;
        close(turn, stops.get(runId)?.findLast((at) => at >= from && at <= item.at) ?? item.at);
      } else if (turn && !turn.endedAt) {
        close(turn, ended.get(runId) ?? item.at);
        turn.outcome = outcome(runId);
      }
      turn = {
        id: item.id,
        joined,
        steps: [],
        notices: [],
        startedAt: item.at,
        continuations: [],
        pausedMs: 0,
        tools: 0,
      };
      turns.push(turn);
    }
    runId = item.runId;
    const at = [
      item.at,
      'doneAt' in item ? item.doneAt : undefined,
      'endedAt' in item ? item.endedAt : undefined,
    ]
      .filter((value): value is string => !!value)
      .reduce((a, b) => (a > b ? a : b));
    if (item.kind !== 'note' && (!seen.has(turn) || seen.get(turn)! < at)) seen.set(turn, at);
    if (item.kind === 'user') turn.question = item;
    else if (item.kind === 'notice') turn.notices.push(item);
    else if (item.kind === 'assistant' || item.kind === 'note' || item.kind === 'compact')
      turn.steps.push(item);
    else {
      const last = turn.steps.at(-1);
      if (last?.kind === 'work') last.items.push(item);
      else turn.steps.push({ kind: 'work', id: item.id, items: [item] });
      if (item.kind === 'tool') turn.tools++;
    }
  }
  const last = turns.at(-1);
  if (
    last &&
    !last.endedAt &&
    ended.has(runId) &&
    (!last.question?.terminal || ended.get(runId)! >= last.startedAt)
  ) {
    close(last, ended.get(runId));
    last.outcome = outcome(runId);
  } else if (last && !last.endedAt && last.question?.terminal) {
    const questionSequence =
      events.find(
        (event) =>
          event.payload.type === 'message.user' && event.payload.messageId === last.question!.id,
      )?.sequence ?? 0;
    const idle = terminalIdle
      .get(runId)
      ?.findLast(
        (stop) =>
          stop.sequence >= questionSequence ||
          (terminalActivity.get(runId) === 'idle' && stop.at >= last.startedAt),
      );
    if (idle) close(last, idle.at);
    else if (/^\/compact(?:\s|$)/.test(last.question.text)) {
      // Local /compact can finish without another Stop hook; the boundary is its completion.
      const compact = last.steps.at(-1);
      if (compact?.kind === 'compact' && compact.endedAt) close(last, compact.endedAt);
    }
  }
  // A page of history may start after the question a report belongs to. A turn taken up again is reported once
  // for each of its messages, and each report may come several times: the last one counts.
  const reports = new Map<string, TurnStats>();
  for (const { payload } of events)
    if (payload.type === 'turn.stats' && payload.messageId) reports.set(payload.messageId, payload);
  for (const turn of turns) {
    const parts = [turn.question?.id ?? '', ...turn.continuations].flatMap((id) => {
      const report = reports.get(id);
      return report ? [report] : [];
    });
    if (parts.length) turn.stats = parts.length === 1 ? parts[0] : combined(parts);
  }
  for (const turn of turns) {
    if (!turn.endedAt) continue;
    let end = turn.steps.length;
    while (turn.steps[end - 1]?.kind === 'note') end--;
    if (turn.steps[end - 1]?.kind !== 'assistant') continue;
    turn.notices.unshift(...(turn.steps.splice(end) as Notice[]));
    turn.answer = turn.steps.pop() as Text;
  }
  return turns;
}

// The figures of the runs of one turn, as one. The averages are weighed by what they average over.
function combined(parts: TurnStats[]): TurnStats {
  const sum = (value: (part: TurnStats) => number) =>
    parts.reduce((total, part) => total + value(part), 0);
  const timed = parts.filter((part) => part.ttftMs != null);
  const weight = (part: TurnStats) => Math.max(1, part.requests);
  const fast = parts.filter((part) => part.outputPerSecond);
  const seconds = fast.reduce(
    (total, part) => total + part.outputTokens / part.outputPerSecond!,
    0,
  );
  return {
    type: 'turn.stats',
    messageId: parts[0].messageId,
    requests: sum((part) => part.requests),
    inputTokens: sum((part) => part.inputTokens),
    outputTokens: sum((part) => part.outputTokens),
    cacheReadTokens: sum((part) => part.cacheReadTokens),
    cacheCreationTokens: sum((part) => part.cacheCreationTokens),
    modelMs: sum((part) => part.modelMs),
    ttftMs: timed.length
      ? timed.reduce((total, part) => total + part.ttftMs! * weight(part), 0) /
        timed.reduce((total, part) => total + weight(part), 0)
      : null,
    outputPerSecond: seconds
      ? fast.reduce((total, part) => total + part.outputTokens, 0) / seconds
      : null,
    partial: parts.some((part) => part.partial),
  };
}
