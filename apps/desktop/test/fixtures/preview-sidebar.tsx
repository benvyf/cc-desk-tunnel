import { useState } from 'react';
import { previewPdf } from '../../test-main/fixtures/preview-pdf.ts';
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import PreviewSidebar from '../../src/PreviewSidebar.tsx';
import { usePreviewWorkspace } from '../../src/preview.ts';
import type { PreviewBrowserState, PreviewFile } from '../../src/preview.ts';
import { Button } from '../../src/ui.tsx';
import '../../src/style.css';

const listeners = new Set<(state: PreviewBrowserState) => void>();
const folder = 'C:\\工作\\网站预览';
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200"><rect width="360" height="200" fill="#f5f5f3"/><path d="M32 160 100 110 168 130 240 60 320 40" fill="none" stroke="#d97757" stroke-width="8"/></svg>')}`;
(window as any).desktop = {
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
      return path.endsWith('src')
        ? [{ name: 'index.ts', path: path + '\\index.ts', kind: 'file' }]
        : [
            { name: 'src', path: path + '\\src', kind: 'directory' },
            { name: '说明.md', path: path + '\\说明.md', kind: 'file' },
          ];
    },
    async watch() {},
    async unwatch() {},
    onChanged() {
      return () => {};
    },
    async read({ path }: { path: string }): Promise<PreviewFile> {
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
          text: '<h1>HTML alias</h1>',
          url: 'http://file.localhost/index.html',
        };
      if (path.endsWith('.pdf'))
        return { path, kind: 'pdf', data: btoa(String.fromCharCode(...previewPdf())) };
      if (path.endsWith('.png')) return { path, kind: 'image', image };
      if (path.endsWith('.md'))
        return {
          path,
          kind: 'markdown',
          text: '# 项目说明\n\n在这里查看生成的文件，继续在左侧讨论。\n\n## 使用方式\n\n- 支持中文与长文件名\n- 选择 `localhost` 本机地址\n\n```js\nconst preview = "CC SPACE";\n```',
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
    async releaseFile() {},
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
  const terminal = new URLSearchParams(location.search).has('terminal');
  const [scope, setScope] = useState('fixture');
  const board = usePreviewWorkspace(scope, 'session', terminal ? 'terminal' : 'main', 'session');
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
createRoot(document.getElementById('root')!).render(<Fixture />);
