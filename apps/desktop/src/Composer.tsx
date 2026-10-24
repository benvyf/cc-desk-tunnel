import Presence from './Presence.tsx';
import AttachmentTiles from './AttachmentTiles.tsx';
import { attachmentMessage, fileName, messageLimit } from './attachments.ts';
import type { Attachment, SetAttachments } from './attachments.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowRight,
  Folder,
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
import { IconButton } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';
import { usePrefs } from './prefs.ts';

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
function useBranch(path: string, running: boolean) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!window.desktop) return;
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
  }, [path, running]);
  return branch;
}

export default function Composer({
  session,
  projectName,
  chooseProject,
  draft,
  focusDraft = false,
  onDraftFocusHandled,
  setDraft,
  attachments = [],
  setAttachments,
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
}: {
  session: Session;
  // Absent for a session that belongs to no project.
  projectName: string | null;
  // Opens the list of projects the session can be moved to; absent while it cannot be moved.
  chooseProject?: (position: MenuPosition) => void;
  draft: string;
  focusDraft?: boolean;
  onDraftFocusHandled?: () => void;
  setDraft: (text: string) => void;
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
  send: (text?: string) => void;
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
  const interfaceFontSize = usePrefs().fontSizes.interface;
  const branch = useBranch(session.projectPath, !!session.activeRun);
  const [dropping, setDropping] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentBlocked = attachments.some((item) => item.status !== 'ready');
  const messageTooLong = attachmentMessage(draft, attachments).trim().length > messageLimit;
  function submit() {
    if (
      !inputDisabled &&
      !attachmentBlocked &&
      !messageTooLong &&
      (draft.trim() || attachments.length)
    )
      send();
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
    if (!focused || focused === document.body || focused === box) {
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
      <div className="composer-context">
        <button
          type="button"
          className="chip quiet"
          aria-label="会话所在的项目"
          aria-haspopup="menu"
          title={session.projectPath}
          disabled={!chooseProject}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            chooseProject!({ x: box.left, y: box.top - 6, above: true });
          }}
        >
          <Folder />
          <span>{projectName ?? '普通会话'}</span>
        </button>
        {branch && (
          <span className="chip quiet" title="项目当前所在的 git 分支">
            <GitBranch />
            <span>{branch}</span>
          </span>
        )}
      </div>
      <form
        className={`composer ${dropping ? 'dropping' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={(event) => {
          if (!window.desktop || inputDisabled || !event.dataTransfer.types.includes('Files'))
            return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!window.desktop || inputDisabled || !event.dataTransfer.files.length) return;
          event.preventDefault();
          void paste([...event.dataTransfer.files]);
        }}
      >
        <div className="composer-input">
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
            placeholder="随心输入…"
            value={draft}
            disabled={inputDisabled}
            maxLength={messageLimit}
            aria-invalid={messageTooLong || undefined}
            rows={2}
            onChange={(event) => {
              setDraft(event.target.value);
              setSlashOpen(native && slashDraft.test(event.target.value));
              setPick(null);
            }}
            onPaste={(event) => {
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
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!menuShown) submit();
                else if (!items[at].disabled) items[at].run();
              }
            }}
          />
        </div>
        <div className="composer-toolbar">
          {window.desktop && (
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
          {session.activeRun && session.activeRun.waiting !== 'background' && (
            <IconButton
              title="停止运行"
              className="stop-button"
              disabled={!connected || !ownsRun || busy}
              onClick={stop}
            >
              <Square />
            </IconButton>
          )}
          {resume && !draft.trim() && !attachments.length ? (
            <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
              <Play />
            </IconButton>
          ) : (
            (!session.activeRun || native) && (
              <button
                type="submit"
                className="icon-button send-button"
                aria-label="发送消息"
                title="发送消息"
                disabled={
                  (!draft.trim() && !attachments.length) ||
                  inputDisabled ||
                  attachmentBlocked ||
                  messageTooLong
                }
              >
                <ArrowRight />
              </button>
            )
          )}
        </div>
      </form>
    </div>
  );
}
