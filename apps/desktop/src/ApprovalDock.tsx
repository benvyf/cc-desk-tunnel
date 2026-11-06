import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ListChecks,
  MessageSquare,
  Play,
  ShieldAlert,
  Square,
  X,
} from './icons.tsx';
import { IconButton } from './ui.tsx';
import { CopyButton } from './copy.tsx';
import { questionsOf } from './QuestionCard.tsx';
import type { Question } from './QuestionCard.tsx';
import { approvalQuestion, toolInput } from './ToolInput.tsx';

const RichText = lazy(() => import('./RichText.tsx'));

// What waits on the user, docked where the input box was (Composer.tsx keeps a slot for it): Claude's questions one
// at a time, a plan to approve, or a tool call to allow. The conversation keeps one line for the call; the answer is
// given here, where the eye already is when a turn stops — not up in the transcript, where a reader who scrolled
// away would miss it. The answers go back exactly as the inline card sends them (keyed by question text).
//
// The input box is still there underneath, with its draft: "输入消息" folds the dock into a bar over it, for a
// follow-up, a quote, or another approval mode before answering. Folded, the dock keeps what was chosen so far.
export type DockTool = { name: string; input: string; approvalId?: string };

// When a key was last pressed anywhere: a dock that comes up while the user is typing must not take the focus, or
// the next digit and Enter meant for the message would answer the question.
let lastKeyAt = -Infinity;
let tracking = false;
function trackKeys() {
  if (tracking) return;
  tracking = true;
  document.addEventListener('keydown', () => (lastKeyAt = performance.now()), true);
}
const TYPING_PAUSE = 1000;

export default function ApprovalDock({
  tool,
  more,
  disabled,
  reply,
  stop,
  folded,
  fold,
}: {
  tool: DockTool;
  // Other calls waiting behind this one, answered after it.
  more: number;
  disabled: boolean;
  reply: (allowed: boolean, answers?: Record<string, string>) => void;
  // The input box's stop button goes with the box; the dock carries it while it stands in for the box. Absent where
  // the box would not offer it either.
  stop?: { run: () => void; disabled: boolean };
  // Folded into a bar over the input box, and back.
  folded: boolean;
  fold: (folded: boolean) => void;
}) {
  const root = useRef<HTMLElement>(null);
  // The focus was in the dock and fell to the page with an element that went (a page turned, a control disabled):
  // it comes back to the dock, so the keys go on answering.
  const holding = useRef(false);
  useEffect(() => {
    trackKeys();
    const element = root.current;
    if (!element) return;
    // The input box this replaces had the focus (hidden, it may already have dropped it to the page): it moves here,
    // so the keys answer at once — unless the user was typing a moment ago. Focus anywhere else (a dialog, the
    // sidebar, the other conversation's box) stays where it is.
    const stack = element.closest('.composer-stack');
    const active = document.activeElement;
    const ownBox = !active || active === document.body || (!!stack && stack.contains(active));
    if (!folded && ownBox && performance.now() - lastKeyAt > TYPING_PAUSE) {
      element.focus({ preventScroll: true });
      holding.current = true;
    }
    // Answered, the dock goes and the input box comes back: the focus goes back to it if it was here.
    return () => {
      if (!element.contains(document.activeElement) && document.activeElement !== document.body)
        return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        stack
          ?.querySelector<HTMLTextAreaElement>('.composer textarea')
          ?.focus({ preventScroll: true });
      });
    };
  }, []);
  const regain = () => {
    if (holding.current && (!document.activeElement || document.activeElement === document.body))
      root.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(regain, [disabled]);
  const track = {
    onFocus: () => (holding.current = true),
    onBlur: (event: React.FocusEvent) => {
      // Leaving for another place, not because the focused element went away.
      if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node))
        holding.current = false;
    },
  };
  const questions = tool.name === 'AskUserQuestion' ? questionsOf(tool.input) : null;
  const waiting = more > 0 && <span className="approval-dock-more">另有 {more} 项等待</span>;
  // Last in the order of keys, so Tab from the dock reaches the answer before it reaches "stop"; shown at the left.
  const stopButton = stop && (
    <IconButton
      title="停止运行"
      className="stop-button"
      disabled={stop.disabled}
      onClick={stop.run}
    >
      <Square />
    </IconButton>
  );
  const unfold = () => {
    fold(false);
    requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
  };
  const tail = (pager?: ReactNode) => (
    <span className="approval-dock-tail">
      {pager}
      <button
        type="button"
        className="button ghost approval-dock-fold"
        title="先收起，用输入框发消息；回答留到稍后"
        onClick={() => {
          fold(true);
          requestAnimationFrame(() =>
            root.current
              ?.closest('.composer-stack')
              ?.querySelector<HTMLTextAreaElement>('.composer textarea')
              ?.focus({ preventScroll: true }),
          );
        }}
      >
        <MessageSquare />
        输入消息
      </button>
    </span>
  );
  const kind = questions ? 'question' : tool.name === 'ExitPlanMode' ? 'plan' : 'tool';
  const folding = folded && (
    <div className="approval-dock-bar" role="status">
      {kind === 'question' ? <CircleHelp /> : kind === 'plan' ? <ListChecks /> : <ShieldAlert />}
      <span>
        {kind === 'question'
          ? `Claude 在等你回答：${questions![0].question}`
          : kind === 'plan'
            ? 'Claude 在等你批准计划'
            : `Claude 在等你审批：${approvalQuestion(tool.name)}`}
      </span>
      {waiting}
      <button type="button" className="button secondary" onClick={unfold}>
        {kind === 'question' ? '去回答' : '去处理'}
      </button>
    </div>
  );
  let dock: ReactNode;
  if (questions)
    dock = (
      <Questions
        root={root}
        track={track}
        regain={regain}
        folded={folded}
        questions={questions}
        disabled={disabled}
        waiting={waiting}
        tail={tail}
        stopButton={stopButton}
        answer={(answers) => reply(true, answers)}
        skip={() => reply(false)}
      />
    );
  else if (kind === 'plan') {
    const plan = planOf(tool.input);
    dock = (
      <section
        ref={root}
        tabIndex={-1}
        hidden={folded}
        className="approval-dock plan"
        aria-label="计划审批"
        data-tool={tool.name}
        {...track}
      >
        <header className="approval-dock-head">
          <ListChecks />
          <span>计划审批</span>
          {waiting}
          {tail()}
        </header>
        <p className="approval-dock-title">Claude 拟好了计划，按这个计划开始执行吗？</p>
        <div className="approval-dock-body">
          <div className="approval-dock-box approval-dock-plan message-content">
            {plan ? (
              <Suspense fallback={<pre>{plan}</pre>}>
                <RichText text={plan} />
              </Suspense>
            ) : (
              <p className="approval-dock-note">Claude 没有附上计划内容。</p>
            )}
          </div>
        </div>
        <footer className="approval-actions approval-dock-actions">
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
          {stopButton}
        </footer>
      </section>
    );
  } else {
    const input = toolInput(tool.name, tool.input);
    dock = (
      <section
        ref={root}
        tabIndex={-1}
        hidden={folded}
        className="approval-dock tool"
        aria-label="需要你的许可"
        data-tool={tool.name}
        {...track}
      >
        <header className="approval-dock-head">
          <ShieldAlert />
          <span>需要你的许可</span>
          {waiting}
          {tail()}
        </header>
        <p className="approval-dock-title approval-title">{approvalQuestion(tool.name)}</p>
        <div className="approval-dock-body">
          <div className="approval-dock-box tool-section tool-input">
            <div className="tool-section-head">
              <span>{input.label}</span>
              <CopyButton text={input.copy} label="复制工具输入" />
            </div>
            {input.body}
          </div>
        </div>
        <footer className="approval-actions approval-dock-actions">
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
          {stopButton}
        </footer>
      </section>
    );
  }
  return (
    <>
      {folding}
      {dock}
    </>
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

// One question on the page at a time, as Claude's own app asks them: numbers pick a choice, the number after the
// choices is the answer in the user's own words, Enter goes on, ← → turn the pages, ↑ ↓ move between the choices.
// A single choice moves on to the next question by itself; the last one waits for "提交回答", so nothing is sent by
// a stray key.
function Questions({
  root,
  track,
  regain,
  folded,
  questions,
  disabled,
  waiting,
  tail,
  stopButton,
  answer,
  skip,
}: {
  root: RefObject<HTMLElement | null>;
  track: { onFocus: () => void; onBlur: (event: React.FocusEvent) => void };
  regain: () => void;
  folded: boolean;
  questions: Question[];
  disabled: boolean;
  waiting: ReactNode;
  tail: (pager?: ReactNode) => ReactNode;
  stopButton: ReactNode;
  answer: (answers: Record<string, string>) => void;
  skip: () => void;
}) {
  const id = useId();
  const [page, setPage] = useState(0);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const otherInput = useRef<HTMLInputElement>(null);
  // The choice whose preview shows (an option may carry one, Markdown): the one with the focus, else the one picked.
  // Not the one under the pointer: the dock grows upwards with a preview, and would move the choice from under it.
  const [looking, setLooking] = useState<number | null>(null);
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined);
  // An IME's Enter that ends a composition is the IME's, also in the moment after it ends (as in Composer.tsx).
  const composedAt = useRef(-Infinity);
  useEffect(() => () => clearTimeout(advance.current), []);
  // A turned page drops the focused choice with the old page.
  useLayoutEffect(regain, [page]);
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
  const preview =
    options[looking ?? options.findIndex(({ label }) => chosen[question]?.includes(label))]
      ?.preview;
  // Keys reach nine: the choices beyond have no number, and the answer of one's own then has none either.
  const numbered = (index: number) => index < 9;
  const turn = (to: number) => {
    clearTimeout(advance.current);
    setLooking(null);
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
    const native = event.nativeEvent;
    if (native.isComposing || native.keyCode === 229) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const typing = target instanceof HTMLInputElement;
    if (event.key === 'Enter') {
      // A held Enter would run through the pages and send; a button's own Enter presses it.
      if (event.repeat || event.shiftKey || performance.now() - composedAt.current < 10) {
        event.preventDefault();
        return;
      }
      if (target instanceof HTMLButtonElement && target.type === 'button') return;
      event.preventDefault();
      go();
    } else if (typing) {
      return;
    } else if (/^[1-9]$/.test(event.key) && !event.shiftKey) {
      const index = Number(event.key) - 1;
      if (index < options.length) pick(options[index].label);
      else if (index === options.length) otherInput.current?.focus();
      else return;
      event.preventDefault();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const choices = [
        ...(root.current?.querySelectorAll<HTMLElement>(
          '.question-option, .question-other input',
        ) ?? []),
      ];
      const at = choices.indexOf(target);
      const next =
        at === -1
          ? event.key === 'ArrowDown'
            ? 0
            : choices.length - 1
          : Math.max(0, Math.min(choices.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
      choices[next]?.focus();
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
      ref={root as RefObject<HTMLFormElement>}
      tabIndex={-1}
      hidden={folded}
      className="approval-dock question"
      aria-label="Claude 的提问"
      data-tool="AskUserQuestion"
      onKeyDown={keys}
      onCompositionEnd={() => (composedAt.current = performance.now())}
      onSubmit={(event) => {
        event.preventDefault();
        go();
      }}
      {...track}
    >
      <header className="approval-dock-head">
        <CircleHelp />
        <span>Claude 的提问</span>
        {waiting}
        {tail(
          questions.length > 1 && (
            <span className="approval-dock-pager" role="group" aria-label="翻页">
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
            </span>
          ),
        )}
      </header>
      <fieldset key={page} className="approval-dock-question" disabled={disabled}>
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
                key={index}
                role={multiSelect ? 'checkbox' : 'radio'}
                aria-checked={picked}
                aria-label={label}
                aria-describedby={description ? `${id}-${page}-${index}` : undefined}
                className="question-option"
                onClick={() => pick(label)}
                onFocus={() => setLooking(index)}
                onBlur={() => setLooking(null)}
              >
                {numbered(index) ? <kbd aria-hidden="true">{index + 1}</kbd> : <i />}
                <span>
                  {label}
                  {description && <small id={`${id}-${page}-${index}`}>{description}</small>}
                </span>
                {picked && <Check />}
              </button>
            );
          })}
          <label className="question-other">
            {numbered(options.length) ? <kbd aria-hidden="true">{options.length + 1}</kbd> : <i />}
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
          {preview && (
            <div
              className="approval-dock-box approval-dock-preview message-content"
              aria-label="选项预览"
            >
              <Suspense fallback={<pre>{preview}</pre>}>
                <RichText text={preview} />
              </Suspense>
            </div>
          )}
        </div>
      </fieldset>
      <footer className="approval-actions approval-dock-actions">
        <small className="approval-dock-hint keys">
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
        {stopButton}
      </footer>
    </form>
  );
}
