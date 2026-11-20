import { useState } from 'react';
import { previewPdf } from '../../test-main/fixtures/preview-pdf.ts';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import PreviewSidebar from '../../src/PreviewSidebar.tsx';
import { useColumnsGliding, useLeaving } from '../../src/Presence.tsx';
import { previewSpan, usePreviewWorkspace } from '../../src/preview.ts';
import { linkTarget } from '../../src/links.ts';
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
  pdfText?: string;
  pdfUserUnit?: number;
  rotation?: number;
  noText?: boolean;
  codeText?: string;
  codeLines?: number;
  aliasMarkdown?: boolean;
  size?: number;
};
type Watch = { key: string; path: string; file?: boolean };
const changed = new Set<(event: { key: string; path: string }) => void>();
// The key of the page last shown natively, which a page's own window.open is told for (openFromPage).
let lastShown = '';
const watches = new Map<string, Watch>();
const readOptions = new Map<string, ReadOptions>();
const sourceTexts = new Map<string, string>();
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
  source(suffix: string) {
    return [...sourceTexts].find(([path]) => path.endsWith(suffix))?.[1];
  },
  // A shown page asks to open a link (window.open): the main process says so in the page's state.
  openFromPage(open: PreviewBrowserState['open']) {
    for (const callback of listeners)
      callback({
        surface: 'main',
        key: lastShown,
        url: 'http://localhost:5173/',
        title: '',
        loading: false,
        back: false,
        forward: false,
        error: '',
        open,
      });
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
  copyText: async (text: string) => {
    ((window as any).fixtureCopied ??= []).push(text);
  },
  openLink: async () => {},
  // A folder is named src; everything else is a file.
  inspectPath: async (path: string) => ({
    kind: /[\\/]src$/.test(path) ? 'directory' : 'file',
    runs: false,
    editors: [],
    openWith: true,
  }),
  actOnPath: async (action: string, path: string) => {
    ((window as any).fixtureActs ??= []).push([action, path]);
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
              `Reading paragraph ${i + 1}: CC Space preserves the current document position.`,
          ).join('\n'),
        };
      if (path.endsWith('长代码.ts')) {
        const text =
          options.codeText ??
          Array.from(
            { length: options.codeLines ?? (options.short ? 35 : 360) },
            (_, i) =>
              `export const readingRow${i + 1} = { label: "${'wide code column '.repeat(24)}", enabled: true };`,
          ).join('\n');
        sourceTexts.set(path, text);
        return {
          path,
          kind: 'text',
          text,
        };
      }
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
              ...previewPdf(options.pdfText ?? 'Reading report', {
                pages: options.pages ?? 4,
                badPage: options.badPage,
                width: 600,
                height: 1200,
                rotation: options.rotation,
                userUnit: options.pdfUserUnit,
                noText: options.noText,
              }),
            ),
          ),
        };
      if (path.endsWith('旧编码.txt'))
        return { path, kind: 'text', text: '中文测试\n第二行', encoding: 'gb18030' };
      // The main process read the first 4 MiB of a 12.5 MiB log.
      if (path.endsWith('大日志.log'))
        return {
          path,
          kind: 'text',
          text: Array.from({ length: 300 }, (_, i) => `log line ${i + 1}`).join('\n') + '\n',
          truncated: true,
          size: options.size ?? 12.5 * 1024 * 1024,
        };
      if (path.includes('长错误'))
        throw new Error(
          '找不到文件：C:\\' + '很长的项目目录\\'.repeat(60) + '报告.txt。请确认路径。',
        );
      if (path.endsWith('删除.txt'))
        throw new Error('找不到这个文件，请确认路径或在系统应用中打开。');
      if (path.includes('不存在'))
        throw new Error('找不到这个文件，请确认路径或在系统应用中打开。');
      if (path.includes('读取中')) return new Promise(() => {});
      if (path.endsWith('alias.txt') && options.aliasMarkdown)
        return { path, kind: 'markdown', text: '# Former Markdown alias' };
      if (path.endsWith('alias.txt') || path.endsWith('index.html'))
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
      if (path.endsWith('链接.md'))
        return { path, kind: 'markdown', text: '见 [文件夹](src) 和 [压缩包](a.zip)。' };
      if (path.endsWith('.md'))
        return {
          path,
          kind: 'markdown',
          text: '# 项目说明\n\n在这里查看生成的文件，继续在左侧讨论。\n\n## 使用方式\n\n- 支持中文与长文件名\n- 选择 `localhost` 本机地址\n\n```js\nconst preview = "CC Space";\n```\n\n[项目外文档](../outside.md)',
        };
      return {
        path,
        kind: 'text',
        text: JSON.stringify(
          { name: 'CC Space', description: '长内容 '.repeat(80), enabled: true },
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
      lastShown = input.key;
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

// The project's Git changes (?git), as electron/git-changes.cjs gives them: what the changes panel and a file tab's
// 改动 view are told, and what they asked, on window.fixtureGit.
const git = new URLSearchParams(location.search).has('git');
if (git) {
  const asked = ((window as any).fixtureGit = {
    changes: [] as unknown[],
    fileDiff: [] as unknown[],
  });
  const diffs: Record<string, unknown> = {
    '长代码.ts': {
      kind: 'diff',
      truncated: false,
      text: [
        'diff --git a/长代码.ts b/长代码.ts',
        '--- a/长代码.ts',
        '+++ b/长代码.ts',
        '@@ -10,5 +10,6 @@ export const',
        ' export const readingRow10 = 1;',
        ' export const readingRow11 = 1;',
        '-export const readingRow12 = 0;',
        '+export const readingRow12 = 1;',
        '+export const added = true;',
        ' export const readingRow13 = 1;',
        ' export const readingRow14 = 1;',
        '@@ -300,3 +301,3 @@',
        ' export const readingRow300 = 1;',
        '-export const readingRow301 = 0;',
        '+export const readingRow301 = 1;',
        ' export const readingRow302 = 1;',
        '',
      ].join('\n'),
    },
    '说明.md': {
      kind: 'diff',
      truncated: false,
      text: '--- a/说明.md\n+++ b/说明.md\n@@ -1,3 +1,3 @@\n # 项目说明\n \n-旧的说明\n+在这里查看生成的文件，继续在左侧讨论。\n',
    },
    '长阅读.txt': {
      kind: 'diff',
      truncated: false,
      text:
        '--- a/长阅读.txt\n+++ b/长阅读.txt\n@@ -1,0 +1,1200 @@\n' +
        Array.from({ length: 1200 }, (_, i) => `+Reading paragraph ${i + 1}`).join('\n') +
        '\n@@ -10,1 +1210,1 @@\n-old far line\n+new far line\n',
    },
    '大日志.log': {
      kind: 'diff',
      truncated: true,
      text: '--- a/大日志.log\n+++ b/大日志.log\n@@ -1,2 +1,3 @@\n log line 1\n+log line 2\n log line 3\n',
    },
    '趋势图.png': { kind: 'binary' },
    '删除.txt': {
      kind: 'diff',
      truncated: false,
      text: '--- a/删除.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-第一行\n-第二行\n',
    },
  };
  (window as any).desktop.git = {
    changes: async (input: unknown) => {
      asked.changes.push(input);
      return {
        top: 'C:/工作/网站预览',
        branch: 'main',
        refs: { local: ['refs/heads/main'], remote: [] },
        base: null,
        against: 'a'.repeat(40),
        files: [
          { path: '删除.txt', status: 'D', added: 0, deleted: 2 },
          { path: '大日志.log', status: 'M', added: 1, deleted: 0 },
          { path: '说明.md', status: 'M', added: 1, deleted: 1 },
          { path: '趋势图.png', status: 'M', binary: true },
          { path: '长代码.ts', status: 'M', added: 3, deleted: 2 },
          { path: '长阅读.txt', status: 'M', added: 1201, deleted: 1 },
        ],
        summary: { files: 6, added: 1206, deleted: 6, untracked: 0 },
        truncated: false,
        filtered: [],
      };
    },
    fileDiff: async (input: { path: string }) => {
      asked.fileDiff.push(input);
      return diffs[input.path];
    },
  };
}

function Fixture() {
  metrics.renders++;
  const terminal = new URLSearchParams(location.search).has('terminal');
  const [scope, setScope] = useState('fixture');
  const [session, setSession] = useState('session');
  const [draft, setDraft] = useState('');
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
        ['普通 HTML 别名', 'alias.txt'],
        ['普通 HTML 文件', 'index.html'],
        ['GBK 文本', '旧编码.txt'],
        ['大日志', '大日志.log'],
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
      {[
        ['定位代码第12行', '长代码.ts', 12],
        ['定位代码第20行', '长代码.ts', 20],
        ['定位 Markdown 第12行', '长说明.md', 12],
        ['定位 Markdown 第300行', '长说明.md', 300],
        ['定位 HTML 源码', 'alias.txt', 1],
        ['定位 HTML 文件源码', 'index.html', 1],
      ].map(([label, name, line]) => (
        <Button
          key={label}
          onClick={() => {
            setOpened(true);
            board.follow({ kind: 'path', path: folder + '\\' + name, line: Number(line) }, folder);
          }}
        >
          {label}
        </Button>
      ))}
      {['长代码.ts:12', '长代码.ts#L20', '长代码.ts:360:10'].map((href) => (
        <a
          key={href}
          href={href}
          onClick={(event) => {
            event.preventDefault();
            const target = linkTarget(href, { projectPath: folder, here: true, browser: false });
            if (target) {
              setOpened(true);
              board.follow(target, folder);
            }
          }}
        >
          {href}
        </a>
      ))}
      {[
        ['链接文档', false],
        ['受限链接文档', true],
      ].map(([label, restricted]) => (
        <Button
          key={String(label)}
          onClick={() => {
            setOpened(true);
            board.openFile(folder + '\\链接.md', folder, !!restricted);
          }}
        >
          {label}
        </Button>
      ))}
      <Button
        onClick={() => {
          setOpened(true);
          board.openFile(folder + '\\链接.md', folder, true, undefined, true);
        }}
      >
        临时链接文档
      </Button>
      <Button
        onClick={() => {
          setOpened(true);
          void board.follow({ kind: 'web', url: 'http://localhost:5173' }, folder);
        }}
      >
        临时网站
      </Button>
      <input
        aria-label="测试输入"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
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
      <Button
        onClick={() => {
          setOpened(true);
          for (let i = 0; i < 64; i++) board.openFile(folder + `\\满 ${i}.json`, folder);
        }}
      >
        填满标签
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
  // As in App.tsx: the preview slides out before it goes, and its column glides open and shut.
  const leaving = useLeaving(opened && board.expanded);
  const previewWidth = previewSpan(board.width, board.tree);
  useColumnsGliding(`${board.expanded} ${previewWidth}`);
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
      style={{ '--preview-width': `${previewWidth}px` } as CSSProperties}
    >
      <header className="titlebar">
        <Button data-preview-toggle onClick={board.toggle}>
          预览开关
        </Button>
      </header>
      <main className="workspace">{controls}</main>
      {opened && (board.expanded || leaving) && (
        <PreviewSidebar
          workspace={board}
          root={folder}
          changes={git ? { root: folder } : undefined}
          leaving={!board.expanded}
          attach={(path) => {
            const attached: string[] = ((window as any).fixtureAttached ??= []);
            const result = attached.includes(path) ? 'duplicate' : 'added';
            attached.push(path);
            return result;
          }}
        />
      )}
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
