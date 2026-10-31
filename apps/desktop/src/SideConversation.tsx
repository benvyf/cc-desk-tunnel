import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Effort, PermissionMode, NativeCapabilities } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import Composer from './Composer.tsx';
import type { Scenario } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import FollowUpQueue from './FollowUpQueue.tsx';
import type { FollowUps } from './followUps.ts';
import { attachmentMessage, messageLimit } from './attachments.ts';
import type { Attachment, SetAttachments } from './attachments.ts';
import { quoteMessage } from './quotes.ts';
import type { QuoteReference, SetQuotes } from './quotes.ts';
import type { QuoteDestination } from './QuoteActions.tsx';
import { latest } from './nativeState.ts';
import { useStopShortcut } from './useStopShortcut.ts';

export default function SideConversation({
  client,
  capabilities,
  sessionId,
  draft,
  setDraft,
  quotes,
  setQuotes,
  attachments,
  setAttachments,
  followUps,
  focusDraft,
  onDraftFocusHandled,
  openAccount,
  onQuote,
}: {
  capabilities: NativeCapabilities | null;
  client: ProxyClient;
  sessionId: string;
  draft: string;
  setDraft: (text: string, expectedText?: string) => void;
  quotes: QuoteReference[];
  setQuotes: SetQuotes;
  attachments: Attachment[];
  setAttachments: SetAttachments;
  followUps: FollowUps;
  focusDraft: boolean;
  onDraftFocusHandled: () => void;
  openAccount: () => void;
  onQuote: (messageId: string, text: string, destination: QuoteDestination) => void;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const queued = useSyncExternalStore(followUps.subscribe, followUps.getSnapshot);
  const session = state.sessions.find((item) => item.id === sessionId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [slashOpen, setSlashOpen] = useState(false),
    [scenario, setScenario] = useState<Scenario>('chat');
  const [clock] = useState(() => ({ now: client.serviceNow, activityAt: client.activityAt }));
  const connected = state.status === 'connected',
    native = state.adapter === 'claude-code';
  const recorded = state.events[sessionId],
    unfinished = state.live[sessionId];
  const events = useMemo(() => client.shown(sessionId), [client, sessionId, recorded, unfinished]);
  const history = state.history[sessionId];
  useEffect(
    () => client.observeSession(sessionId),
    [client, sessionId, state.sideConversations, !!session],
  );
  const here = !!session && !!state.device && session.device?.id === state.device.id;
  const reachable =
    !!session &&
    (!session.device ||
      here ||
      state.devices.some((device) => device.id === session.device?.id && device.ready));
  const ownsRun = !!session?.activeRun && reachable;
  const disabled =
    !connected ||
    busy ||
    !reachable ||
    !!history?.loading ||
    (!!session?.activeRun && (!native || !ownsRun)) ||
    session?.activeRun?.surface === 'terminal';
  const controlsDisabled = disabled || !!session?.activeRun;
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : '侧边会话操作失败。');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function send(override?: string, mode: 'queue' | 'steer' = 'queue') {
    if (!session || disabled) return;
    if (override === undefined && attachments.some((item) => item.status !== 'ready')) return;
    if (override === undefined && quotes.length && !draft.trim()) return;
    const text = override ?? attachmentMessage(quoteMessage(draft, quotes), attachments);
    if (!text.trim()) return;
    if (text.length > messageLimit) {
      setError('消息过长，请缩短问题或移除部分引用/附件。');
      return;
    }
    const sentQuotes = new Set(quotes.map((quote) => quote.id)),
      sentFiles = new Set(attachments.map((file) => file.id));
    const ok = await act(async () => {
      if (session.activeRun && mode === 'queue') followUps.enqueue(sessionId, text, scenario);
      else await client.request({ type: 'message.send', sessionId, text, scenario });
    });
    if (ok) {
      setDraft('', draft);
      if (override === undefined) {
        setQuotes(sessionId, (current) => current.filter((quote) => !sentQuotes.has(quote.id)));
        setAttachments(sessionId, (current) => current.filter((file) => !sentFiles.has(file.id)));
      }
      setSlashOpen(false);
    }
  }
  const run = session?.activeRun;
  const stopScope = useRef<HTMLElement>(null);
  const stop = () => {
    followUps.pause(sessionId);
    control('run.cancel');
  };
  useStopShortcut(
    stopScope,
    `${state.connectionId}:${sessionId}:${run?.id}`,
    connected &&
      !busy &&
      ownsRun &&
      !!run &&
      run.status !== 'awaiting_approval' &&
      run.surface !== 'terminal',
    stop,
  );
  const control = (type: 'run.cancel' | 'run.task.stop' | 'run.task.background', id?: string) => {
    if (!run) return;
    void act(() =>
      client.request(
        type === 'run.cancel'
          ? { type, sessionId, runId: run.id }
          : type === 'run.task.stop'
            ? { type, sessionId, runId: run.id, taskId: id! }
            : { type, sessionId, runId: run.id, toolId: id! },
      ),
    );
  };
  const configure = (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) =>
    act(() =>
      client.request({
        type: 'session.configure',
        sessionId,
        permissionMode: session!.permissionMode,
        ...values,
      }),
    ).then(() => {});
  if (!session)
    return (
      <div className="preview-empty">
        <p>此侧边会话已删除或暂不可用。</p>
      </div>
    );
  if (connected && !state.sideConversations)
    return (
      <div className="preview-empty">
        <p>当前节点需要更新以支持侧边会话。</p>
      </div>
    );
  const parent = state.sessions.find(
    (item) => item.id === session.sideConversation?.parentSessionId,
  );
  return (
    <section
      className="side-conversation"
      aria-label="侧边会话"
      data-side-session={sessionId}
      ref={stopScope}
    >
      <header className="side-conversation-source">
        <strong>{session.title}</strong>
        <span title={parent?.title}>
          继承{parent ? `“${parent.title}”` : '来源会话'}的创建时快照，后续追问独立保存。
        </span>
      </header>
      {!connected && (
        <p className="connection-banner" role="status">
          连接中断，等待恢复后继续。
        </p>
      )}
      {error && (
        <p className="preview-error" role="alert">
          {error}
        </p>
      )}
      <Conversation
        session={session}
        events={events}
        history={history}
        connected={connected}
        native={native}
        ownsRun={ownsRun}
        clock={clock}
        progress={state.progress[sessionId]}
        busy={busy}
        newSession={() => {}}
        loadEarlier={() => client.loadEarlier(sessionId)}
        findRequest={0}
        here={here}
        onQuote={onQuote}
        sideQuoteAvailable={connected && state.sideConversations}
        stopTask={(id) => control('run.task.stop', id)}
        backgroundTask={(id) => control('run.task.background', id)}
        stop={stop}
        replyApproval={(runId, approvalId, allowed, answers) =>
          act(() =>
            client.request({
              type: 'approval.reply',
              sessionId,
              runId,
              approvalId,
              allowed,
              answers,
            }),
          )
        }
      />
      <Composer
        session={session}
        draft={draft}
        setDraft={setDraft}
        quotes={quotes}
        setQuotes={setQuotes}
        attachments={attachments}
        setAttachments={setAttachments}
        focusDraft={focusDraft}
        onDraftFocusHandled={onDraftFocusHandled}
        queuedMessages={
          <FollowUpQueue
            items={queued.items[sessionId] ?? []}
            paused={queued.paused[sessionId]}
            sending={queued.sending[sessionId]}
            disabled={disabled}
            running={!!run}
            remove={(id) => followUps.remove(sessionId, id)}
            edit={(id, text) => followUps.edit(sessionId, id, text)}
            beginEdit={() => followUps.pause(sessionId)}
            sendNow={(id) => {
              void followUps.sendNow(sessionId, id);
            }}
            resume={() => followUps.resume(sessionId)}
          />
        }
        native={native}
        connected={connected}
        busy={busy}
        refreshing={busy}
        canRefreshModels={!state.sessions.some((item) => item.activeRun)}
        ownsRun={ownsRun}
        inputDisabled={disabled}
        controlsDisabled={controlsDisabled}
        slashOpen={slashOpen}
        setSlashOpen={setSlashOpen}
        canCompact={!!latest(events, 'native.context')?.persisted}
        scenario={scenario}
        setScenario={setScenario}
        capabilities={latest(events, 'native.capabilities') ?? capabilities}
        nativeSession={latest(events, 'native.session')}
        metrics={latest(events, 'native.metrics')}
        openAccount={openAccount}
        configure={configure}
        send={(text, mode) => {
          void send(text, mode);
        }}
        compact={() => {
          void act(() => client.request({ type: 'session.compact', sessionId }));
        }}
        refresh={() => {
          void act(() => client.request({ type: 'session.status', sessionId }));
        }}
        stop={stop}
      />
    </section>
  );
}
