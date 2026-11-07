import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HistoryPage, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { localHistory } from '../../src/local-history.ts';
import { LocalHistorySync, historyStatuses } from '../../src/local-history-sync.ts';
import LocalHistoryPanel from '../../src/LocalHistoryPanel.tsx';
import { ProxyClient, RequestFailedError } from '../../src/client.ts';
import '../../src/style.css';
const owner = 'a'.repeat(64);
const scope = { owner, server: 'b'.repeat(64), label: '离线测试工作空间' };
const session: Session = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '本地持久会话',
  autoTitle: false,
  model: null,
  effort: null,
  projectPath: 'D:\\fixture',
  permissionMode: 'auto',
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
  activeRun: null,
};
const event = (sequence: number, text = '离线聊天 ' + sequence): SessionEvent => ({
  sessionId: session.id,
  runId: '22222222-2222-4222-8222-222222222222',
  sequence,
  createdAt: session.createdAt,
  payload: {
    type: 'message.user',
    messageId: `33333333-3333-4333-8333-${sequence.toString(16).padStart(12, '0')}`,
    text,
    scenario: 'chat',
  },
});
const page = (
  sequences: number[],
  mode: HistoryPage['mode'] = 'replace',
  hasEarlier = false,
): HistoryPage => ({
  session,
  events: sequences.map((n) => event(n)),
  requestId: crypto.randomUUID(),
  firstSequence: sequences[0] ?? 0,
  lastSequence: sequences.at(-1) ?? 0,
  mode,
  hasEarlier,
});
let previewReads = 0;
Object.assign(window, {
  desktop: {
    platform: 'win32',
    localHistory: {
      identity: async () => ({ owner, email: 'owner@example.com' }),
      attachment: async () => 'data:image/png;base64,aGVsbG8=',
      onIdentityChanged: () => () => {},
    },
    attachmentPreview: async () => {
      previewReads++;
      return null;
    },
    copyText: async () => {},
  },
});
const client = new ProxyClient();
Object.assign(window, {
  historyFixture: {
    store: localHistory,
    scope,
    session,
    event,
    page,
    client,
    historyStatuses,
    previewReads: () => previewReads,
    async sync(pages: HistoryPage[], fail: boolean | 'gone' = false, early?: HistoryPage) {
      const calls: string[] = [];
      const fake = {
        state: { status: 'connected', device: null, sessions: [session] },
        fetch: async (command: { type: string }) => {
          calls.push(command.type);
          if (fail === 'gone') throw new RequestFailedError('会话不存在。', 'not_found');
          if (fail) throw new Error('fixture network failure');
          const next = pages.shift();
          if (!next) throw new Error('missing fixture page');
          return next;
        },
      };
      const sync = new LocalHistorySync(fake as unknown as ProxyClient, scope);
      sync.ready([session], true);
      if (early) sync.page(early);
      for (let n = 0; n < 200; n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (!historyStatuses(owner).some((s) => s.syncing)) break;
      }
      return { calls, status: historyStatuses(owner) };
    },
  },
});
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>查看本地记录</button>
      {open && <LocalHistoryPanel client={client} close={() => setOpen(false)} />}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
