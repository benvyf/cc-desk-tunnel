import { lineChanges } from './lineDiff.ts';
import type { TranscriptItem, Work } from './transcript.ts';

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
export type Category =
  'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'question' | 'plan' | 'other';

const categories: Record<string, Category> = {
  Bash: 'command',
  PowerShell: 'command',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
};
// [while running, once done, group phrase while running, group phrase once done]
const words: Record<Category, [string, string, string, (count: number) => string]> = {
  command: ['运行', '已运行', '运行命令', (count) => `运行了 ${count} 条命令`],
  edit: ['编辑', '已编辑', '编辑文件', (count) => `编辑了 ${count} 个文件`],
  read: ['读取', '已读取', '读取文件', (count) => `读取了 ${count} 个文件`],
  search: ['搜索', '已搜索', '搜索', (count) => `搜索了 ${count} 次`],
  web: ['检索', '已检索', '检索网页', (count) => `检索了 ${count} 个网页`],
  agent: ['子任务', '子任务完成', '执行子任务', (count) => `执行了 ${count} 个子任务`],
  question: ['提问', '已回答', '提问', (count) => `提了 ${count} 次问题`],
  plan: ['提交计划', '计划已批准', '提交计划', () => '提交了计划'],
  other: ['调用', '已调用', '调用工具', (count) => `调用了 ${count} 个工具`],
};
// A question is answered or left unanswered, a plan approved or sent back: not allowed or denied as a call is.
const askedOutcomes: Partial<Record<Category, Partial<Record<Tool['state'], string>>>> = {
  question: { approval: '等待回答', denied: '未回答' },
  plan: { approval: '等待批准计划', denied: '继续规划' },
};
const outcomes: Partial<Record<Tool['state'], string>> = {
  approval: '等待审批',
  denied: '已拒绝',
  cancelled: '已取消',
  failed: '失败',
  unknown: '结果未知',
};

function fields(input: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const fileName = (value: unknown) => text(value).split(/[\\/]/).at(-1) ?? '';

export const categoryOf = (tool: Tool): Category => categories[tool.name] ?? 'other';
export const isRunning = (tool: Tool) =>
  !tool.endedAt && tool.state !== 'denied' && tool.state !== 'approval';

// The line for a question: what was asked, and once answered, what the answer was. Claude Code reports the answers
// as `"question"="answer"` pairs joined by ", ", unescaped and sometimes followed by notes, in the call's result: an
// answer is cut out between its own question and the next one asked, up to its closing quote, rather than by quotes
// it may contain itself.
export function asked(input: Record<string, unknown>, output: string | undefined) {
  const questions = (
    Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
  )
    .map((item) => text(item?.question))
    .filter(Boolean);
  const label =
    questions.length > 1 ? `${questions[0]} 等 ${questions.length} 个问题` : (questions[0] ?? '');
  const result = output ?? '';
  const answers: string[] = [];
  let from = 0;
  questions.forEach((question, index) => {
    const marker = `"${question}"="`;
    const at = result.indexOf(marker, from);
    if (at === -1) return;
    const begin = at + marker.length;
    const next = questions
      .slice(index + 1)
      .map((item) => result.indexOf(`"${item}"=`, begin))
      .find((position) => position !== -1);
    const part = result.slice(begin, next ?? result.length);
    // Notes on an answer follow its closing quote; otherwise the answer ends at the last quote before the next one.
    const notes = ['" selected preview:', '" notes: ']
      .map((tail) => part.indexOf(tail))
      .filter((position) => position !== -1);
    const close = notes.length ? Math.min(...notes) : part.lastIndexOf('"');
    if (close === -1) return;
    answers.push(part.slice(0, close));
    from = begin + close;
  });
  return answers.length ? `${label} → ${answers.join('；')}` : label;
}

// One line for a tool call: what it did, to what, and for edits how many lines went in and out.
export function describe(tool: Tool, active: boolean) {
  const category = categoryOf(tool);
  const input = fields(tool.input);
  let subject = '';
  let added = 0;
  let removed = 0;
  if (category === 'command')
    subject = text(input.description) || (text(input.command) || tool.input).trim().split('\n')[0];
  else if (category === 'edit') {
    subject = fileName(input.file_path ?? input.notebook_path);
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
    // Counted as the diff under the call shows them: lines both texts share are neither.
    for (const edit of edits) {
      const change = lineChanges(
        text(edit.old_string),
        text(edit.new_string ?? edit.content ?? edit.new_source),
      );
      added += change.added;
      removed += change.removed;
    }
  } else if (category === 'read') subject = fileName(input.file_path);
  else if (category === 'search') subject = text(input.pattern) || text(input.query);
  else if (category === 'web') subject = text(input.url) || text(input.query);
  else if (category === 'agent') subject = text(input.description);
  else if (category === 'question') subject = asked(input, tool.output);
  else if (category === 'plan')
    subject =
      text(input.plan)
        .split('\n')
        .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
        .find(Boolean) ?? '';
  else subject = tool.name;
  const running = active && isRunning(tool);
  return {
    category,
    verb:
      askedOutcomes[category]?.[tool.state] ??
      outcomes[tool.state] ??
      words[category][running ? 0 : 1],
    subject,
    added,
    removed,
    running,
    // Leaving a question unanswered or a plan to be reworked is a choice, not a failure.
    failed:
      ['failed', 'cancelled', 'unknown'].includes(tool.state) ||
      (tool.state === 'denied' && category !== 'question' && category !== 'plan'),
  };
}

// The folded line for a run of tool calls: what is happening now, or what was done.
export function summarize(work: Work, active: boolean, latest: boolean) {
  const tools = work.items.filter((item): item is Tool => item.kind === 'tool');
  const waiting = tools.find((tool) => tool.state === 'approval');
  const running = active ? tools.filter(isRunning) : [];
  const started = work.items[0].at;
  const last = work.items.at(-1)!;
  const ended = running.length
    ? undefined
    : tools.reduce(
        (latest, tool) => (tool.endedAt && tool.endedAt > latest ? tool.endedAt : latest),
        last.at,
      );
  let label: string;
  if (waiting)
    label =
      waiting.name === 'AskUserQuestion'
        ? '等待回答'
        : waiting.name === 'ExitPlanMode'
          ? '等待批准计划'
          : '等待审批';
  else if (running.length)
    label = `正在${[...new Set(running.map((tool) => words[categoryOf(tool)][2]))].slice(0, 2).join('、')}`;
  else if (!tools.length) label = active && latest ? '正在思考' : '思考';
  else {
    const counts = new Map<Category, number>();
    for (const tool of tools) counts.set(categoryOf(tool), (counts.get(categoryOf(tool)) ?? 0) + 1);
    label = [...counts].map(([category, count]) => words[category][3](count)).join('，');
    const failed = tools.filter((tool) => ['failed', 'unknown'].includes(tool.state)).length;
    if (failed) label += `，${failed} 项未成功`;
  }
  return {
    label,
    waiting: !!waiting,
    running: running.length > 0 || (!tools.length && active && latest),
    started,
    ended,
  };
}

export function duration(from: string, to: string | number) {
  const ms = Math.max(0, (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from));
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10) return `${(ms / 1000).toFixed(1)} 秒`;
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
