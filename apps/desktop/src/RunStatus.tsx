import { useEffect, useState } from 'react';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { TaskProgress } from './client.ts';

// The service's clock as this window knows it, and when something last came from a session's run.
export type Clock = { now: () => number; activityAt: (sessionId: string) => number };

// Draws its component again as time passes, and only while there is something to count: nothing above it
// is drawn again for the passing of a second.
function useTick(active: boolean, every = 1000) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((count) => count + 1), every);
    return () => clearInterval(timer);
  }, [active, every]);
}
export function span(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} 秒`;
  if (whole < 3600) return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`;
  return `${Math.floor(whole / 3600)} 小时 ${Math.floor((whole % 3600) / 60)} 分`;
}

// Outside the scrolling transcript, so a finished or interrupted turn cannot disappear from view.
export function RunSummary({
  session,
  events,
  clock,
  connected,
  resume,
}: {
  session: Session;
  events: SessionEvent[];
  clock: Clock;
  connected: boolean;
  resume?: () => void;
}) {
  const run = session.activeRun;
  useTick(!!run && connected, 5000);
  const last = events.findLast((event) => event.payload.type === 'run.status');
  if (
    run?.surface === 'terminal' ||
    (!run && last?.payload.type === 'run.status' && last.payload.surface === 'terminal')
  )
    return null;
  if (!run && !last) return null;
  const status = last?.payload.type === 'run.status' ? last.payload : undefined;
  let label: string,
    detail = '',
    kind = 'running';
  if (
    !connected &&
    (run || !status || status.status === 'running' || status.status === 'awaiting_approval')
  ) {
    kind = 'uncertain';
    label = '连接中断 · 任务状态待确认';
  } else if (run) {
    if (run.status === 'awaiting_approval') {
      kind = 'waiting';
      label = run.waiting === 'question' ? '等待你回答' : '等待你审批';
    } else if (run.waiting === 'background') label = '后台任务进行中';
    else {
      label = '正在执行';
      const since = Math.max(
        clock.activityAt(session.id),
        Date.parse(events.at(-1)?.createdAt ?? '') || 0,
      );
      const quiet = Math.max(0, clock.now() - since);
      if (since && quiet >= 60_000) detail = `已 ${Math.floor(quiet / 60_000)} 分钟没有新输出`;
    }
  } else {
    kind = status?.status ?? 'unknown';
    label =
      kind === 'completed'
        ? '本轮已完成'
        : kind === 'cancelled'
          ? '本轮已停止'
          : kind === 'failed'
            ? '本轮执行失败'
            : '任务状态待确认';
    if (kind === 'failed') {
      const error = events.findLast(
        (event) => event.runId === last?.runId && event.payload.type === 'run.error',
      )?.payload;
      detail =
        error?.type === 'run.error' ? error.message : (status?.reason ?? '请查看会话中的错误信息');
    } else if (kind === 'cancelled') detail = status?.reason ?? '';
  }
  return (
    <div
      className={`run-summary ${kind}`}
      role={kind === 'failed' ? 'alert' : 'status'}
      aria-label="当前任务状态"
    >
      <span
        className={`running-dot${kind === 'running' && connected && !detail ? ' breathing' : ''}`}
        aria-hidden="true"
      />
      <div className="run-summary-copy">
        <strong>{label}</strong>
        {detail && (
          <span className="run-summary-detail" title={detail}>
            {detail}
          </span>
        )}
      </div>
      {connected && !run && resume && (
        <button type="button" className="button" onClick={resume}>
          继续上一轮
        </button>
      )}
    </div>
  );
}

// Whether a run is alive. A tool that takes long tells its time in its own row above, and counts as word of
// the run; a run with no tool at work from which nothing has come for a minute says so, in words that do not
// call it stuck. The dot breathes while there is word of the run and rests when there is none.
// (The idea of telling a live run from a silent one: #47, kilisamemarisaaa.)
export function RunStatus({
  tool,
  since,
  clock,
  connected,
  suffix,
}: {
  // A tool is at work now.
  tool: boolean;
  since: number;
  clock: Clock;
  connected: boolean;
  suffix: string;
}) {
  useTick(!tool, 5000);
  const quiet = (clock.now() - since) / 1000;
  const silent = !tool && quiet >= 60;
  return (
    <div className="run-indicator" role="status">
      <span className={`running-dot${connected && !silent ? ' breathing' : ''}`} />
      {silent ? `仍在运行 · 已 ${Math.floor(quiet / 60)} 分钟没有新输出` : '运行中'}
      {suffix}
    </div>
  );
}

// Under a background task: how long it has been waited for, and what it last said of itself when it says
// anything. A shell command says nothing; a subagent tells its tools. None of it is kept once the task ends.
// (The idea of showing that a background task is alive: #45, kilisamemarisaaa.)
export function TaskLine({
  since,
  progress,
  clock,
  connected,
}: {
  since: number;
  progress: TaskProgress | undefined;
  clock: Clock;
  connected: boolean;
}) {
  useTick(connected);
  const said =
    progress?.summary ??
    (progress?.tool
      ? `${progress.toolUses ? `第 ${progress.toolUses} 次工具调用 · ` : ''}${progress.tool}`
      : '');
  return (
    <small>
      已等待 {span((clock.now() - since) / 1000)}
      {said && ` · ${said}`}
    </small>
  );
}
