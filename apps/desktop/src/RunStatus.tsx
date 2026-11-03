import { useEffect, useState } from 'react';
import type { TaskProgress } from './client.ts';
import { Spark } from './icons.tsx';
import type { TerminalActivity } from '@cc-desk-tunnel/protocol';

export function terminalState(activity?: TerminalActivity) {
  if (activity === 'working') return '终端运行中';
  if (activity === 'waiting') return '终端等你确认';
  return activity === 'idle' ? '终端打开中' : '原生终端';
}

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

// Whether a run is alive, said once, at the end of the conversation (spec §5.9): Claude's spark and "正在执行…"
// while it works. A tool that takes long tells its time in its own row above, and counts as word of the run; a run
// with no tool at work from which nothing has come for a minute says so, in words that do not call it stuck, and
// its spark rests. A run that waits for the user shows the card that asks (the approval, the question), not a line
// about it, unless that card cannot be answered from here. Finished, nothing is said; failed or stopped, the
// turn's own notice says so and offers to go on (RunNotice.tsx). With the connection gone, what the run is doing
// is not known, and that is what it says.
// (The idea of telling a live run from a silent one: #47, kilisamemarisaaa.)
export function RunStatus({
  tool,
  since,
  clock,
  connected,
  waiting,
  suffix,
}: {
  // A tool is at work now.
  tool: boolean;
  since: number;
  clock: Clock;
  connected: boolean;
  // The run waits for an answer that no card here can give (another window's run, or none to press).
  waiting?: 'approval' | 'question';
  suffix: string;
}) {
  useTick(!tool && connected && !waiting, 5000);
  const quiet = (clock.now() - since) / 1000;
  // Nothing heard from the run at all (opened from the list, before any word) is not a silence of an hour.
  const silent = !tool && since > 0 && quiet >= 60;
  if (!connected)
    return (
      <div className="run-indicator uncertain" role="status">
        <span className="running-dot" />
        连接中断 · 任务状态待确认
      </div>
    );
  if (waiting)
    return (
      <div className="run-indicator waiting" role="status">
        <span className="running-dot" />
        {waiting === 'question' ? '等待回答' : '等待审批'}
        {suffix}
      </div>
    );
  return (
    <div className={`run-indicator${silent ? ' silent' : ''}`} role="status">
      <Spark className={`run-spark${silent ? '' : ' breathing'}`} />
      <span className={silent ? undefined : 'run-shimmer'}>
        {silent ? `仍在运行 · 已 ${Math.floor(quiet / 60)} 分钟没有新输出` : '正在执行…'}
      </span>
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
