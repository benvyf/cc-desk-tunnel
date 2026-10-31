import { useState } from 'react';
import { previewPdf } from '../../test-main/fixtures/preview-pdf.ts';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import PreviewSidebar from '../../src/PreviewSidebar.tsx';
import { usePreviewWorkspace } from '../../src/preview.ts';
import type { PreviewBrowserState, PreviewFile } from '../../src/preview.ts';
import { Button } from '../../src/ui.tsx';
import '../../src/style.css';

const listeners = new Set<(state: PreviewBrowserState) => void>();
type ReadOptions = {
  delayMs?: number;
  short?: boolean;
  missing?: boolean;
  fail?: boolean;
  pages?: number;
  badPage?: number;
};
type Watch = { key: string; path: string; file?: boolean };
const changed = new Set<(event: { key: string; path: string }) => void>();
const watches = new Map<string, Watch>();
const readOptions = new Map<string, ReadOptions>();
const activeTokens = new Map<string, string>();
const issuedTokens: { token: string; path: string }[] = [];
const releasedTokens = new Map<string, number>();
const issueToken = (path: string) => {
  const token = `fixture-file-${issuedTokens.length + 1}`;
  activeTokens.set(token, path);
  issuedTokens.push({ token, path });
  return token;
};
const metrics = {
  renders: 0,
  reads: 0,
  completedReads: 0,
  lists: 0,
  watchCalls: 0,
  unwatchCalls: 0,
  listenerAdds: 0,
  listenerRemoves: 0,
  releaseFiles: 0,
  nativeShows: 0,
  readsByPath: {} as Record<string, number>,
};
(window as any).fixturePreview = {
  configure(suffix: string, options: ReadOptions) {
    readOptions.set(suffix, options);
  },
  emit(suffix: string) {
    for (const watch of watches.values())
      if (watch.path.endsWith(suffix))
        for (const callback of changed) callback({ key: watch.key, path: watch.path });
  },
  counts: () => ({
    ...metrics,
    readsByPath: { ...metrics.readsByPath },
    activeWatches: watches.size,
    activeChangedListeners: changed.size,
    activeStateListeners: listeners.size,
    activeTokens: [...activeTokens.keys()],
    issuedTokens: issuedTokens.map((entry) => ({ ...entry })),
    releasedTokens: Object.fromEntries(releasedTokens),
  }),
};
const caseSensitive = new URLSearchParams(location.search).has('case-sensitive');
const folder = caseSensitive ? '/work/preview' : 'C:\\工作\\网站预览';
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><rect width="360" height="200" fill="#f5f5f3"/><path d="M32 160 100 110 168 130 240 60 320 40" fill="none" stroke="#d97757" stroke-width="8"/></svg>')}`;
(window as any).desktop = {
  boot: { connection: new URLSearchParams(location.search).get('connection') ?? '' },
  copyText: async () => {},
  openLink: async () => {},
  actOnPath: async () => {
    if ((window as any).fixtureFailOpen) {
      (window as any).fixtureFailOpen = false;
      throw new Error('模拟系统打开失败');
    }
    return '';
  },
  preview: {
    async list({ path }: { path: string }) {
      metrics.lists++;
      if (caseSensitive)
        return ['Case.md', 'case.md'].map((name) => ({
          name,
          path: folder + '/' + name,
          kind: 'file',
        }));
      return path.endsWith('src')
        ? [{ name: 'index.ts', path: path + '\\index.ts', kind: 'file' }]
        : [
            { name: 'src', path: path + '\\src', kind: 'directory' },
            { name: '说明.md', path: path + '\\说明.md', kind: 'file' },
          ];
    },
    async watch(input: Watch) {
      metrics.watchCalls++;
      watches.set(input.key, input);
    },
    async unwatch(key: string) {
      metrics.unwatchCalls++;
      watches.delete(key);
    },
    onChanged(callback: (event: { key: string; path: string }) => void) {
      metrics.listenerAdds++;
      changed.add(callback);
      return () => {
        metrics.listenerRemoves++;
        changed.delete(callback);
      };
    },
    async read({ path }: { path: string }): Promise<PreviewFile> {
      metrics.reads++;
      metrics.readsByPath[path] = (metrics.readsByPath[path] ?? 0) + 1;
      const options = { ...[...readOptions].find(([suffix]) => path.endsWith(suffix))?.[1] };
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      metrics.completedReads++;
      if (options.missing) throw new Error('文件已删除，等待重建。');
      if (options.fail) throw new Error('模拟读取失败，请刷新重试。');
      if (path.endsWith('长阅读.txt'))
        return {
          path,
          kind: 'text',
          text: Array.from(
            { length: options.short ? 35 : 360 },
            (_, i) =>
              `Reading paragraph ${i + 1}: CC SPACE preserves the current document position.`,
          ).join('\n'),
        };
      if (path.endsWith('长代码.ts'))
        return {
          path,
          kind: 'text',
          text: Array.from(
            { length: options.short ? 35 : 360 },
            (_, i) =>
              `export const readingRow${i + 1} = { label: "${'wide code column '.repeat(24)}", enabled: true };`,
          ).join('\n'),
        };
      if (path.endsWith('长说明.md'))
        return {
          path,
          kind: 'markdown',
          text:
            '# Reading handbook\n\n' +
            Array.from(
              { length: options.short ? 3 : 100 },
              (_, i) =>
                `## Section ${i + 1}\n\nRead the generated report while continuing the discussion. This section includes enough detail to keep a stable reading position.\n\n- Check the local result\n- Review the next change\n\n\`\`\`ts\nconst section${i + 1} = "${'wide source column '.repeat(12)}";\n\`\`\`\n`,
            ).join('\n'),
        };
      if (path.endsWith('多页报告.pdf'))
        return {
          path,
          kind: 'pdf',
          token: issueToken(path),
          data: btoa(
            String.fromCharCode(
              ...previewPdf('Reading report', {
                pages: options.pages ?? 4,
                badPage: options.badPage,
                width: 600,
                height: 1200,
              }),
            ),
          ),
        };
      if (path.includes('长错误'))
        throw new Error(
          '找不到文件：C:\\' + '很长的项目目录\\'.repeat(60) + '报告.txt。请确认路径。',
        );
      if (path.includes('不存在'))
        throw new Error('找不到这个文件，请确认路径或在系统应用中打开。');
      if (path.includes('读取中')) return new Promise(() => {});
      if (path.endsWith('alias.txt'))
        return {
          path,
          kind: 'html',
          token: issueToken(path),
          text: '<h1>HTML alias</h1>',
          url: 'http://file.localhost/index.html',
        };
      if (path.endsWith('.pdf'))
        return {
          path,
          kind: 'pdf',
          token: issueToken(path),
          data: btoa(String.fromCharCode(...previewPdf())),
        };
      if (path.endsWith('.png')) return { path, kind: 'image', image };
      if (path.endsWith('.md'))
        return {
          path,
          kind: 'markdown',
          text: '# 项目说明\n\n在这里查看生成的文件，继续在左侧讨论。\n\n## 使用方式\n\n- 支持中文与长文件名\n- 选择 `localhost` 本机地址\n\n```js\nconst preview = "CC SPACE";\n```\n\n[项目外文档](../outside.md)',
        };
      return {
        path,
        kind: 'text',
        text: JSON.stringify(
          { name: 'CC SPACE', description: '长内容 '.repeat(80), enabled: true },
          null,
          2,
        ),
      };
    },
    async releaseFile(token: string) {
      metrics.releaseFiles++;
      activeTokens.delete(token);
      releasedTokens.set(token, (releasedTokens.get(token) ?? 0) + 1);
    },
    async release(input: any) {
      ((window as any).fixtureReleased ??= []).push(input.key);
    },
    async hide() {},
    async bounds() {},
    async action() {},
    async pick() {
      if ((window as any).fixtureFailPick) {
        (window as any).fixtureFailPick = false;
        throw new Error('模拟文件选择失败');
      }
      return folder + '\\说明.md';
    },
    async show(input: { surface: 'main'; key: string; url: string }) {
      metrics.nativeShows++;
      queueMicrotask(() =>
        listeners.forEach((callback) =>
          callback({
            ...input,
            title: '',
            back: false,
            forward: false,
            loading: false,
            error: '页面无法加载，请确认本机开发服务已启动。',
          }),
        ),
      );
    },
    onState(callback: (state: PreviewBrowserState) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  },
};

function Fixture() {
  metrics.renders++;
  const terminal = new URLSearchParams(location.search).has('terminal');
  const [scope, setScope] = useState('fixture');
  const [session, setSession] = useState('session');
  const board = usePreviewWorkspace(
    scope,
    session,
    terminal ? 'terminal' : 'main',
    'session\nother-session',
  );
  const [opened, setOpened] = useState(false);
  const controls = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 20 }}>
      <Button
        onClick={() => {
          setOpened(true);
          if (!board.expanded) board.toggle();
        }}
      >
        展开空栏
      </Button>
      {[
        ['打开文档', '说明.md'],
        ['长文件名', '中文文件名和 very-long-file-name '.repeat(8) + '.json'],
        ['错误状态', '不存在.txt'],
        ['长错误状态', '长错误.txt'],
        ['加载状态', '读取中.md'],
        ['图片状态', '趋势图.png'],
        ['PDF 状态', '报告.pdf'],
        ['长文本', '长阅读.txt'],
        ['长代码', '长代码.ts'],
        ['长 Markdown', '长说明.md'],
        ['多页 PDF', '多页报告.pdf'],
      ].map(([label, name]) => (
        <Button
          key={label}
          onClick={() => {
            setOpened(true);
            board.openFile(folder + '\\' + name, folder);
          }}
        >
          {label}
        </Button>
      ))}
      <Button
        onClick={() => {
          setOpened(true);
          board.openWebsite('http://localhost:5173');
        }}
      >
        网站错误
      </Button>
      <Button
        onClick={() => {
          setOpened(true);
          for (let i = 0; i < 8; i++)
            board.openFile(folder + `\\报告 ${i} very-long-file-name.json`, folder);
        }}
      >
        多个标签
      </Button>
      <Button onClick={() => setScope(scope === 'fixture' ? 'other' : 'fixture')}>
        切换预览工作区
      </Button>
      <Button onClick={() => setSession(session === 'session' ? 'other-session' : 'session')}>
        切换预览会话
      </Button>
      <Button data-size="sm" size="sm" aria-label="对照按钮">
        对照按钮
      </Button>
    </div>
  );
  return terminal ? (
    <div className="terminal-preview-layout" style={{ height: '100dvh' }}>
      <div className="terminal-workspace" data-native-controls="true">
        <header className="terminal-tabs-header">
          <Button data-preview-toggle onClick={board.toggle}>
            预览开关
          </Button>
        </header>
        {controls}
      </div>
      {opened && board.expanded && (
        <PreviewSidebar workspace={board} surface="terminal" root={folder} />
      )}
    </div>
  ) : (
    <div
      className={`shell side-closed ${board.expanded ? 'has-preview' : ''}`}
      style={{ '--preview-width': `${board.width}px` } as CSSProperties}
    >
      <header className="titlebar">
        <Button data-preview-toggle onClick={board.toggle}>
          预览开关
        </Button>
      </header>
      <main className="workspace">{controls}</main>
      {opened && board.expanded && <PreviewSidebar workspace={board} root={folder} />}
    </div>
  );
}
function PopupFixture() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        onClick={() => {
          const popup = window.open('', '', 'width=1280,height=900')!;
          for (const style of document.querySelectorAll('style, link[rel="stylesheet"]'))
            popup.document.head.append(style.cloneNode(true));
          const target = popup.document.createElement('div');
          popup.document.body.append(target);
          setContainer(target);
        }}
      >
        打开弹出预览
      </Button>
      {container && createPortal(<Fixture />, container)}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('popup') ? <PopupFixture /> : <Fixture />,
);
