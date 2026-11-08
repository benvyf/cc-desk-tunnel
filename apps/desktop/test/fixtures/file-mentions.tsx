import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import Conversation from '../../src/Conversation.tsx';
import PreviewSidebar from '../../src/PreviewSidebar.tsx';
import { usePreviewWorkspace } from '../../src/preview.ts';
import type { Link } from '../../src/links.ts';
import '../../src/style.css';

const folder = 'C:\\Users\\benben\\Documents\\CC SPACE\\2026-10-29\\001601';
const docx = `${folder}\\婚礼主持稿_新流程.docx`;
const pdf = `${folder}\\婚礼主持稿_新流程.pdf`;
const written = 'C:\\其他目录\\记录.txt';
const files = new Set([docx, pdf, written, 'C:\\a\\style.css', 'C:\\b\\style.css']);
const reads: string[] = [];
const inspected: string[] = [];
const followed: Link[] = [];
const pending = new Map<string, () => void>();
const params = new URLSearchParams(location.search);
if (!params.has('browser'))
  window.desktop = {
    inspectPath: async (path: string) => {
      inspected.push(path);
      if (params.has('inspection-error')) throw new Error('模拟检查失败');
      if (params.has('race')) await new Promise<void>((resolve) => pending.set(path, resolve));
      return {
        kind: files.has(path)
          ? 'file'
          : [folder, 'C:\\成果.v2'].includes(path.replace(/[\\/]$/, ''))
            ? 'directory'
            : 'missing',
        runs: false,
        editors: [],
        openWith: false,
      };
    },
    preview: {
      read: async ({ path }: { path: string }) => {
        reads.push(path);
        return { path, kind: 'text', text: `预览内容：${path}` };
      },
      onState: () => () => {},
      release: async () => {},
      hide: async () => {},
    },
  } as unknown as NonNullable<Window['desktop']>;
const fixture = { reads, inspected, followed, resolve: (path: string) => pending.get(path)?.() };
Object.assign(window, { fileMentionFixture: fixture });

const now = new Date().toISOString();
const session: Session = {
  id: 'file-mentions',
  title: '成果',
  autoTitle: false,
  projectPath: 'C:\\项目',
  permissionMode: 'auto',
  model: null,
  effort: null,
  createdAt: now,
  updatedAt: now,
  activeRun: null,
};
const events: SessionEvent[] = [];
function emit(runId: string, payload: SessionEvent['payload']) {
  events.push({
    sessionId: session.id,
    runId,
    sequence: events.length + 1,
    createdAt: now,
    payload,
  });
}
emit('one', {
  type: 'message.user',
  messageId: 'question-one',
  text: '生成文件',
  scenario: 'chat',
});
emit('one', {
  type: 'tool.requested',
  toolId: 'bash',
  name: 'Bash',
  input: '{}',
  target: 'Windows',
});
emit('one', { type: 'tool.result', toolId: 'bash', status: 'completed', output: '', exitCode: 0 });
emit('one', {
  type: 'text.delta',
  messageId: 'answer-one',
  text: [
    `文件在 \`${folder}\\\`：`,
    '',
    '- `婚礼主持稿_新流程.docx`',
    '- `婚礼主持稿_新流程.pdf`',
    '- `不存在.pdf`',
    '',
    '`XXX` 和 `curl report.pdf` 是普通代码。',
    '',
    '```text',
    docx,
    '```',
    '',
    '[普通文件链接](C:/其他目录/记录.txt)',
    '',
    '[`现有链接`](C:/其他目录/记录.txt)',
  ].join('\n'),
});
emit('one', { type: 'run.status', status: 'completed', connectionId: 'fixture' });
emit('two', {
  type: 'message.user',
  messageId: 'question-two',
  text: '修改其他文件',
  scenario: 'chat',
});
for (const [id, path, status] of [
  ['write', written, 'completed'],
  ['style-a', 'C:\\a\\style.css', 'completed'],
  ['style-b', 'C:\\b\\style.css', 'completed'],
  ['failed', 'C:\\其他目录\\失败.txt', 'failed'],
] as const) {
  emit('two', {
    type: 'tool.requested',
    toolId: id,
    name: 'Write',
    input: JSON.stringify({ file_path: path, content: 'text' }),
    target: 'Windows',
  });
  emit('two', {
    type: 'tool.result',
    toolId: id,
    status,
    output: '',
    exitCode: status === 'failed' ? 1 : 0,
  });
}
emit('two', {
  type: 'text.delta',
  messageId: 'answer-two',
  text: '`记录.txt`、`style.css`、`失败.txt` 和上一轮的 `婚礼主持稿_新流程.docx`。',
});
emit('two', { type: 'run.status', status: 'completed', connectionId: 'fixture' });

if (params.has('edge') || params.has('race') || params.has('inspection-error')) {
  const outputs = [
    'C:\\项目\\out\\report.pdf',
    'C:\\其他目录\\report.pdf',
    'C:\\成果.v2\\100%2520完成.ts',
    'C:\\成果.v2\\100%20完成.ts',
    'C:\\成果.v2\\100 完成.ts',
    'C:\\成果.v2\\report.pdf',
    'C:\\成果.v2\\README',
    'C:\\成果.v2\\first.pdf',
    'C:\\成果.v2\\second.pdf',
    'C:\\docs\\guide.pdf',
    'C:\\项目\\src\\app.ts',
    'C:\\成果.v2\\app.ts',
  ];
  outputs.forEach((path) => files.add(path));
  events.length = 0;
  emit('edge', {
    type: 'message.user',
    messageId: 'edge-question',
    text: '检查文件路径',
    scenario: 'chat',
  });
  for (const [index, path] of outputs
    .slice(0, 3)
    .concat('C:\\成果.v2\\README', 'C:\\项目\\src\\app.ts')
    .entries()) {
    emit('edge', {
      type: 'tool.requested',
      toolId: `edge-${index}`,
      name: 'Write',
      input: JSON.stringify({ file_path: path, content: 'text' }),
      target: 'Windows',
    });
    emit('edge', {
      type: 'tool.result',
      toolId: `edge-${index}`,
      status: 'completed',
      output: '',
      exitCode: 0,
    });
  }
  emit('edge', {
    type: 'text.delta',
    messageId: 'edge-answer',
    text: params.has('edge')
      ? [
          '`out/report.pdf`',
          '',
          '文件在 `C:\\成果.v2`：',
          '',
          '`report.pdf`',
          '',
          '`100%2520完成.ts`',
          '',
          '`README`',
          '',
          '`C:\\成果.v2\\100%2520完成.ts:12:3`',
        ].join('\n')
      : '`C:\\成果.v2\\first.pdf`',
  });
  emit('edge', { type: 'run.status', status: 'completed', connectionId: 'fixture' });
}

if (params.has('posix')) {
  session.projectPath = '/project';
  events.length = 0;
  const outputs = ['archive\\report.pdf', '/out/report.pdf'];
  ['/project/archive\\report.pdf', '/project/archive/report.pdf', '/out/report.pdf'].forEach(
    (path) => files.add(path),
  );
  emit('posix', {
    type: 'message.user',
    messageId: 'posix-question',
    text: '检查 POSIX 路径',
    scenario: 'chat',
  });
  for (const [index, path] of outputs.entries()) {
    emit('posix', {
      type: 'tool.requested',
      toolId: `posix-${index}`,
      name: 'Write',
      input: JSON.stringify({ file_path: path, content: 'text' }),
      target: 'Linux',
    });
    emit('posix', {
      type: 'tool.result',
      toolId: `posix-${index}`,
      status: 'completed',
      output: '',
      exitCode: 0,
    });
  }
  emit('posix', {
    type: 'text.delta',
    messageId: 'posix-answer',
    text: '`archive\\report.pdf` 和 `report.pdf`，`REPORT.PDF` 不存在。',
  });
  emit('posix', { type: 'run.status', status: 'completed', connectionId: 'fixture' });
}

function Fixture() {
  const [messages, setMessages] = useState(events);
  useEffect(() => {
    Object.assign(fixture, {
      reply: (text: string) =>
        setMessages(
          events.map((event) =>
            event.payload.type === 'text.delta'
              ? { ...event, payload: { ...event.payload, text } }
              : event,
          ),
        ),
    });
  }, []);
  const board = usePreviewWorkspace('file-mentions', session.id, 'main', session.id);
  return (
    <div className="terminal-preview-layout" style={{ display: 'flex', height: '100vh' }}>
      <Conversation
        session={session}
        events={messages}
        history={undefined}
        here={!params.has('remote')}
        connected
        native
        ownsRun
        busy={false}
        fresh={false}
        findRequest={0}
        progress={undefined}
        clock={{ now: Date.now, activityAt: Date.now }}
        loadEarlier={async () => {}}
        stopTask={() => {}}
        backgroundTask={() => {}}
        stop={() => {}}
        replyApproval={async () => true}
        preview={(link) => {
          followed.push(link);
          return board.follow(link, session.projectPath);
        }}
      />
      {board.expanded && <PreviewSidebar workspace={board} root={session.projectPath} />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
