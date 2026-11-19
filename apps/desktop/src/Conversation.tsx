import {
  createContext,
  memo,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUpToLine,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  FileCode,
  FileText,
  FoldVertical,
  Globe,
  ListChecks,
  LoaderCircle,
  Pencil,
  Search,
  Spark,
  SquareTerminal,
  Wrench,
  X,
} from './icons.tsx';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { describe, duration, summarize } from './activity.ts';
import type { Category } from './activity.ts';
import type { HistoryState, TaskProgress } from './client.ts';
import { RunStatus, TaskLine, terminalState } from './RunStatus.tsx';
import RunNotice from './RunNotice.tsx';
import { approvalQuestion, toolInput } from './ToolInput.tsx';
import type { Clock } from './RunStatus.tsx';
import QuestionCard, { questionsOf } from './QuestionCard.tsx';
import ApprovalDock from './ApprovalDock.tsx';
import { calls, conversation, keepTurns, manyModels as answeredByMany } from './transcript.ts';
import { modelName } from './modelName.ts';
import SubagentSteps from './SubagentSteps.tsx';
import { usePrefs } from './prefs.ts';
import ThinkingAccordion from './ThinkingAccordion.tsx';
import type { Compact, Notice, TranscriptItem, Turn, Work } from './transcript.ts';
import { CopyButton, copyText } from './copy.tsx';
import { messageTime } from './messageTime.ts';
import TurnStats from './TurnStats.tsx';
import ConversationFind, { SearchExpanded } from './ConversationFind.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import Presence from './Presence.tsx';
import { MessageAttachments } from './AttachmentTiles.tsx';
import {
  attachmentMessage,
  plainPastedText,
  splitAttachmentMessage,
  splitPastedText,
} from './attachments.ts';
import { LinkPlace, linkDoubt, linkTarget } from './links.ts';
import { useLinkDoubt } from './LinkDoubt.tsx';
import { FileMentionPaths, producedFiles } from './fileMentions.ts';
import type { Link } from './links.ts';
import { followLink, linkMenu } from './linkActions.ts';
import { previewWebsite } from './preview.ts';
import QuoteChips from './QuoteChips.tsx';
import { splitQuoteMessage, quoteCopyText } from './quotes.ts';
import {
  QuoteActionsContext,
  AnswerQuoteActions,
  QuoteSelection,
  assistantSelection,
} from './QuoteActions.tsx';
import type { QuoteDestination } from './QuoteActions.tsx';
import ConversationWidthControls from './ConversationWidthControls.tsx';
import { picturesOf } from './pictures.ts';
import {
  LivePictures,
  PictureRow,
  PictureStrip,
  TurnPictures,
  useSamePictures,
} from './PictureStrip.tsx';
import { updatePictures } from './PictureViewer.tsx';
import type { PictureEntry } from './PictureViewer.tsx';
import TurnNavigator from './TurnNavigator.tsx';

const RichText = lazy(() => import('./RichText.tsx'));
const Rich = ({
  text,
  streaming = false,
  question = false,
}: {
  text: string;
  streaming?: boolean;
  question?: boolean;
}) => (
  <Suspense fallback={<p>{text}</p>}>
    <RichText text={text} streaming={streaming} question={question} />
  </Suspense>
);

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Text = Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'thinking' }>;
// What the rows need from the session: the clock for running timers and how to answer an approval.
type Live = {
  now: number;
  busy: boolean;
  canApprove: (tool: Tool) => boolean;
  // The approval is answered in the dock where the input box stands (ApprovalDock.tsx), not in the transcript.
  docked: boolean;
  // This window has answered the approval and waits for the service to take it: a second press would be
  // a second answer.
  answered: (tool: Tool) => boolean;
  reply: (tool: Tool, allowed: boolean, answers?: Record<string, string>) => void;
  // The foreground task a running call waits on, while this window may act on it: 'sent' once it has, until
  // the call returns.
  taskControl: (tool: Tool) => 'ready' | 'sent' | undefined;
  endTool: (tool: Tool) => void;
  backgroundTool: (tool: Tool) => void;
  // Absent while a fork cannot be made.
  edit?: (item: Text) => void;
};
const icons: Record<Category, typeof Wrench> = {
  command: SquareTerminal,
  edit: FileCode,
  read: FileText,
  search: Search,
  web: Globe,
  agent: Bot,
  question: CircleHelp,
  plan: ListChecks,
  other: Wrench,
};

// A fold that the reader controls, except while something inside needs an answer.
function Fold({
  className,
  forced = false,
  summary,
  children,
}: {
  className: string;
  forced?: boolean;
  // Given whether the fold is open, for a heading that shows what the open fold would show twice.
  summary: React.ReactNode | ((shown: boolean) => React.ReactNode);
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searching = useContext(SearchExpanded);
  const shown = open || forced || searching;
  return (
    <details className={className} open={shown}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (!forced && !searching) setOpen(!open);
        }}
      >
        <ChevronRight className="fold-chevron" />
        {typeof summary === 'function' ? summary(shown) : summary}
      </summary>
      {shown && children()}
    </details>
  );
}

// What a link leads to, beside it: shown while the pointer rests on the link, and after a click with what came of
// it (a note), so that why a path cannot be opened is read where it was clicked.
type LinkCard = {
  top: number;
  left: number;
  above: boolean;
  link: Link;
  note?: string;
  // Why a click on this web link asks first (see `linkDoubt`).
  doubt?: string | null;
};
function LinkCardView({ card }: { card: LinkCard }) {
  const { link, note, doubt } = card;
  const target =
    link.kind === 'web'
      ? link.url
      : link.kind === 'path' && link.line
        ? `${link.path}:${link.line}`
        : link.path;
  const hint =
    link.kind === 'web'
      ? doubt
        ? `${doubt}点击先确认地址 · 右键可复制地址`
        : '点击在浏览器中打开 · 右键可复制地址'
      : link.kind === 'path'
        ? '点击打开 · 右键查看更多操作'
        : `${link.reason}右键可复制路径。`;
  return (
    <div
      className={`link-card${card.above ? ' above' : ''}`}
      role="tooltip"
      style={{ top: card.top, left: card.left }}
    >
      <span className="link-card-target">{target}</span>
      {note ? (
        <strong>{note}</strong>
      ) : (
        <small className={link.kind === 'elsewhere' || doubt ? 'link-card-warn' : undefined}>
          {hint}
        </small>
      )}
    </div>
  );
}

// What may be done with the task a running call waits on, in the call's line or in the heading of its shut group.
function TaskActions({
  tool,
  control,
  live,
}: {
  tool: Tool;
  control: 'ready' | 'sent';
  live: Live;
}) {
  return (
    <span className="tool-task-actions">
      <button
        type="button"
        className="button"
        disabled={control === 'sent' || live.busy}
        title="命令接着运行，Claude 不再等它，先做别的；命令结束后 Claude 会收到结果"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          live.backgroundTool(tool);
        }}
      >
        转后台
      </button>
      <button
        type="button"
        className="button"
        disabled={control === 'sent' || live.busy}
        title="只结束这一条，这一轮不停止，Claude 会接着处理"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          live.endTool(tool);
        }}
      >
        终止
      </button>
    </span>
  );
}

// Inside an open step whose row shows its pictures, its calls' lines leave them to the row: shown once, and made once.
const PictureStep = createContext(false);

function ToolRow({ tool, active, live }: { tool: Tool; active: boolean; live: Live }) {
  const { category, verb, subject, added, removed, running, failed } = describe(tool, active);
  const Icon = icons[category];
  const pictures = tool.pictures ?? null;
  const inPictureStep = useContext(PictureStep);
  const approval = live.canApprove(tool);
  const control = live.taskControl(tool);
  // A question Claude asks is answered, not allowed or denied. With the dock below, the answer is given there and
  // the transcript keeps the call's line, marked as waiting.
  const questions = tool.name === 'AskUserQuestion' ? questionsOf(tool.input) : null;
  const docked = approval && live.docked;
  // A step of its subagent's that asks here, not in the dock, keeps the call open on it.
  const childAsks =
    !live.docked && calls(tool.children ?? []).some((child) => live.canApprove(child));
  if (approval && questions && !docked)
    return (
      <QuestionCard
        questions={questions}
        busy={live.busy || live.answered(tool)}
        answer={(answers) => live.reply(tool, true, answers)}
        skip={() => live.reply(tool, false)}
      />
    );
  return (
    <Fold
      className={`tool ${failed ? 'failed' : ''}${docked ? ' docked' : ''}${
        category === 'question' || category === 'plan' ? ' asked' : ''
      }`}
      forced={(approval && !docked) || childAsks}
      summary={(shown) => (
        <span className="tool-heading">
          {running ? <LoaderCircle className="spinning" /> : <Icon />}
          <span className="tool-verb">{verb}</span>
          <span className="tool-subject" title={subject}>
            {subject}
          </span>
          {/* Open, the output shows them in a row; inside an open step, the step's row shows them already. */}
          {pictures && !shown && !inPictureStep && (
            <PictureStrip pictures={pictures.pictures} label="这次调用的图片" />
          )}
          {(added > 0 || removed > 0) && (
            <span className="tool-diff">
              <ins>+{added}</ins>
              <del>−{removed}</del>
            </span>
          )}
          <span className="tool-time">
            {tool.target === 'Windows (simulation)' && '模拟 · '}
            {tool.endedAt
              ? duration(tool.at, tool.endedAt)
              : running && duration(tool.at, live.now)}
          </span>
          {control && <TaskActions tool={tool} control={control} live={live} />}
          {docked && <span className="tool-await">在下方{questions ? '回答' : '处理'}</span>}
        </span>
      )}
    >
      {() => {
        // The input in the shape its tool reads (ToolInput.tsx); "input" and "output" head their parts of the card,
        // with copy beside them under the pointer.
        const input = toolInput(tool.name, tool.input);
        const exit =
          tool.exitCode !== null && tool.exitCode !== undefined ? `退出码 ${tool.exitCode}` : '';
        const output = pictures ? pictures.text : tool.output || tool.liveOutput;
        // A subagent's last words are its answer, which is its call's output as well: shown once, as the output.
        const last = tool.children?.at(-1);
        const steps =
          last?.kind === 'assistant' && tool.output && saidIn(tool.output, last.text)
            ? tool.children!.slice(0, -1)
            : (tool.children ?? []);
        return (
          <div className="tool-detail">
            {approval && !docked && <p className="approval-title">{approvalQuestion(tool.name)}</p>}
            <div className="tool-section tool-input">
              <div className="tool-section-head">
                <span>{input.label}</span>
                <CopyButton text={input.copy} label="复制工具输入" />
              </div>
              {input.body}
            </div>
            {steps.length ? (
              <SubagentSteps
                steps={steps}
                forced={childAsks}
                running={!tool.endedAt}
                // How the subagent stands and how long it has taken, on the folded line.
                // At work only while its call is (as its heading says); a call that never got its result — the run
                // stopped or was cut off — is not at work for ever.
                outcome={
                  running
                    ? `进行中 ${duration(tool.at, live.now)}`
                    : !tool.endedAt
                      ? '未完成'
                      : `${
                          tool.state === 'failed'
                            ? '失败'
                            : tool.state === 'unknown'
                              ? '结果未知'
                              : tool.state === 'cancelled' || tool.state === 'denied'
                                ? '已停止'
                                : '已完成'
                        } · ${duration(tool.at, tool.endedAt)}`
                }
              >
                {(step) =>
                  step.kind === 'tool' ? (
                    <ToolRow key={step.id} tool={step} active={active} live={live} />
                  ) : (
                    <SubagentWords key={step.id} step={step} />
                  )
                }
              </SubagentSteps>
            ) : null}
            {(output || pictures) && (
              <div className="tool-section tool-results">
                {output && (
                  <>
                    <div className="tool-section-head">
                      <span>{tool.output || pictures ? '输出' : '输出（进行中）'}</span>
                      {exit && tool.output && <small>{exit}</small>}
                      <CopyButton text={output} label="复制工具输出" />
                    </div>
                    <pre className="tool-output" data-search-content>
                      {output}
                    </pre>
                  </>
                )}
                {pictures && <PictureRow pictures={pictures.pictures} label="这次调用的图片" />}
              </div>
            )}
            {approval && !docked && (
              <div className="approval-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={live.busy || live.answered(tool)}
                  onClick={() => live.reply(tool, false)}
                >
                  <X />
                  拒绝
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={live.busy || live.answered(tool)}
                  onClick={() => live.reply(tool, true)}
                >
                  <Check />
                  允许
                </button>
              </div>
            )}
          </div>
        );
      }}
    </Fold>
  );
}

// Whether a tool's output holds these words: as they are, or as a JSON string holds them.
function saidIn(output: string, text: string) {
  const words = text.trim();
  return !!words && (output.includes(words) || output.includes(JSON.stringify(words).slice(1, -1)));
}

// What a subagent said between its steps, or thought, in a line of its own under its call.
function SubagentWords({ step }: { step: Text }) {
  return (
    <div
      className={`subagent-words${step.kind === 'thinking' ? ' thinking' : ''}`}
      data-search-content
    >
      {step.kind === 'thinking' && <span className="subagent-words-label">思考</span>}
      <Rich text={step.text} />
    </div>
  );
}

// The calls and thoughts of a run, one under another.
function WorkItems({
  work,
  active,
  live,
  preview,
  until,
}: {
  work: Work;
  active: boolean;
  live: Live;
  preview?: boolean;
  until?: string;
}) {
  return (
    <>
      {work.items.map((item, index) => {
        const running = active && index === work.items.length - 1 && !until;
        return item.kind === 'tool' ? (
          <ToolRow key={item.id} tool={item} active={active} live={live} />
        ) : (
          <ThinkingAccordion key={item.id} text={item.text} running={running} preview={preview}>
            {() => (
              <div
                className={`message-content tool-detail${running ? ' streaming' : ''}`}
                data-search-content
              >
                <Rich text={item.text} streaming={running} />
              </div>
            )}
          </ThinkingAccordion>
        );
      })}
    </>
  );
}

function WorkGroup({
  work,
  active,
  latest,
  live,
  until,
}: {
  work: Work;
  active: boolean;
  latest: boolean;
  live: Live;
  until?: string;
}) {
  const { label, waiting, running, started, ended } = summarize(work, active, latest);
  // The one call of the group waited on in the foreground can be acted on without opening it; several are acted on
  // in their own lines.
  const controlled = work.items.filter(
    (item): item is Tool => item.kind === 'tool' && !!live.taskControl(item),
  );
  const control = controlled.length === 1 ? live.taskControl(controlled[0]) : undefined;
  // Folded, the group's line carries its pictures; open, each call's line carries its own.
  const pictures = useSamePictures(picturesOf(work.items));
  return (
    <Fold
      className="work"
      forced={waiting}
      summary={(shown) => (
        <span className="work-heading">
          {running && <LoaderCircle className="spinning" />}
          <span>{label}</span>
          {!waiting && <small>{duration(started, ended && !running ? ended : live.now)}</small>}
          {!shown && <PictureStrip pictures={pictures} label="这一步的图片" />}
          {control && !shown && <TaskActions tool={controlled[0]} control={control} live={live} />}
        </span>
      )}
    >
      {() => (
        <PictureStep.Provider value={pictures.length > 0}>
          {pictures.length > 0 && <PictureRow pictures={pictures} label="这一步的图片" />}
          <WorkItems work={work} active={active} live={live} until={until} />
        </PictureStep.Provider>
      )}
    </Fold>
  );
}

// A question's own words, in Markdown as Claude shows them; a line break typed in it stays a line break (style.css).
// A long one, most often something pasted, is cut to its first ten lines (style.css) and opened on demand, as in
// Claude; one only a little longer than that is shown whole. Searching the conversation opens every one.
const foldFrom = 16;
function Bubble({ text, children }: { text: string; children?: ReactNode }) {
  const bubble = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = useId();
  const searching = useContext(SearchExpanded);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  // Short questions, nearly all of them, are not measured at all.
  const maybe = text.length > 200 || text.split('\n', foldFrom).length >= foldFrom;
  useLayoutEffect(() => {
    const element = body.current;
    if (!maybe || !element) {
      setLong(false);
      return;
    }
    const measure = () => {
      // A message off screen is not laid out (content-visibility) and measures nothing; it is measured once shown.
      // The height scrolled is the whole text's, folded or not.
      if (!element.scrollHeight) return;
      const line = parseFloat(getComputedStyle(element).lineHeight) || 19;
      setLong(element.scrollHeight > line * foldFrom);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maybe, text]);
  const folded = long && !open && !searching;
  return (
    <div className="user-bubble" ref={bubble}>
      {children}
      {text && (
        <div className="user-text" id={id} ref={body} data-folded={folded || undefined}>
          <Rich text={text} question />
        </div>
      )}
      {long && !searching && (
        <button
          type="button"
          className="bubble-fold"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setOpen(!open);
            // Folding a question read to its end brings its start back into view rather than leaving the reader
            // further down the conversation.
            if (open)
              requestAnimationFrame(() => bubble.current?.scrollIntoView({ block: 'nearest' }));
          }}
        >
          {open ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

// No message has a heading; what belongs to it is in a line under it, shown while the pointer is over the message. Under
// a question: how it was delivered, its time, copy and editing, always shown at the right like the question. Under the reply that
// closes a turn: copy, the turn's figures and the time, always shown on the latest. Replies said along the way have
// nothing under them. A delivery that did not plainly arrive stays in sight. Replies of the simulated service keep the
// heading, which says they are not real.
function Message({
  item,
  native,
  edit,
  footer,
  closing = false,
  latest = false,
  joined = false,
  streaming = false,
  model,
}: {
  item: Text;
  native: boolean;
  // The model that wrote the reply, beside its time: shown where more than one answered in the session.
  model?: string;
  edit?: (item: Text) => void;
  footer?: ReactNode;
  closing?: boolean;
  latest?: boolean;
  // A question put in while the run went on.
  joined?: boolean;
  streaming?: boolean;
}) {
  const time = messageTime(item.kind === 'assistant' ? (item.doneAt ?? item.at) : item.at);
  const user = item.kind === 'user';
  const [controlsShown, setControlsShown] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  function showControls() {
    clearTimeout(leaveTimer.current);
    setControlsShown(true);
  }
  function leaveControls() {
    clearTimeout(leaveTimer.current);
    // Give the pointer time to reach the footer, or to return after an accidental departure.
    leaveTimer.current = setTimeout(() => setControlsShown(false), 800);
  }
  // The browser's own enter and leave, on the question and on the line under it: a question's words are drawn again
  // once the Markdown renderer has loaded, and React's events, worked out from the element the pointer was last over,
  // miss both when that element is replaced under the pointer. Native events also keep their order: leaving the
  // question, then entering its line, which keeps the controls.
  const content = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  shown.current = controlsShown;
  useEffect(() => {
    const words = content.current;
    const under = line.current;
    if (!user || !words || !under) return;
    // Keyboard focus can reveal the line before the pointer ever enters the bubble.
    const enterLine = () => {
      if (shown.current || under.matches(':focus-within')) showControls();
    };
    words.addEventListener('pointerenter', showControls);
    words.addEventListener('pointerleave', leaveControls);
    under.addEventListener('pointerenter', enterLine);
    under.addEventListener('pointerleave', leaveControls);
    return () => {
      words.removeEventListener('pointerenter', showControls);
      words.removeEventListener('pointerleave', leaveControls);
      under.removeEventListener('pointerenter', enterLine);
      under.removeEventListener('pointerleave', leaveControls);
    };
  }, [user]);
  const attached = user ? splitAttachmentMessage(item.text) : null;
  const referenced = attached ? splitQuoteMessage(attached.text) : null;
  // Pasted blocks show as cards above the bubble, which keeps the typed text.
  const pasted = referenced ? splitPastedText(referenced.text) : null;
  const copyBody =
    referenced && (referenced.quotes.length || pasted!.blocks.length)
      ? attachmentMessage(
          quoteCopyText(plainPastedText(referenced.text), referenced.quotes),
          attached!.files,
        )
      : item.text;
  const stamp = time && (
    <>
      <time className="message-time" dateTime={item.at} title={time.full}>
        {user ? time.compact : time.short}
      </time>
      {model && (
        <span className="message-model" title={model}>
          <span className="sr-only">模型 </span>
          {modelName(undefined, model)}
        </span>
      )}
    </>
  );
  return (
    <article
      className={`message ${item.kind}${latest ? ' latest' : ''}${joined ? ' joined' : ''}`}
      data-message-id={item.id}
      data-controls-visible={user && controlsShown ? true : undefined}
    >
      {!user && !native && (
        <div className="message-label">
          CC Space
          <span>模拟</span>
          {stamp}
          <CopyButton text={item.text} />
          <AnswerQuoteActions messageId={item.id} text={item.text} />
        </div>
      )}
      <div
        className={`message-content${streaming ? ' streaming' : ''}`}
        data-search-content
        data-copy-text={copyBody}
        ref={content}
      >
        {attached && referenced ? (
          <>
            <MessageAttachments items={[...pasted!.blocks, ...attached.files]} />
            {(referenced.quotes.length > 0 || pasted!.text) && (
              <Bubble text={pasted!.text}>
                <QuoteChips quotes={referenced.quotes} />
              </Bubble>
            )}
          </>
        ) : (
          <Rich text={item.text} streaming={streaming} />
        )}
      </div>
      {user && (
        <div className="message-footer" ref={line}>
          {item.terminal && <span className="message-delivery">终端</span>}
          {item.delivery && (
            <span
              className={`message-delivery${item.delivery === '原生已接收' ? '' : ' unsettled'}`}
            >
              {item.delivery}
            </span>
          )}
          {stamp}
          <CopyButton text={copyBody} />
          {edit && (
            <button
              type="button"
              className="message-action"
              aria-label="编辑重发"
              title="编辑重发：从这条消息之前分叉出新会话，原会话保留"
              onClick={() => edit(item)}
            >
              <Pencil />
            </button>
          )}
        </div>
      )}
      {!user && native && closing && (
        <div className="message-footer">
          <CopyButton text={item.text} />
          <AnswerQuoteActions messageId={item.id} text={item.text} />
          {footer}
          {stamp}
        </div>
      )}
    </article>
  );
}

// A compaction of the context, in its place among the steps: under way with its timer, then what it compacted.
function CompactMark({ item, active, now }: { item: Compact; active: boolean; now: number }) {
  const running = active && !item.endedAt;
  const timed = running || (item.endedAt && item.endedAt !== item.at);
  return (
    <div className={`compact-mark${running ? ' running' : ''}`} role="status">
      <span>
        {running ? <LoaderCircle className="spinning" /> : <FoldVertical />}
        {running
          ? '正在压缩上下文'
          : !item.endedAt
            ? '上下文压缩未完成'
            : item.trigger === 'auto'
              ? '上下文已自动压缩'
              : '上下文已压缩'}
        {item.previousTokens != null && ` · 压缩前 ${item.previousTokens.toLocaleString()} tokens`}
        {timed && ` · ${duration(item.at, item.endedAt ?? now)}`}
      </span>
    </div>
  );
}

function NoticeLine({ item, resume }: { item: Notice; resume?: () => void }) {
  const error = item.kind === 'notice' && item.error;
  return <RunNotice text={item.text} error={error} resume={resume} />;
}

// A new session greets with Claude's spark.
const Greeting = () => (
  <div className="empty-greeting">
    <Spark className="empty-greeting-mark" />
    <h2 lang="en">You’re here!</h2>
  </div>
);

// How long a turn took, without the time it stood stopped before it was taken up again.
const spent = (turn: Turn) => duration(turn.startedAt, Date.parse(turn.endedAt!) - turn.pausedMs);

// A question put in while the run goes on closes the turn before it, but the run has not finished: that turn and the
// ones joined to it stay as they were until it has.
function heldOpen(turns: Turn[], index: number) {
  let last = index;
  while (turns[last + 1]?.joined) last++;
  return last > index && !turns[last].endedAt;
}

// An expanded step's pictures in a row above its calls, kept the same while they are.
function StepPictureRow({ items }: { items: Work['items'] }) {
  const pictures = useSamePictures(picturesOf(items));
  return pictures.length > 0 ? <PictureRow pictures={pictures} label="这一步的图片" /> : null;
}

// A turn's pictures, each with the step of work that took it (1 for the first). Recomputed as the turn's events
// arrive, but the same array while its pictures are the same, so an open viewer is not drawn again for nothing.
function turnEntries(turn: Turn): PictureEntry[] {
  let step = 0;
  const entries: PictureEntry[] = [];
  for (const item of turn.steps)
    if (item.kind === 'work') {
      step++;
      for (const picture of picturesOf(item.items)) entries.push({ picture, step });
    }
  return entries;
}
function useTurnPictures(turn: Turn | undefined) {
  const kept = useRef<PictureEntry[]>([]);
  const next = turn ? turnEntries(turn) : [];
  const same =
    next.length === kept.current.length &&
    next.every(
      (entry, at) =>
        entry.picture === kept.current[at].picture && entry.step === kept.current[at].step,
    );
  if (!same) kept.current = next;
  return kept.current;
}

// The files a turn wrote, the same array while they stay the same: it is what every answer of the turn reads (see
// RichText), and a new array each time the conversation is drawn would parse every answer's Markdown again.
function useProducedFiles(turn: Turn) {
  const kept = useRef<string[]>([]);
  const next = producedFiles(turn);
  if (next.length !== kept.current.length || next.some((path, at) => path !== kept.current[at]))
    kept.current = next;
  return kept.current;
}

// Whether a turn shows a running clock: it is under way, or a call or compaction of the run going on has not
// ended. A call of an earlier run that was cut off never ends, and has no clock.
function ticking(turn: Turn, run: string | undefined) {
  return (
    !turn.endedAt ||
    (!!run &&
      turn.steps.some(
        (step) =>
          (step.kind === 'compact' && !step.endedAt && step.runId === run) ||
          (step.kind === 'work' &&
            calls(step.items).some((tool) => !tool.endedAt && tool.runId === run)),
      ))
  );
}

const TurnView = memo(function TurnView({
  turn,
  native,
  live,
  latest,
  held,
  resume,
  models = false,
}: {
  turn: Turn;
  native: boolean;
  live: Live;
  latest: boolean;
  held: boolean;
  // Whether replies name their model: more than one has answered in the session.
  models?: boolean;
  // Given to the latest turn while it stands stopped or failed: its last notice offers to go on.
  resume?: () => void;
}) {
  // Test-only (long-session-performance.spec.ts); nothing sets it in use.
  (globalThis as { ccPerf?: { turn?: () => void } }).ccPerf?.turn?.();
  const files = useProducedFiles(turn);
  const active = !turn.endedAt;
  const expanded = usePrefs().view.mode === 'expanded';
  const notes = turn.steps.filter((step) => step.kind === 'assistant').length;
  // A turn of nothing but a compaction, as /compact makes, has nothing to fold away.
  const folds = turn.steps.some((step) => step.kind === 'work' || step.kind === 'assistant');
  // The turn's pictures with their steps: a finished turn folds its steps into one line, which still carries them,
  // and a picture opened from any line pages through all of them, including those the run is still taking.
  const entries = useTurnPictures(turn);
  const pictures = useMemo(() => entries.map((entry) => entry.picture), [entries]);
  const turnPictures = useMemo(() => ({ key: turn.id, entries }), [turn.id, entries]);
  useEffect(() => updatePictures(turn.id, entries), [turn.id, entries]);
  const steps = () =>
    turn.steps.map((step, index) => {
      const next = turn.steps[index + 1] ?? turn.answer;
      const until = (next?.kind === 'work' ? next.items[0].at : next?.at) ?? turn.endedAt;
      return step.kind === 'compact' ? (
        <CompactMark key={step.id} item={step} active={active} now={live.now} />
      ) : step.kind === 'notice' || step.kind === 'note' ? (
        <NoticeLine key={step.id} item={step} />
      ) : step.kind === 'work' ? (
        expanded ? (
          <div key={step.id} className="work-flat">
            <PictureStep.Provider value={picturesOf(step.items).length > 0}>
              <StepPictureRow items={step.items} />
              <WorkItems work={step} active={active} live={live} until={until} preview />
            </PictureStep.Provider>
          </div>
        ) : (
          <WorkGroup
            key={step.id}
            work={step}
            active={active}
            latest={index === turn.steps.length - 1}
            live={live}
            until={until}
          />
        )
      ) : (
        <Message key={step.id} item={step} native={native} streaming={active} />
      );
    });
  return (
    <TurnPictures.Provider value={turnPictures}>
      {/* "Continue" without the turn it takes up, which is on an earlier page, shows nothing for itself. */}
      {turn.question && !turn.question.continued && (
        <Message
          item={turn.question}
          native={native}
          edit={turn.joined ? undefined : live.edit}
          joined={turn.joined}
        />
      )}
      {active || held || expanded || !folds
        ? steps()
        : turn.steps.length > 0 && (
            <Fold
              className="turn-process"
              summary={(shown) => (
                <>
                  <span className={turn.outcome}>
                    {turn.outcome === 'cancelled' && '已停止 · '}
                    {turn.outcome === 'failed' && '处理失败 · '}
                    用时 {spent(turn)}
                    {turn.tools > 0 && ` · ${turn.tools} 步`}
                    {notes > 0 && ` · ${notes} 条说明`}
                    {pictures.length > 0 && ` · ${pictures.length} 张图片`}
                  </span>
                  {!shown && <PictureStrip pictures={pictures} label="本轮的图片" />}
                </>
              )}
            >
              {steps}
            </Fold>
          )}
      {turn.answer ? (
        <FileMentionPaths.Provider value={files}>
          <Message
            item={turn.answer}
            native={native}
            closing
            latest={latest}
            model={models ? turn.answer.model : undefined}
            footer={turn.stats && <TurnStats stats={turn.stats} />}
          />
        </FileMentionPaths.Provider>
      ) : (
        turn.stats &&
        turn.endedAt && (
          <div className={`message assistant${latest ? ' latest' : ''}`}>
            <div className="message-footer">
              <TurnStats stats={turn.stats} />
            </div>
          </div>
        )
      )}
      {turn.notices.map((item, index) => (
        <NoticeLine
          key={item.id}
          item={item}
          resume={index === turn.notices.length - 1 ? resume : undefined}
        />
      ))}
      {/* A stop or failure that left no notice still says so once, with the way to go on. */}
      {resume && !turn.notices.length && (
        <RunNotice
          text={turn.outcome === 'failed' ? '本轮执行失败' : '本轮已停止'}
          error={turn.outcome === 'failed'}
          resume={resume}
        />
      )}
    </TurnPictures.Provider>
  );
});

export default function Conversation({
  projectControl,
  session,
  events,
  history,
  connected,
  native,
  ownsRun,
  clock,
  progress,
  busy,
  fresh,
  loadEarlier,
  replyApproval,
  stopTask,
  backgroundTask,
  stop,
  edit,
  findRequest,
  here,
  preview,
  onQuote,
  sideQuoteAvailable = false,
  adjustableWidth = false,
  readingPositions,
  resume,
  dock,
}: {
  projectControl?: ReactNode;
  // The slot the input box keeps for what waits on the user (Composer.tsx); without one, approvals and questions
  // are answered in the transcript, on the call they are about.
  dock?: HTMLElement | null;
  session: Session | undefined;
  // This window can open the files of the session's project: a desktop on the computer they are on.
  here: boolean;
  preview?: (link: Link) => boolean;
  onQuote?: (messageId: string, text: string, destination: QuoteDestination) => void;
  sideQuoteAvailable?: boolean;
  adjustableWidth?: boolean;
  readingPositions?: Map<string, { top: number; following: boolean }>;
  // Takes up the latest turn again, offered while it stands stopped or failed.
  resume?: () => void;
  events: SessionEvent[];
  history: HistoryState | undefined;
  connected: boolean;
  native: boolean;
  ownsRun: boolean;
  busy: boolean;
  // Nothing has been said in the session yet (App.tsx): it greets, and the input box stands under the greeting.
  fresh: boolean;
  loadEarlier: () => Promise<void>;
  findRequest: number;
  // Ends one background task of the run, or the run with all of them.
  stopTask: (taskId: string) => void;
  // Sends the foreground task a call waits on to the background.
  backgroundTask: (toolId: string) => void;
  stop: () => void;
  replyApproval: (
    runId: string,
    approvalId: string,
    allowed: boolean,
    answers?: Record<string, string>,
    // Whether the answer reached the service.
  ) => Promise<boolean>;
  edit?: (messageId: string, text: string) => void;
  clock: Clock;
  // What the session's background tasks last said of themselves, by task.
  progress: Record<string, TaskProgress> | undefined;
}) {
  const drawn = useRef<Turn[]>([]);
  const turns = useMemo(
    () => (drawn.current = keepTurns(drawn.current, conversation(events))),
    [events],
  );
  // Replies name their model once two have answered in what is loaded of the session; with one, it would be noise.
  // Named as people read them, so a dated snapshot and its base are one model. A subagent's words are not counted.
  const manyModels = useMemo(
    () => answeredByMany(turns, (model) => modelName(undefined, model)),
    [turns],
  );
  // The pictures of the turn the run is in, for the line of its latest ones above "正在执行…".
  const runningTurn = turns.at(-1)?.endedAt ? undefined : turns.at(-1);
  const livePictures = useTurnPictures(runningTurn);
  // A compaction under way counts its time in its own line, as a tool does.
  const steps = turns.at(-1)?.steps ?? [];
  const toolAtWork =
    steps.some((step) => step.kind === 'compact' && !step.endedAt) ||
    steps
      .flatMap((step) => (step.kind === 'work' ? step.items : []))
      .some((item) => item.kind === 'tool' && item.state === 'running');
  // A card in the latest turn asks for an approval or an answer this window can give (see `canApprove` below).
  const cardAsks =
    connected &&
    ownsRun &&
    calls(steps.flatMap((step) => (step.kind === 'work' ? step.items : []))).some(
      (item) =>
        item.kind === 'tool' &&
        item.runId === session?.activeRun?.id &&
        !item.resolved &&
        !!item.approvalId,
    );
  // A task has been waited for since the run first listed it.
  const listedAt = (taskId: string) =>
    Date.parse(
      events.find(
        (event) =>
          event.runId === session?.activeRun?.id &&
          event.payload.type === 'native.tasks' &&
          event.payload.tasks.some((task) => task.id === taskId),
      )?.createdAt ?? '',
    ) || clock.now();
  const background = session?.activeRun?.waiting === 'background';
  const tasks = useMemo(() => {
    const last = events.findLast(
      (event) => event.payload.type === 'native.tasks' && event.runId === session?.activeRun?.id,
    )?.payload;
    return last?.type === 'native.tasks' ? last.tasks : [];
  }, [events, session?.activeRun?.id]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [contextMenu, setContextMenu] = useState<
    (MenuPosition & { heading?: string; items: MenuItem[] }) | null
  >(null);
  // Only the desktop opens files; a page in a browser may still count as on the computer for its runs.
  const place = useMemo(
    () =>
      session
        ? {
            projectPath: session.projectPath,
            here: here && !!window.desktop,
            browser: !window.desktop,
          }
        : null,
    [session?.projectPath, here],
  );
  const [linkCard, setLinkCard] = useState<LinkCard | null>(null);
  const doubtful = useLinkDoubt();
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showLink = (element: Element, link: Link, note?: string) => {
    const box = element.getBoundingClientRect();
    const above = box.bottom + 110 > innerHeight;
    setLinkCard({
      top: above ? box.top - 6 : box.bottom + 6,
      left: Math.max(8, Math.min(box.left, innerWidth - 368)),
      above,
      link,
      note,
      doubt: link.kind === 'web' ? linkDoubt(element.textContent ?? '', link.url) : null,
    });
  };
  // What came of following a link, told beside it; a link the page has redrawn meanwhile is told as a status.
  const tellAt = (element: Element, link: Link) => (note: string) =>
    element.isConnected ? showLink(element, link, note) : setCopyStatus(note);
  const transcriptRoot = useRef<HTMLDivElement>(null);
  const lastFindRequest = useRef(findRequest);
  const searching = findOpen && query.length > 0;
  // Where the reader was before the find box took the focus: it goes back there when the box closes.
  const beforeFind = useRef<Element | null>(null);
  const openFind = () => {
    leave();
    if (!findOpen) beforeFind.current = document.activeElement;
    setFindOpen(true);
  };
  useEffect(() => {
    setFindOpen(false);
    setQuery('');
    setLoadError('');
    setContextMenu(null);
    setCopyStatus('');
    setLinkCard(null);
    doubtful.dismiss();
  }, [session?.id]);
  // What came of a click stays a while, then goes.
  useEffect(() => {
    if (!linkCard?.note) return;
    const timer = setTimeout(() => setLinkCard(null), 4000);
    return () => clearTimeout(timer);
  }, [linkCard]);
  useEffect(() => {
    if (!copyStatus) return;
    // Longer words, such as why a link did not open, stay longer.
    const timer = setTimeout(() => setCopyStatus(''), Math.max(2000, copyStatus.length * 150));
    return () => clearTimeout(timer);
  }, [copyStatus]);
  useEffect(() => {
    if (findRequest !== lastFindRequest.current) openFind();
    lastFindRequest.current = findRequest;
  }, [findRequest]);
  // The clock of running timers: it ticks once a second while something runs (see below), and is set again at
  // local midnight and when the window resumes. Turns at rest show no clock (see `ticking`).
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      const current = new Date();
      setNow(current.getTime());
      const nextDay = new Date(current);
      nextDay.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, nextDay.getTime() - current.getTime());
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  const running = !!session?.activeRun;
  // Running timers tick once a second, and only while something runs.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // Approvals answered from here, until the service has them; one it refused can be answered again. The
  // ref stops a second press before the page has drawn the first; the state greys the buttons out.
  const answering = useRef(new Set<string>());
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // A press on a task's buttons holds them until the call returns; should nothing come of it, they are offered again.
  const [taskSent, setTaskSent] = useState<ReadonlySet<string>>(new Set());
  const sendTask = (toolId: string) => {
    setTaskSent((value) => new Set(value).add(toolId));
    setTimeout(
      () =>
        setTaskSent((value) => {
          const rest = new Set(value);
          rest.delete(toolId);
          return rest;
        }),
      5000,
    );
  };
  // What the rows are given of the session (Live), the same object while nothing they show changes: a turn's view
  // is drawn again only when its turn or this changes (memo, TurnView). Its actions call the latest handlers through
  // a ref, so new handler functions from above draw nothing again. Turns at work get the ticking clock; the others
  // a fixed one, so the timer of a run does not draw the turns before it every second.
  const actions = useRef({ replyApproval, stopTask, backgroundTask, edit });
  actions.current = { replyApproval, stopTask, backgroundTask, edit };
  const activeRunId = session?.activeRun?.id;
  const editable = !!edit;
  const makeLive = (now: number): Live => ({
    now,
    busy,
    docked: !!dock,
    answered: (tool) => !!tool.approvalId && answered.has(tool.approvalId),
    canApprove: (tool) =>
      connected &&
      ownsRun &&
      session?.activeRun?.id === tool.runId &&
      !tool.resolved &&
      !!tool.approvalId,
    reply: (tool, allowed, answers) => {
      const id = tool.approvalId!;
      if (answering.current.has(id)) return;
      answering.current.add(id);
      setAnswered((value) => new Set(value).add(id));
      void actions.current.replyApproval(tool.runId, id, allowed, answers).then((sent) => {
        if (sent) return;
        answering.current.delete(id);
        setAnswered((value) => {
          const rest = new Set(value);
          rest.delete(id);
          return rest;
        });
      });
    },
    edit: edit && !running ? (item) => actions.current.edit?.(item.id, item.text) : undefined,
    taskControl: (tool) =>
      connected &&
      ownsRun &&
      session?.activeRun?.id === tool.runId &&
      tool.taskId &&
      !tool.endedAt &&
      // A command over in a moment is not worth buttons that would flash.
      now - Date.parse(tool.at) >= 3000
        ? taskSent.has(tool.id)
          ? 'sent'
          : 'ready'
        : undefined,
    endTool: (tool) => {
      sendTask(tool.id);
      actions.current.stopTask(tool.taskId!);
    },
    backgroundTool: (tool) => {
      sendTask(tool.id);
      actions.current.backgroundTask(tool.id);
    },
  });
  // What makeLive reads, its actions aside (through the ref).
  const liveKeys = [
    busy,
    !!dock,
    answered,
    connected,
    ownsRun,
    activeRunId,
    running,
    editable,
    taskSent,
  ];
  const live = useMemo(() => makeLive(now), [now, ...liveKeys]);
  // Turns at rest read no clock: theirs is fixed, so a tick, midnight or the window's focus draws none of them.
  const atRest = useMemo(() => makeLive(0), liveKeys);
  // The calls that wait on an answer from here, in the order they were asked: the dock shows the first, and the next
  // once that one is answered. All turns are looked at: a message sent while one waits can join the run in a turn
  // of its own, and the call above it must still be answerable.
  const waitingOn = calls(
    turns.flatMap((turn) => turn.steps).flatMap((step) => (step.kind === 'work' ? step.items : [])),
  )
    .filter((item) => live.canApprove(item))
    // Subagents at work side by side ask in no order of their place: a call asked later never takes the dock from
    // one already in it.
    .sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
  // The dock folded into a bar over the input box, for the approval it was folded for; the next one opens again.
  const [foldedFor, setFoldedFor] = useState<string | null>(null);
  const firstWaiting = waitingOn[0]?.approvalId;
  // A quote put into the input box shows the box (Composer.tsx asks by an event on the slot).
  useEffect(() => {
    if (!dock || !firstWaiting) return;
    const show = () => setFoldedFor(firstWaiting);
    dock.addEventListener('approval-dock:fold', show);
    return () => dock.removeEventListener('approval-dock:fold', show);
  }, [dock, firstWaiting]);
  const scroll = useRef<HTMLDivElement>(null);
  // The view follows new output until the reader moves up from the end, and again once they come back down to it.
  const follow = useRef(true);
  const scrollSession = useRef<string | undefined>(undefined);
  // Shown while not following, as the way back to the end — and only while the end is out of sight: a reader who
  // left a short conversation (opening the find box does) has nowhere to come back down from.
  const [away, setAway] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  // Earlier history is inserted above; the anchor keeps the lines being read where they were.
  const prependAnchor = useRef<{
    sessionId: string;
    height: number;
    top: number;
    message?: { id: string; offset: number };
  } | null>(null);
  const lastTop = useRef(0);
  // What the view moved by itself is not the reader's: the next scroll event compares with where it was put.
  const toEnd = () => {
    if (!scroll.current) return;
    scroll.current.scrollTo(0, scroll.current.scrollHeight);
    lastTop.current = scroll.current.scrollTop;
  };
  const fromEnd = (box: HTMLElement) => box.scrollHeight - box.scrollTop - box.clientHeight;
  const leave = () => {
    follow.current = false;
    setAway(true);
  };
  const rejoin = () => {
    // Returning to live output supersedes a pending history reading position.
    prependAnchor.current = null;
    follow.current = true;
    setAway(false);
  };
  const loadMore = () => {
    if (!session || !connected || !history?.hasEarlier || history.loadingEarlier || history.loading)
      return;
    leave();
    setLoadError('');
    if (scroll.current) {
      const box = scroll.current;
      const message = box.querySelector<HTMLElement>('[data-message-id]');
      prependAnchor.current = {
        sessionId: session.id,
        height: box.scrollHeight,
        top: box.scrollTop,
        message: message?.dataset.messageId
          ? {
              id: message.dataset.messageId,
              offset: message.getBoundingClientRect().top - box.getBoundingClientRect().top,
            }
          : undefined,
      };
    }
    void loadEarlier().catch(() => setLoadError('更早记录加载失败，请重试'));
  };
  useLayoutEffect(() => {
    prependAnchor.current = null;
    const sameSession = scrollSession.current === session?.id;
    scrollSession.current = session?.id;
    if (sameSession && window.desktop?.historyCache && !follow.current) {
      if (scroll.current) lastTop.current = scroll.current.scrollTop;
      return;
    }
    const saved = session && readingPositions?.get(session.id);
    follow.current = saved?.following ?? true;
    setAway(!follow.current);
    if (follow.current) toEnd();
    else if (scroll.current && saved) scroll.current.scrollTop = saved.top;
    if (scroll.current) {
      lastTop.current = scroll.current.scrollTop;
      setAtEnd(fromEnd(scroll.current) < 40);
    }
  }, [session?.id, history?.loaded, history?.loading]);
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor && anchor.sessionId === session?.id && !history?.loadingEarlier && scroll.current) {
      const box = scroll.current;
      const message = anchor.message
        ? box.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.message.id)}"]`)
        : null;
      // content-visibility can revise heights while the request is in flight. Keep the
      // existing message in place rather than compensating using the whole transcript's estimate.
      box.scrollTop =
        message && anchor.message
          ? box.scrollTop +
            message.getBoundingClientRect().top -
            box.getBoundingClientRect().top -
            anchor.message.offset
          : anchor.top + box.scrollHeight - anchor.height;
      lastTop.current = box.scrollTop;
      leave();
      prependAnchor.current = null;
      return;
    }
    if (anchor) return;
    if (follow.current && !findOpen) toEnd();
  }, [events, history?.loadingEarlier, session?.id]);
  // Heights keep changing after that scroll with nothing new said: a reply's Markdown drawn late, messages the page
  // had only estimated until they came into view (`content-visibility`), a resized window. While following, the
  // view keeps to the end through them.
  useEffect(() => {
    if (!scroll.current || !transcriptRoot.current) return;
    const observer = new ResizeObserver(() => {
      if (follow.current && !findOpen && !prependAnchor.current) toEnd();
      if (scroll.current) setAtEnd(fromEnd(scroll.current) < 40);
    });
    observer.observe(scroll.current);
    observer.observe(transcriptRoot.current);
    return () => observer.disconnect();
  }, [session?.id, findOpen]);

  const showGreeting = fresh && !loadError;
  return (
    <QuoteActionsContext.Provider
      value={
        onQuote
          ? {
              quote: onQuote,
              sideAvailable: sideQuoteAvailable,
              sideReason: sideQuoteAvailable
                ? undefined
                : connected
                  ? '当前节点需要更新以支持侧边会话'
                  : '连接中断，请恢复连接后再创建侧边会话',
            }
          : null
      }
    >
      <SearchExpanded.Provider value={searching}>
        {session && (
          <div className="conversation-tools">
            <span role="status">{copyStatus}</span>
            {projectControl}
            <IconButton title="打开对话查找" onClick={openFind}>
              <Search />
            </IconButton>
          </div>
        )}
        <Presence>
          {findOpen && session && (
            <ConversationFind
              root={transcriptRoot}
              scroll={scroll}
              query={query}
              change={setQuery}
              request={findRequest}
              partial={!!history?.hasEarlier}
              close={() => {
                setFindOpen(false);
                setQuery('');
                // The box fades out for a moment; the matches it marked go at once.
                CSS.highlights.delete('conversation-matches');
                CSS.highlights.delete('conversation-current');
                const back = beforeFind.current;
                beforeFind.current = null;
                // Back to the control or text that had the focus; otherwise to the conversation, without drawing
                // the keyboard ring around all of it.
                if (
                  back instanceof HTMLElement &&
                  back !== document.body &&
                  back.isConnected &&
                  !back.closest('[inert], .conversation-find')
                )
                  back.focus({ preventScroll: true });
                else
                  scroll.current?.focus({
                    preventScroll: true,
                    // Chromium's option (not yet in TypeScript's DOM types): no ring for a focus put back.
                    focusVisible: false,
                  } as FocusOptions);
              }}
            />
          )}
        </Presence>
        <div className="conversation-frame">
          <div
            className={`conversation ${searching ? 'searching' : ''}`}
            tabIndex={-1}
            ref={scroll}
            onContextMenu={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('input, textarea, [contenteditable="true"]')) return;
              event.preventDefault();
              const selection = window.getSelection()?.toString() ?? '';
              const quotedSelection = scroll.current ? assistantSelection(scroll.current) : null;
              const message = target.closest<HTMLElement>('[data-copy-text]');
              const block = target.closest('pre');
              const copy = (text: string) => {
                void copyText(text).then(
                  () => setCopyStatus('已复制'),
                  () => setCopyStatus('复制失败，请重试'),
                );
              };
              const items: MenuItem[] = [
                { label: '复制选中文字', disabled: !selection, run: () => copy(selection) },
                ...(onQuote && quotedSelection
                  ? [
                      {
                        label: '添加到对话',
                        run: () => onQuote(quotedSelection.messageId, quotedSelection.text, 'main'),
                      },
                      {
                        label: '在侧边聊天中提问',
                        disabled: !sideQuoteAvailable,
                        run: () => onQuote(quotedSelection.messageId, quotedSelection.text, 'side'),
                      },
                    ]
                  : []),
                ...(block
                  ? [{ label: '复制此代码块', run: () => copy(block.textContent ?? '') }]
                  : []),
                ...(message
                  ? [{ label: '复制整条消息', run: () => copy(message.dataset.copyText ?? '') }]
                  : []),
                {
                  label: '全选对话文字',
                  run: () => {
                    if (!transcriptRoot.current) return;
                    const range = document.createRange();
                    range.selectNodeContents(transcriptRoot.current);
                    const selected = window.getSelection();
                    selected?.removeAllRanges();
                    selected?.addRange(range);
                  },
                },
                { label: '查找对话内容', separated: true, run: openFind },
              ];
              const { clientX: x, clientY: y } = event;
              const element = target.closest<HTMLElement>('[data-link]');
              const link = element?.dataset.link ? linkTarget(element.dataset.link, place) : null;
              clearTimeout(resting.current);
              setLinkCard(null);
              if (!element || !link) {
                setContextMenu({ x, y, items });
                return;
              }
              // A link's own choices come first; what is done to the text follows.
              const guarded = (go: () => void) =>
                doubtful.guard(link, element.textContent ?? '', go);
              void linkMenu(link, tellAt(element, link), copy, guarded).then(
                (menu) =>
                  setContextMenu({
                    x,
                    y,
                    heading: menu.heading,
                    items: [
                      ...(preview &&
                      (link.kind === 'path' || (link.kind === 'web' && previewWebsite(link.url)))
                        ? [
                            {
                              label: '在侧栏预览',
                              run: () => guarded(() => void preview(link)),
                            },
                          ]
                        : []),
                      ...menu.items,
                      { ...items[0], separated: true },
                      ...items.slice(1),
                    ],
                  }),
                () => setContextMenu({ x, y, items }),
              );
            }}
            onClick={(event) => {
              // The window opens no page itself: a link is followed here, where the session's project is known.
              const anchor = (event.target as HTMLElement).closest<HTMLElement>('a[href]');
              if (!anchor || !transcriptRoot.current?.contains(anchor)) return;
              event.preventDefault();
              const link = anchor.dataset.link ? linkTarget(anchor.dataset.link, place) : null;
              clearTimeout(resting.current);
              if (!link) return;
              setLinkCard(null);
              doubtful.guard(link, anchor.textContent ?? '', () => {
                if (!preview?.(link)) void followLink(link, tellAt(anchor, link));
              });
            }}
            onPointerOver={(event) => {
              const anchor = (event.target as HTMLElement).closest<HTMLElement>('a[data-link]');
              if (!anchor || linkCard?.note) return;
              clearTimeout(resting.current);
              resting.current = setTimeout(() => {
                const link = linkTarget(anchor.dataset.link!, place);
                if (link) showLink(anchor, link);
              }, 350);
            }}
            onPointerOut={(event) => {
              const anchor = (event.target as HTMLElement).closest('a[data-link]');
              if (!anchor || anchor.contains(event.relatedTarget as Node | null)) return;
              clearTimeout(resting.current);
              setLinkCard((card) => (card?.note ? card : null));
            }}
            onScroll={() => {
              // Only when one is shown: scrolling must not draw the conversation again.
              if (linkCard) setLinkCard(null);
              if (!scroll.current) return;
              const top = scroll.current.scrollTop;
              const anchor = prependAnchor.current;
              if (anchor && anchor.sessionId === session?.id) {
                if (anchor.message) anchor.message.offset -= top - anchor.top;
                anchor.top = top;
              }
              const end = fromEnd(scroll.current) < 40;
              setAtEnd(end);
              // Coming down to the end follows again; only moving down does, so a slow wheel or a flick upwards is not
              // pulled back while output comes in fast. Moving up away from it leaves, by touch as well: heights that
              // settle or shrink keep the view at the end, where the reader never is after scrolling up.
              if (end && top > lastTop.current) rejoin();
              else if (!end && top < lastTop.current && follow.current) leave();
              // Reading on upwards past what is loaded brings the page before it; a failed load waits for the button.
              if (top < lastTop.current && top < 240 && !loadError) loadMore();
              lastTop.current = top;
              // A reader can move through a desktop disk copy before its snapshot arrives.
              // Remember that position too, so loading -> loaded does not restore following.
              if (
                session &&
                ((history?.loaded && !history.loading) ||
                  (!!window.desktop?.historyCache && events.length > 0))
              )
                readingPositions?.set(session.id, { top, following: follow.current });
            }}
            onClickCapture={(event) => {
              // A disclosure is being read where it is, whether activated by pointer or keyboard.
              // Stop following before its handler changes the transcript's height.
              if ((event.target as HTMLElement).closest('summary, .notice-toggle')) leave();
            }}
            onKeyDown={(event) => {
              if (
                (event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')
              )
                return;
              if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) leave();
              else if (event.key === 'End') rejoin();
            }}
            onWheel={(event) => {
              // Left at once, before the scroll it starts arrives: output in between would pull the view back.
              if (
                event.deltaY < 0 &&
                scroll.current &&
                scroll.current.scrollHeight > scroll.current.clientHeight
              )
                leave();
              // A turn down that reaches the end follows again from it. The scroll it makes is told too late for that
              // when output is coming in: by then the end has moved on.
              if (event.deltaY > 0 && scroll.current && !follow.current) {
                const box = scroll.current;
                const by =
                  event.deltaMode === 1
                    ? event.deltaY * 40
                    : event.deltaMode === 2
                      ? event.deltaY * box.clientHeight
                      : event.deltaY;
                if (fromEnd(box) <= by + 40) rejoin();
              }
              // A loaded page shorter than the window cannot scroll, so the wheel itself asks for more.
              if (event.deltaY < 0 && scroll.current?.scrollTop === 0 && !loadError) loadMore();
            }}
          >
            {!session ? (
              // The home page is the new session not yet made: the same greeting, over its input box (App.tsx).
              <div className="transcript is-empty">
                <Greeting />
              </div>
            ) : (
              <div className={`transcript${showGreeting ? ' is-empty' : ''}`} ref={transcriptRoot}>
                {loadError && (
                  <div className="history-status" role="alert">
                    {loadError}
                  </div>
                )}
                {history?.hasEarlier && (
                  <button
                    type="button"
                    className="history-load"
                    disabled={!connected || history.loadingEarlier || history.loading}
                    onClick={loadMore}
                  >
                    <ArrowUpToLine />
                    {history.loadingEarlier ? '加载中' : '加载更早记录'}
                  </button>
                )}
                {history?.loading && (
                  <div className="history-status" role="status">
                    同步会话
                  </div>
                )}
                {showGreeting && <Greeting />}
                <LinkPlace.Provider value={place}>
                  {turns.map((turn, index) => (
                    <TurnView
                      key={turn.id}
                      turn={turn}
                      native={native}
                      live={ticking(turn, activeRunId) ? live : atRest}
                      latest={index === turns.length - 1}
                      held={heldOpen(turns, index)}
                      resume={index === turns.length - 1 ? resume : undefined}
                      models={manyModels}
                    />
                  ))}
                </LinkPlace.Provider>
                {session.activeRun && background && (
                  <div className="background-tasks">
                    <div className="run-indicator" role="status">
                      <span className={`running-dot${connected ? ' breathing' : ''}`} />
                      后台任务{tasks.length ? ` ${tasks.length} 个` : ''} · Claude
                      已答完，任务结束后会接着处理
                      {!ownsRun && ' · 所在设备不在线'}
                    </div>
                    {/* The run is still on, so the controls that need it over are greyed out; this says why. */}
                    <p className="background-hint">
                      任务结束前不能更改模型、思考强度和审批模式，也不能改名、分叉或编辑重发
                      {ownsRun && '；消息可以照常发送'}。
                    </p>
                    <ul>
                      {tasks.map((task) => (
                        <li key={task.id}>
                          <span>
                            {task.description || task.kind}
                            <TaskLine
                              since={listedAt(task.id)}
                              progress={progress?.[task.id]}
                              clock={clock}
                              connected={connected}
                            />
                          </span>
                          <button
                            type="button"
                            className="button"
                            disabled={!connected || !ownsRun || busy}
                            onClick={() => stopTask(task.id)}
                          >
                            结束
                          </button>
                        </li>
                      ))}
                    </ul>
                    {tasks.length !== 1 && (
                      <button
                        type="button"
                        className="button"
                        disabled={!connected || !ownsRun || busy}
                        onClick={stop}
                      >
                        全部结束
                      </button>
                    )}
                  </div>
                )}
                {session.activeRun && session.activeRun.surface === 'terminal' && (
                  <div className="run-indicator" role="status">
                    {terminalState(session.activeRun.activity)} ·
                    对话随终端进展同步，关闭终端后恢复聊天输入
                  </div>
                )}
                {session.activeRun &&
                  session.activeRun.surface !== 'terminal' &&
                  !background &&
                  runningTurn &&
                  livePictures.length > 0 && (
                    <LivePictures turn={runningTurn.id} entries={livePictures} />
                  )}
                {session.activeRun &&
                  session.activeRun.surface !== 'terminal' &&
                  !background &&
                  // Waiting for the user, the card that asks is the status; a line stands in only where no card
                  // here can answer.
                  !(session.activeRun.status === 'awaiting_approval' && cardAsks) && (
                    <RunStatus
                      tool={toolAtWork}
                      since={Math.max(
                        clock.activityAt(session.id),
                        Date.parse(events.at(-1)?.createdAt ?? '') || 0,
                      )}
                      clock={clock}
                      connected={connected}
                      waiting={
                        session.activeRun.status === 'awaiting_approval'
                          ? session.activeRun.waiting === 'question'
                            ? 'question'
                            : 'approval'
                          : undefined
                      }
                      suffix={ownsRun ? '' : ' · 所在设备不在线'}
                    />
                  )}
              </div>
            )}
          </div>
          {/* Over the foot of the conversation, just above the input box, not inside the scrolling text where a
              short conversation would carry it up to its top. */}
          <Presence>
            {session && away && !atEnd && (
              <div className="to-end">
                <IconButton
                  title="回到底部"
                  className="to-end-button"
                  onClick={(event) => {
                    rejoin();
                    toEnd();
                    // The button goes once the end is reached; the focus moves on to the input box below it, or to
                    // what waits on the user in its place.
                    if (event.currentTarget === document.activeElement)
                      (
                        dock?.querySelector<HTMLElement>('.approval-dock:not([hidden])') ??
                        document.querySelector<HTMLElement>('.composer textarea')
                      )?.focus({ preventScroll: true });
                  }}
                >
                  <ArrowDown />
                </IconButton>
              </div>
            )}
          </Presence>
          {session && adjustableWidth && (
            <ConversationWidthControls
              key={`width:${session.id}`}
              scroll={scroll}
              active={!showGreeting && !history?.loading}
            />
          )}
          {session && (
            <TurnNavigator
              key={session.id}
              turns={turns}
              scroll={scroll}
              hasEarlier={!!history?.hasEarlier}
              loadingEarlier={!connected || !!history?.loadingEarlier || !!history?.loading}
              loadEarlier={loadMore}
              navigate={(id) => {
                const target = Array.from(
                  scroll.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
                ).find((element) => element.dataset.messageId === id);
                if (!target) return;
                leave();
                target.scrollIntoView({ block: 'start', behavior: 'instant' });
              }}
            />
          )}
        </div>
        <Presence>
          {contextMenu && (
            <Menu label="对话文字操作" {...contextMenu} onClose={() => setContextMenu(null)} />
          )}
        </Presence>
        {linkCard && !contextMenu && <LinkCardView card={linkCard} />}
        {doubtful.dialog}
        <QuoteSelection key={session?.id} root={scroll} />
        {dock &&
          waitingOn.length > 0 &&
          createPortal(
            <ApprovalDock
              key={waitingOn[0].approvalId}
              tool={waitingOn[0]}
              more={waitingOn.length - 1}
              disabled={live.busy || live.answered(waitingOn[0])}
              reply={(allowed, answers) => live.reply(waitingOn[0], allowed, answers)}
              stop={
                session?.activeRun &&
                session.activeRun.surface !== 'terminal' &&
                session.activeRun.waiting !== 'background'
                  ? { run: stop, disabled: live.busy }
                  : undefined
              }
              folded={foldedFor === waitingOn[0].approvalId}
              fold={(folded) => setFoldedFor(folded ? waitingOn[0].approvalId! : null)}
            />,
            dock,
          )}
      </SearchExpanded.Provider>
    </QuoteActionsContext.Provider>
  );
}
