import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight } from './icons.tsx';
import { SearchExpanded } from './ConversationFind.tsx';
import type { TranscriptItem } from './transcript.ts';

type Step = Extract<TranscriptItem, { kind: 'tool' | 'user' | 'assistant' | 'thinking' }>;
// A subagent may take hundreds of steps: the first are shown, and more a hundred at a time on demand. While it is at
// work, the latest are shown instead, and earlier ones on demand.
export const FIRST_STEPS = 25;
export const MORE_STEPS = 100;

// The steps a subagent took, under its call: folded until opened, and made only once open. Searching the
// conversation opens it whole, as does a step of it that waits on an answer from here.
export default function SubagentSteps({
  steps,
  forced = false,
  running = false,
  outcome,
  children,
}: {
  steps: Step[];
  forced?: boolean;
  running?: boolean;
  // How the subagent stands: at work and for how long, done, failed or stopped.
  outcome?: string;
  children: (step: Step) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(FIRST_STEPS);
  const searching = useContext(SearchExpanded);
  const shown = open || forced || searching;
  const calls = steps.filter((step) => step.kind === 'tool').length;
  const words = steps.length - calls;
  const whole = forced || searching || steps.length <= limit;
  const visible = whole ? steps : running ? steps.slice(-limit) : steps.slice(0, limit);
  const rest = steps.length - visible.length;
  const more = rest > 0 && (
    <button
      type="button"
      className="button secondary subagent-more"
      onClick={() => setLimit(limit + MORE_STEPS)}
    >
      {running ? '显示更早的' : '再显示'} {Math.min(MORE_STEPS, rest)} 步（还有 {rest} 步）
    </button>
  );
  return (
    <details className="subagent-steps" open={shown}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (!forced && !searching) setOpen(!open);
        }}
      >
        <ChevronRight className="fold-chevron" />
        <span>
          子代理过程 · {calls} 次调用{words ? `，${words} 段说明` : ''}
        </span>
        {outcome && <small className="subagent-outcome">{outcome}</small>}
      </summary>
      {shown && (
        <div className="subagent-steps-list">
          {running && more}
          {visible.map((step) => children(step))}
          {!running && more}
        </div>
      )}
    </details>
  );
}
