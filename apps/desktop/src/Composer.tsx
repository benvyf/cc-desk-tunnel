import Presence from './Presence.tsx';
import QuoteChips from './QuoteChips.tsx';
import { quoteMessage } from './quotes.ts';
import type { QuoteReference, SetQuotes } from './quotes.ts';
import AttachmentTiles from './AttachmentTiles.tsx';
import { attachmentMessage, fileName, messageLimit } from './attachments.ts';
import type { Attachment, SetAttachments } from './attachments.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUp,
  ChevronDown,
  GitBranch,
  Play,
  Plus,
  RefreshCw,
  Shrink,
  Square,
  SquareSlash,
} from './icons.tsx';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
  PermissionMode,
  Session,
} from '@cc-desk-tunnel/protocol';
import { slashCommands } from './commands.ts';
import ComposerControls from './ComposerControls.tsx';
import PermissionMenu from './PermissionMenu.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';
import { setPrefs, usePrefs } from './prefs.ts';
import { isMac } from './platform.ts';
import Clawd from './Clawd.tsx';
import type { ClawdState } from './Clawd.tsx';
import { useInputHistory } from './useInputHistory.ts';

export type Scenario = 'chat' | 'tool' | 'question' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;

function fitDraft(box: HTMLTextAreaElement | null) {
  if (!box) return;
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight}px`;
}

// The branch the project's working tree is on, read from the project by the desktop; it is looked at again
// whenever the window comes back to the front or a run ends, the moments it may have changed.
function useBranch(path: string, running: boolean, remoteSsh = false) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!window.desktop || remoteSsh) {
      setBranch(null);
      return;
    }
    let current = true;
    const read = () =>
      void window.desktop!.gitBranch(path).then(
        (value) => current && setBranch(value),
        () => current && setBranch(null),
      );
    read();
    window.addEventListener('focus', read);
    return () => {
      current = false;
      window.removeEventListener('focus', read);
    };
  }, [path, running, remoteSsh]);
  return branch;
}

export default function Composer({
  queuedMessages,
  session,
  draft,
  history = [],
  historyReady = true,
  focusDraft = false,
  onDraftFocusHandled,
  setDraft,
  attachments = [],
  setAttachments,
  quotes = [],
  setQuotes,
  native,
  connected,
  busy,
  refreshing,
  canRefreshModels,
  ownsRun,
  inputDisabled,
  controlsDisabled,
  slashOpen,
  setSlashOpen,
  canCompact,
  scenario,
  setScenario,
  capabilities,
  nativeSession,
  metrics,
  openAccount,
  send,
  resume,
  compact,
  refresh,
  configure,
  stop,
  mascot = false,
}: {
  queuedMessages?: ReactNode;
  // Clawd on the box's top edge (the session's own box, when the setting is on).
  mascot?: boolean;
  session: Session;
  draft: string;
  history?: string[];
  historyReady?: boolean;
  focusDraft?: boolean;
  onDraftFocusHandled?: () => void;
  setDraft: (text: string, expectedText?: string) => void;
  quotes?: QuoteReference[];
  setQuotes?: SetQuotes;
  attachments?: Attachment[];
  setAttachments?: SetAttachments;
  native: boolean;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  canRefreshModels: boolean;
  ownsRun: boolean;
  inputDisabled: boolean;
  controlsDisabled: boolean;
  slashOpen: boolean;
  setSlashOpen: (open: boolean) => void;
  canCompact: boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  openAccount: () => void;
  // Sends the draft, or the text given instead of it.
  send: (text?: string, mode?: 'queue' | 'steer') => void;
  // Present when the session's last turn was stopped or cut off: takes it up again without a message.
  resume?: () => void;
  compact: () => void;
  refresh: () => void;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  stop: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const recall = useInputHistory(session.id, historyReady ? history : [], draft, setDraft, input);
  const composition = useRef({ active: false, until: 0 });
  useLayoutEffect(() => {
    composition.current = { active: false, until: 0 };
  }, [session.id]);
  const {
    fontSizes: { interface: interfaceFontSize },
    busyEnter,
    shortcuts: { enabled: shortcutsEnabled },
  } = usePrefs();
  const following = !!session.activeRun && native;
  const sendLabel = following ? (busyEnter === 'queue' ? '排队发送' : '插话发送') : '发送消息';
  const [sendMenu, setSendMenu] = useState<MenuPosition | null>(null);
  const sendMenuOpenAtPress = useRef(false);
  const sendMenuClosedAt = useRef(0);
  const sendMenuOpen = useRef(false);
  const alternateKey = `${isMac ? 'Cmd' : 'Ctrl'}+Enter`;
  useEffect(() => {
    if (following) return;
    sendMenuOpen.current = false;
    setSendMenu(null);
  }, [following]);
  const remoteSsh = !!session.device?.viaSsh;
  const branch = useBranch(session.projectPath, !!session.activeRun, remoteSsh);
  const [dropping, setDropping] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentBlocked = attachments.some((item) => item.status !== 'ready');
  const messageTooLong =
    attachmentMessage(quoteMessage(draft, quotes), attachments).trim().length > messageLimit;
  function submit(alternate = false) {
    if (
      !inputDisabled &&
      !attachmentBlocked &&
      !messageTooLong &&
      (!quotes.length || !!draft.trim()) &&
      (draft.trim() || attachments.length)
    )
      send(
        undefined,
        following && alternate ? (busyEnter === 'queue' ? 'steer' : 'queue') : busyEnter,
      );
  }
  useEffect(() => {
    setAttachmentError(null);
    setDropping(false);
  }, [session.id]);
  // The command menu: this window's own actions, then Claude Code's commands that fit what follows the slash. Enter
  // runs the one picked; Tab or a click puts a command in the box, to be given its arguments.
  // Until the keys pick one, the first that can be used is picked.
  const [pick, setPick] = useState<number | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = slashOpen ? draft.slice(1).toLowerCase() : '';
  const items: {
    key: string;
    icon: ReactNode;
    title: ReactNode;
    detail: ReactNode;
    disabled: boolean;
    run: () => void;
    fill?: string;
  }[] = [
    ...('compact'.startsWith(typed)
      ? [
          {
            key: 'compact',
            icon: <Shrink />,
            title: '压缩上下文',
            detail: metrics?.context ? `已使用 ${metrics.context.percentage}%` : '/compact',
            disabled: controlsDisabled || !canCompact,
            run: compact,
          },
        ]
      : []),
    ...('refresh'.startsWith(typed)
      ? [
          {
            key: 'refresh',
            icon: <RefreshCw />,
            title: '刷新原生状态',
            detail: '上下文与订阅额度',
            disabled: controlsDisabled || refreshing,
            run: () => {
              setSlashOpen(false);
              setDraft('');
              refresh();
            },
          },
        ]
      : []),
    ...(slashOpen ? slashCommands(capabilities, typed) : []).map((command) => ({
      key: `/${command.name}`,
      icon: <SquareSlash />,
      title: (
        <>
          /{command.name}
          {command.argumentHint && <em>{command.argumentHint}</em>}
        </>
      ),
      detail: command.description,
      disabled: inputDisabled,
      run: () => send(`/${command.name}`),
      fill: `/${command.name} `,
    })),
  ];
  const menuShown = native && slashOpen && items.length > 0;
  const at =
    pick === null
      ? Math.max(
          0,
          items.findIndex((item) => !item.disabled),
        )
      : Math.min(pick, items.length - 1);
  useEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, menuShown]);
  function fill(text: string) {
    setDraft(text);
    setSlashOpen(false);
    input.current?.focus();
  }
  useLayoutEffect(() => {
    // Grow with the draft and shared font changes; the stylesheet limits when scrolling takes over.
    fitDraft(input.current);
  }, [draft, session.id, interfaceFontSize]);
  useEffect(() => {
    // An edit is ready only once its fork/history has loaded and the input is enabled.
    const box = input.current;
    if (!focusDraft || inputDisabled || !box) return;
    // Loading may take long enough for the reader to start searching or use another control.
    const focused = document.activeElement;
    if (quotes.length || !focused || focused === document.body || focused === box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    onDraftFocusHandled?.();
  }, [focusDraft, inputDisabled, onDraftFocusHandled]);
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    let width = box.getBoundingClientRect().width;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const next = box.getBoundingClientRect().width;
      // Height changes from typing must not retrigger measurement (or form a resize loop).
      if (next === width) return;
      width = next;
      // Write on the next frame, outside the observer's resize-notification delivery.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitDraft(box));
    });
    observer.observe(box, { box: 'border-box' });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const shown = useRef(session.id);
  shown.current = session.id;
  async function chooseFiles() {
    if (remoteSsh) return;
    const target = session.id;
    setAttachmentError(null);
    try {
      const paths = await window.desktop!.chooseFiles();
      if (!paths.length) return;
      const added = paths.map((path): Attachment => ({
        id: crypto.randomUUID(),
        name: fileName(path),
        path,
        status: 'ready',
      }));
      setAttachments?.(target, (current) => {
        const known = new Set(current.map((item) => item.path));
        return [
          ...current,
          ...added.filter((item) => {
            if (known.has(item.path)) return false;
            known.add(item.path);
            return true;
          }),
        ];
      });
      if (shown.current === target) input.current?.focus();
    } catch {
      if (shown.current === target) setAttachmentError('无法打开文件选择器，请重试');
    }
  }
  // Files copied in Explorer have a path. A picture that is only on the clipboard (a screenshot, an image
  // copied from a page) has none: the client saves it on this computer and its path is attached like any other.
  async function paste(files: File[]) {
    const target = session.id;
    for (const file of files) {
      const id = crypto.randomUUID();
      let path = '';
      try {
        path = window.desktop!.pathForFile(file);
      } catch {
        /* Clipboard images have no path. */
      }
      if (!path && !file.type.startsWith('image/')) continue;
      setAttachments?.(target, (current) =>
        path && current.some((item) => item.path === path)
          ? current
          : [
              ...current,
              {
                id,
                name: file.name || '粘贴的图片',
                path: path || undefined,
                status: path ? 'ready' : 'preparing',
              },
            ],
      );
      if (path) continue;
      // Start every save immediately; one slow image does not hide the rest of a multi-file paste.
      void (async () => {
        try {
          if (file.size > 20 << 20) throw new Error('只能粘贴不超过 20 MB 的图片。');
          const saved = await window.desktop!.saveImage(
            file.type,
            new Uint8Array(await file.arrayBuffer()),
          );
          setAttachments?.(target, (current) =>
            current.map((item) =>
              item.id === id ? { ...item, path: saved, status: 'ready' } : item,
            ),
          );
        } catch (error) {
          setAttachments?.(target, (current) =>
            current.map((item) =>
              item.id === id
                ? {
                    ...item,
                    status: 'error',
                    error: error instanceof Error ? error.message : '无法保存图片',
                  }
                : item,
            ),
          );
        }
      })();
    }
  }
  const clawdState: ClawdState =
    !session.activeRun || session.activeRun.waiting === 'background'
      ? 'idle'
      : session.activeRun.status === 'awaiting_approval'
        ? 'waiting'
        : 'working';
  return (
    <div className="composer-area">
      <Presence kind="popup">
        {menuShown && (
          <div className="slash-menu" role="listbox" aria-label="会话命令" ref={menu}>
            {items.map((item, index) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={index === at}
                disabled={item.disabled}
                // The message box keeps the focus, and with it the keys.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setPick(index)}
                onClick={() => (item.fill ? fill(item.fill) : item.run())}
              >
                {item.icon}
                <span>
                  {item.title}
                  <small>{item.detail}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </Presence>
      {branch && (
        <div className="composer-context">
          <span className="chip quiet" title="项目当前所在的 git 分支">
            <GitBranch />
            <span>{branch}</span>
          </span>
        </div>
      )}
      {/* The queue and the box are one stack, so Clawd stands on whichever is on top. */}
      <div className="composer-stack">
        {mascot && <Clawd state={clawdState} />}
        {queuedMessages}
        <form
          className={`composer ${dropping ? 'dropping' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onDragOver={(event) => {
            if (
              !window.desktop ||
              remoteSsh ||
              inputDisabled ||
              !event.dataTransfer.types.includes('Files')
            )
              return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            setDropping(false);
            if (!window.desktop || inputDisabled || !event.dataTransfer.files.length) return;
            event.preventDefault();
            if (remoteSsh) return;
            void paste([...event.dataTransfer.files]);
          }}
        >
          <div className="composer-input">
            <QuoteChips
              quotes={quotes}
              remove={
                setQuotes
                  ? (id) => {
                      setQuotes(session.id, (current) =>
                        current.filter((quote) => quote.id !== id),
                      );
                      input.current?.focus();
                    }
                  : undefined
              }
            />
            <AttachmentTiles
              items={attachments}
              disabled={inputDisabled}
              remove={(id) => {
                const path = attachments.find((item) => item.id === id)?.path;
                setAttachments?.(session.id, (current) =>
                  current.filter((item) => item.id !== id && (!path || item.path !== path)),
                );
                input.current?.focus();
              }}
            />
            {attachmentError && (
              <p className="attachment-error" role="alert">
                {attachmentError}
              </p>
            )}
            {messageTooLong && (
              <p className="attachment-error" role="alert">
                消息过长（含附件），请缩短正文或移除部分附件（最多 {messageLimit} 字符）。
              </p>
            )}
            <textarea
              ref={input}
              aria-label="消息"
              placeholder={
                session.activeRun?.surface === 'terminal'
                  ? '会话在终端中打开，关闭终端后恢复聊天输入'
                  : quotes.length
                    ? '输入关于引用内容的问题…'
                    : '随心输入…'
              }
              value={draft}
              disabled={inputDisabled}
              maxLength={messageLimit}
              aria-invalid={messageTooLong || undefined}
              rows={2}
              onCompositionStart={() => {
                composition.current.active = true;
              }}
              onCompositionEnd={() => {
                composition.current.active = false;
                // Harness also guards late composition-closing keys for 10ms.
                composition.current.until = performance.now() + 10;
              }}
              onChange={(event) => {
                recall.reset();
                setDraft(event.target.value);
                setSlashOpen(native && slashDraft.test(event.target.value));
                setPick(null);
              }}
              onPaste={(event) => {
                if (remoteSsh && event.clipboardData.files.length) {
                  event.preventDefault();
                  return;
                }
                // Pasted text is left to the browser, also when a program put a picture of it beside the text.
                if (!window.desktop || inputDisabled || !event.clipboardData.files.length) return;
                const files = [...event.clipboardData.files];
                const text = event.clipboardData.getData('text/plain');
                const usable = files.filter(
                  (file) =>
                    (() => {
                      try {
                        return !!window.desktop!.pathForFile(file);
                      } catch {
                        return false;
                      }
                    })() ||
                    (!text && file.type.startsWith('image/')),
                );
                if (!usable.length) return;
                event.preventDefault();
                void paste(usable);
              }}
              onKeyDown={(event) => {
                const composing =
                  composition.current.active ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229;
                if (composing || performance.now() < composition.current.until) {
                  // The IME owns this key; global shortcuts must not count it.
                  event.stopPropagation();
                  // After composition has ended, textarea's default Enter would
                  // insert a line. Preserve Shift+Enter and the IME's own defaults.
                  if (!composing && event.key === 'Enter' && !event.shiftKey)
                    event.preventDefault();
                  return;
                }
                if (event.key === 'Escape') {
                  setSlashOpen(false);
                  return;
                }
                if (menuShown && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault();
                  setPick((at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
                  return;
                }
                if (menuShown && event.key === 'Tab' && !event.shiftKey) {
                  event.preventDefault();
                  const command = items[at].fill;
                  if (command) fill(command);
                  return;
                }
                if (recall.onKeyDown(event)) {
                  setSlashOpen(false);
                  setPick(null);
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!menuShown) submit(isMac ? event.metaKey : event.ctrlKey);
                  else if (!items[at].disabled) items[at].run();
                }
              }}
            />
          </div>
          <div className="composer-toolbar">
            {window.desktop && !remoteSsh && (
              <IconButton
                title="添加附件"
                className="attach-button"
                disabled={inputDisabled}
                onClick={() => void chooseFiles()}
              >
                <Plus />
              </IconButton>
            )}
            {!native ? (
              <label className="scenario-label">
                场景
                <select
                  aria-label="模拟场景"
                  value={scenario}
                  onChange={(event) => setScenario(event.target.value as Scenario)}
                  disabled={!!session.activeRun || busy}
                >
                  <option value="chat">对话</option>
                  <option value="tool">工具审批</option>
                  <option value="question">提问</option>
                  <option value="error">上游错误</option>
                </select>
              </label>
            ) : (
              <PermissionMenu
                mode={session.permissionMode}
                disabled={controlsDisabled}
                change={(permissionMode) => void configure({ permissionMode })}
              />
            )}
            <span className="toolbar-space" />
            {native && (
              <ComposerControls
                key={session.id}
                model={session.model}
                effort={session.effort}
                capabilities={capabilities}
                nativeSession={nativeSession}
                metrics={metrics}
                openAccount={openAccount}
                disabled={controlsDisabled}
                configure={configure}
                refresh={refresh}
                refreshing={refreshing}
                canRefreshModels={canRefreshModels}
              />
            )}
            {session.activeRun &&
              session.activeRun.surface !== 'terminal' &&
              session.activeRun.waiting !== 'background' && (
                <IconButton
                  title="停止运行"
                  aria-description={
                    shortcutsEnabled && session.activeRun.status !== 'awaiting_approval'
                      ? '在当前会话内，500 毫秒内连续按两次 Esc 可停止当前回答。'
                      : undefined
                  }
                  className="stop-button"
                  disabled={!connected || !ownsRun || busy}
                  onClick={stop}
                >
                  <Square />
                </IconButton>
              )}
            {resume && !draft.trim() && !attachments.length && !quotes.length ? (
              <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
                <Play />
              </IconButton>
            ) : (
              (!session.activeRun || native) && (
                <>
                  {/* The menu is fixed above the button, in the page's own layer so Clawd and the input box's stack
                      do not cover it; it comes first so the send button stays the toolbar's last child. */}
                  {createPortal(
                    <Presence>
                      {following && sendMenu && (
                        <Menu
                          label="发送方式"
                          heading="按 Enter 时"
                          {...sendMenu}
                          onClose={() => {
                            // The menu fading out still hears presses outside it; only a real close counts.
                            if (sendMenuOpen.current) sendMenuClosedAt.current = performance.now();
                            sendMenuOpen.current = false;
                            setSendMenu(null);
                          }}
                          items={(
                            [
                              ['queue', '排队发送', '等这一轮结束后再发给 Claude'],
                              ['steer', '插话发送', '立即发给正在运行的 Claude'],
                            ] as const
                          ).map(([value, label, detail]) => ({
                            label,
                            detail,
                            checked: busyEnter === value,
                            hint: busyEnter === value ? 'Enter' : alternateKey,
                            run: () => setPrefs((prefs) => ({ ...prefs, busyEnter: value })),
                          }))}
                        />
                      )}
                    </Presence>,
                    document.body,
                  )}
                  {/* While a run is going, Enter queues or steers as chosen in the small menu beside the send button
                      (spec §5.10); Ctrl/Cmd+Enter sends the other way. */}
                  {following && (
                    <button
                      type="button"
                      className="send-mode-button"
                      aria-label="发送方式"
                      title="发送方式"
                      aria-haspopup="menu"
                      aria-expanded={!!sendMenu}
                      // A press on this button while the menu is open closes it (the menu's outside press) and
                      // does not open it again.
                      onPointerDown={() =>
                        (sendMenuOpenAtPress.current =
                          performance.now() - sendMenuClosedAt.current < 50)
                      }
                      onClick={(event) => {
                        if (sendMenuOpenAtPress.current) {
                          sendMenuOpenAtPress.current = false;
                          return;
                        }
                        const box = event.currentTarget.parentElement!.getBoundingClientRect();
                        sendMenuOpen.current = true;
                        setSendMenu({
                          x: box.right - 272,
                          y: event.currentTarget.getBoundingClientRect().top - 6,
                          above: true,
                          width: 272,
                        });
                      }}
                    >
                      <ChevronDown />
                    </button>
                  )}
                  <button
                    type="submit"
                    className="icon-button send-button"
                    aria-label={sendLabel}
                    title={
                      following
                        ? `${sendLabel} · ${isMac ? 'Cmd' : 'Ctrl'}+Enter ${busyEnter === 'queue' ? '插话发送' : '排队发送'}`
                        : sendLabel
                    }
                    disabled={
                      (!draft.trim() && !attachments.length) ||
                      (!!quotes.length && !draft.trim()) ||
                      inputDisabled ||
                      attachmentBlocked ||
                      messageTooLong
                    }
                  >
                    <ArrowUp />
                  </button>
                </>
              )
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

// The input box of the page with no session open, as Claude's new chat: the greeting above it, and what is
// written here starts a session with it as the first message. Nothing is made on the service before that (spec
// §5.11: the home page is the new session, not another empty state). The model, approval mode and attachments
// are chosen in the session once it exists.
export function NewSessionComposer({
  draft,
  setDraft,
  disabled,
  start,
}: {
  draft: string;
  setDraft: (text: string) => void;
  disabled: boolean;
  start: (text: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const interfaceFontSize = usePrefs().fontSizes.interface;
  useLayoutEffect(() => fitDraft(input.current), [draft, interfaceFontSize]);
  useEffect(() => {
    if (!disabled) input.current?.focus();
  }, [disabled]);
  const submit = () => {
    if (draft.trim() && !disabled) start(draft);
  };
  return (
    <div className="composer-area new-session-composer">
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="composer-input">
          <textarea
            ref={input}
            aria-label="新会话的第一条消息"
            placeholder="随心输入…"
            value={draft}
            disabled={disabled}
            maxLength={messageLimit}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div className="composer-toolbar">
          <span className="new-session-note">发送后新建会话</span>
          <span className="toolbar-space" />
          <button
            type="submit"
            className="icon-button send-button"
            aria-label="新建会话并发送"
            title="新建会话并发送"
            disabled={!draft.trim() || disabled}
          >
            <ArrowUp />
          </button>
        </div>
      </form>
    </div>
  );
}
