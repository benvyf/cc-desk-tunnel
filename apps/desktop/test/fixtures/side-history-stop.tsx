import { createRoot } from 'react-dom/client';
import type { Session } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../../src/client.ts';
import { FollowUps } from '../../src/followUps.ts';
import SideConversation from '../../src/SideConversation.tsx';
import '../../src/style.css';

const client = new ProxyClient();
const sessionId = crypto.randomUUID(),
  runId = crypto.randomUUID(),
  connectionId = crypto.randomUUID(),
  now = new Date().toISOString();
const session: Session = {
  id: sessionId,
  title: '同步中的侧边会话',
  autoTitle: false,
  projectPath: '/fixture',
  permissionMode: 'auto',
  model: null,
  effort: null,
  createdAt: now,
  updatedAt: now,
  activeRun: { id: runId, status: 'running', connectionId },
};
const commands: Parameters<ProxyClient['request']>[0][] = [];
// Only the transport is synthetic: SideConversation uses the real state store and follow-up queue.
client.request = async (command) => {
  commands.push(command);
  return { type: 'response', requestId: crypto.randomUUID(), ok: true };
};
client.historyCacheReady = true;
client.update({
  status: 'connected',
  connectionId,
  adapter: 'claude-code',
  sideConversations: true,
  sessions: [session],
  selectedId: sessionId,
  history: {
    [sessionId]: {
      loaded: false,
      loading: true,
      loadingEarlier: false,
      firstSequence: 1,
      lastSequence: 1,
      hasEarlier: false,
    },
  },
  events: {
    [sessionId]: [
      {
        sessionId,
        runId: crypto.randomUUID(),
        sequence: 1,
        createdAt: now,
        payload: {
          type: 'text.delta',
          messageId: crypto.randomUUID(),
          text: '已从本机缓存显示的侧边历史',
        },
      },
    ],
  },
});
const followUps = new FollowUps(client, (id) => client.historyPending(id));
followUps.start();
Object.assign(window, {
  sideHistoryStopFixture: {
    commands,
    sessionId,
    runId,
    pending: () => client.historyPending(sessionId),
  },
});

createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100vh', display: 'flex' }}>
    <SideConversation
      client={client}
      capabilities={null}
      sessionId={sessionId}
      draft=""
      setDraft={() => {}}
      quotes={[]}
      setQuotes={() => {}}
      attachments={[]}
      setAttachments={() => {}}
      followUps={followUps}
      focusDraft={false}
      onDraftFocusHandled={() => {}}
      openAccount={() => {}}
      onQuote={() => {}}
    />
  </div>,
);
