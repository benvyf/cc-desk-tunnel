import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ListChecks,
  Play,
  ShieldAlert,
  Square,
  X,
} from './icons.tsx';
import { IconButton } from './ui.tsx';
import { questionsOf } from './QuestionCard.tsx';
import type { Question } from './QuestionCard.tsx';
import { approvalQuestion, toolInput } from './ToolInput.tsx';

const RichText = lazy(() => import('./RichText.tsx'));

// What waits on the user, docked where the input box was (Composer.tsx keeps a slot for it): Claude's questions one
// at a time, a plan to approve, or a tool call to allow. The conversation keeps one line for the call; the answer is
// given here, where the eye already is when a turn stops — not up in the transcript, where a reader who scrolled
// away would miss it. The answers go back exactly as the inline card sends them (keyed by question text).
export type DockTool = { name: string; input: string; approvalId?: string };

export default function ApprovalDock({
  tool,
  more,
  disabled,
  reply,
  stop,
}: {
  tool: DockTool;
  // Other calls waiting behind this one, answered after it.
  more: number;
  disabled: boolean;
  reply: (allowed: boolean, answers?: Record<string, string>) => void;
  // The input box's stop button goes with the box; the dock carries it while it stands in for the box.
  stop: { run: () => void; disabled: boolean };
}) {
  const root = useRef<HTMLElement>(null);
  // The input box this replaces had the focus (or, hidden, has just dropped it to the page): it moves here, so the
  // keys answer at once. Focus anywhere else (a dialog, the sidebar) stays where it is.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('.composer'))
      root.current?.focus({ preventScroll: true });
  }, []);
  const questions = tool.name === 'AskUserQuestion' ? questionsOf(tool.input) : null;
  const waiting = more > 0 && <span className="approval-dock-more">另有 {more} 项等待</span>;
  const stopButton = (
    <IconButton
      title="停止运行"
      className="stop-button"
      disabled={stop.disabled}
      onClick={stop.run}
    >
      <Square />
    </IconButton>
  );
  if (questions)
    return (
      <Questions
        root={root}
        questions={questions}
        disabled={disabled}
        waiting={waiting}
        stopButton={stopButton}
        answer={(answers) => reply(true, answers)}
        skip={() => reply(false)}
      />
    );
  if (tool.name === 'ExitPlanMode') {
    const plan = planOf(tool.input);
    return (
      <section
        ref={root}
        tabIndex={-1}
        className="approval-dock plan"
        aria-label="计划审批"
        data-tool={tool.name}
      >
        <header className="approval-dock-head">
          <ListChecks />
          <span>计划审批</span>
          {waiting}
        </header>
        <p className="approval-dock-title">Claude 拟好了计划，按这个计划开始执行吗？</p>
        <div className="approval-dock-body approval-dock-plan" data-search-content>
          {plan ? (
            <Suspense fallback={<pre>{plan}</pre>}>
              <RichText text={plan} />
            </Suspense>
          ) : (
            <p className="approval-dock-note">Claude 没有附上计划内容。</p>
          )}
        </div>
        <footer className="approval-actions approval-dock-actions">
          {stopButton}
          <small className="approval-dock-hint">
            选“继续规划”后，可在输入框告诉 Claude 要改什么
          </small>
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() => reply(false)}
          >
            <X />
            继续规划
          </button>
          <button
            type="button"
            className="button primary"
            disabled={disabled}
            onClick={() => reply(true)}
          >
            <Play />
            批准并执行
          </button>
        </footer>
      </section>
    );
  }
  const input = toolInput(tool.name, tool.input);
  return (
    <section
      ref={root}
      tabIndex={-1}
      className="approval-dock tool"
      aria-label="需要你的许可"
      data-tool={tool.name}
    >
      <header className="approval-dock-head">
        <ShieldAlert />
        <span>需要你的许可</span>
        {waiting}
      </header>
      <p className="approval-dock-title approval-title">{approvalQuestion(tool.name)}</p>
      <div className="approval-dock-body tool-input">{input.body}</div>
      <footer className="approval-actions approval-dock-actions">
        {stopButton}
        <button
          type="button"
          className="button secondary"
          disabled={disabled}
          onClick={() => reply(false)}
        >
          <X />
          拒绝
        </button>
        <button
          type="button"
          className="button primary"
          disabled={disabled}
          onClick={() => reply(true)}
        >
          <Check />
          允许
        </button>
      </footer>
    </section>
  );
}

function planOf(input: string) {
  try {
    const { plan } = JSON.parse(input);
    return typeof plan === 'string' ? plan.trim() : '';
  } catch {
    return '';
  }
}

// One question on the page at a time, as Claude's own app asks them: numbers pick a choice, the last number is the
// answer in the user's own words, Enter goes on, ← → turn the pages. A single choice moves on to the next question
// by itself; the last one waits for "提交回答", so nothing is sent by a stray key.
function Questions({
  root,
  questions,
  disabled,
  waiting,
  stopButton,
  answer,
  skip,
}: {
  root: React.RefObject<HTMLElement | null>;
  questions: Question[];
  disabled: boolean;
  waiting: ReactNode;
  stopButton: ReactNode;
  answer: (answers: Record<string, string>) => void;
  skip: () => void;
}) {
  const [page, setPage] = useState(0);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const otherInput = useRef<HTMLInputElement>(null);
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(advance.current), []);
  const answerOf = (question: string) =>
    [
      ...(chosen[question] ?? []),
      ...(other[question]?.trim() ? [other[question].trim()] : []),
    ].join(', ');
  const answers = Object.fromEntries(
    questions.map(({ question }) => [question, answerOf(question)]),
  );
  const complete = Object.values(answers).every(Boolean);
  const last = page === questions.length - 1;
  const { question, header, multiSelect, options } = questions[page];
  const turn = (to: number) => {
    clearTimeout(advance.current);
    setPage(Math.max(0, Math.min(questions.length - 1, to)));
  };
  const pick = (label: string) => {
    if (disabled) return;
    const picked = chosen[question]?.includes(label) ?? false;
    setChosen((current) => {
      const now = current[question] ?? [];
      return {
        ...current,
        [question]: !multiSelect
          ? picked
            ? []
            : [label]
          : picked
            ? now.filter((item) => item !== label)
            : [...now, label],
      };
    });
    if (multiSelect) return;
    // One choice among alternatives replaces an answer typed before, and leads on to the next question.
    setOther((current) => ({ ...current, [question]: '' }));
    clearTimeout(advance.current);
    if (!picked && !last) advance.current = setTimeout(() => turn(page + 1), 180);
  };
  const go = () => {
    if (disabled) return;
    if (!last) return turn(page + 1);
    if (complete) answer(answers);
    // Sent with a question left open, it would have nothing to say for it: show the first one that waits.
    else turn(questions.findIndex((item) => !answerOf(item.question)));
  };
  const keys = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const typing = event.target instanceof HTMLInputElement;
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLButtonElement && event.target.type === 'button') return;
      event.preventDefault();
      go();
    } else if (typing) {
      return;
    } else if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < options.length) pick(options[index].label);
      else if (index === options.length) otherInput.current?.focus();
      else return;
      event.preventDefault();
    } else if (event.key === 'ArrowLeft' && page > 0) {
      event.preventDefault();
      turn(page - 1);
    } else if (event.key === 'ArrowRight' && !last) {
      event.preventDefault();
      turn(page + 1);
    }
  };
  return (
    <form
      ref={root as React.RefObject<HTMLFormElement>}
      tabIndex={-1}
      className="approval-dock question"
      aria-label="Claude 的提问"
      data-tool="AskUserQuestion"
      onKeyDown={keys}
      onSubmit={(event) => {
        event.preventDefault();
        go();
      }}
    >
      <header className="approval-dock-head">
        <CircleHelp />
        <span>Claude 的提问</span>
        {waiting}
        {questions.length > 1 && (
          <nav className="approval-dock-pager" aria-label="翻页">
            <button
              type="button"
              className="icon-button"
              aria-label="上一个问题"
              disabled={page === 0}
              onClick={() => turn(page - 1)}
            >
              <ChevronLeft />
            </button>
            <span aria-live="polite">
              {page + 1} / {questions.length}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="下一个问题"
              disabled={last}
              onClick={() => turn(page + 1)}
            >
              <ChevronRight />
            </button>
          </nav>
        )}
      </header>
      <fieldset key={question} className="approval-dock-question" disabled={disabled}>
        <legend className="approval-dock-title">
          {header && <span className="question-header">{header}</span>}
          {question}
          {multiSelect && <small>可多选</small>}
        </legend>
        <div className="approval-dock-body approval-dock-options">
          {options.map(({ label, description }, index) => {
            const picked = chosen[question]?.includes(label) ?? false;
            return (
              <button
                type="button"
                key={label}
                role={multiSelect ? 'checkbox' : 'radio'}
                aria-checked={picked}
                aria-label={label}
                className="question-option"
                onClick={() => pick(label)}
              >
                <kbd aria-hidden="true">{index + 1}</kbd>
                <span>
                  {label}
                  {description && <small>{description}</small>}
                </span>
                {picked && <Check />}
              </button>
            );
          })}
          <label className="question-other">
            <kbd aria-hidden="true">{options.length + 1}</kbd>
            <input
              ref={otherInput}
              aria-label={`其他回答：${question}`}
              placeholder="其他（自己写）"
              maxLength={2000}
              value={other[question] ?? ''}
              onChange={(event) => {
                setOther((current) => ({ ...current, [question]: event.target.value }));
                if (!multiSelect && event.target.value)
                  setChosen((current) => ({ ...current, [question]: [] }));
              }}
            />
          </label>
        </div>
      </fieldset>
      <footer className="approval-actions approval-dock-actions">
        {stopButton}
        <small className="approval-dock-hint">
          数字键选择 · Enter {last ? '提交' : '下一题'}
          {questions.length > 1 && ' · ← → 翻页'}
        </small>
        <button type="button" className="button secondary" disabled={disabled} onClick={skip}>
          <X />
          不回答
        </button>
        {last ? (
          <button type="submit" className="button primary" disabled={disabled || !complete}>
            <Check />
            提交回答
          </button>
        ) : (
          <button type="submit" className="button primary" disabled={disabled}>
            下一题
            <ChevronRight />
          </button>
        )}
      </footer>
    </form>
  );
}
