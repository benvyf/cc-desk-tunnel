import { createRoot } from 'react-dom/client';
import GitChanges from '../../src/GitChanges.tsx';
import type { GitChangeList } from '../../src/gitChanges.ts';

// The changes panel on its own, with the desktop's Git stubbed: what it was asked is kept on `window.asked`.
declare global {
  interface Window {
    asked: { changes: unknown[]; fileDiff: unknown[]; opened: string[] };
  }
}
const list = (base?: string): GitChangeList => ({
  top: 'D:/工作/仓库',
  branch: 'feature',
  refs: { local: ['refs/heads/feature', 'refs/heads/main'], remote: ['refs/remotes/origin/main'] },
  base: base ?? null,
  against: 'a'.repeat(40),
  files: base
    ? [{ path: 'only-on-branch.ts', status: 'A', added: 4, deleted: 0 }]
    : [
        { path: 'src/app.ts', status: 'M', added: 3, deleted: 1 },
        { path: 'gone.txt', status: 'D', added: 0, deleted: 2 },
        { path: 'new name.md', oldPath: 'old name.md', status: 'R', added: 0, deleted: 0 },
        { path: 'pic.png', status: 'M', binary: true },
        { path: 'both.ts', status: 'M', added: 1, deleted: 1, conflict: true },
        { path: '笔记.txt', status: 'U' },
      ],
  summary: base
    ? { files: 1, added: 4, deleted: 0, untracked: 0 }
    : { files: 6, added: 4, deleted: 4, untracked: 1 },
  truncated: new URL(location.href).searchParams.has('truncated'),
  filtered: [],
});

export function mount() {
  const params = new URL(location.href).searchParams;
  window.asked = { changes: [], fileDiff: [], opened: [] };
  window.desktop = {
    git: {
      changes: async (input: { base?: string }) => {
        window.asked.changes.push(input);
        if (params.has('fail')) throw new Error('项目不在 Git 仓库中。');
        return list(input.base);
      },
      fileDiff: async (input: { path: string }) => {
        window.asked.fileDiff.push(input);
        if (input.path === 'pic.png') return { kind: 'binary' };
        if (input.path === '笔记.txt')
          return { kind: 'new', text: '第一行\n第二行\n', truncated: false };
        return {
          kind: 'diff',
          text: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,4 @@\n keep\n-old\n+new\n+more\n+again\n',
          truncated: false,
        };
      },
    },
  } as unknown as Window['desktop'];
  const root = document.createElement('main');
  root.style.cssText = 'display:flex;height:600px';
  document.body.replaceChildren(root);
  createRoot(root).render(
    <GitChanges
      root="D:\工作\仓库"
      targetId={params.get('target') ?? undefined}
      openFile={params.has('ssh') ? undefined : (path) => window.asked.opened.push(path)}
    />,
  );
}
