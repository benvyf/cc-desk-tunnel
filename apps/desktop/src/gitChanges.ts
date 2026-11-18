// What the changes panel is given by the desktop (electron/git-changes.cjs).
export type GitChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U';
export type GitChange = {
  path: string;
  oldPath?: string;
  status: GitChangeStatus;
  added?: number;
  deleted?: number;
  binary?: boolean;
  conflict?: boolean;
};
export type GitChangeList = {
  top: string;
  branch: string | null;
  refs: { local: string[]; remote: string[] };
  base: string | null;
  against: string;
  files: GitChange[];
  summary: { files: number; added: number; deleted: number; untracked: number };
  truncated: boolean;
  filtered: string[];
};
export type GitFileDiff =
  | { kind: 'diff'; text: string; truncated: boolean }
  | { kind: 'new'; text: string; truncated: boolean }
  | { kind: 'binary' }
  | { kind: 'other' }
  | { kind: 'link'; target: string };

export const statusNames: Record<GitChangeStatus, string> = {
  M: '修改',
  A: '新增',
  D: '删除',
  R: '重命名',
  U: '未跟踪',
};
// A ref's name as people say it: main, origin/main.
export const refName = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');

// A unified diff's lines, without the headers before its first hunk.
export function diffLines(text: string): { kind: '+' | '-' | ' ' | '@'; text: string }[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const first = lines.findIndex((line) => line.startsWith('@@'));
  if (first < 0) return [];
  return lines
    .slice(first)
    .map((line) =>
      line.startsWith('@@')
        ? { kind: '@' as const, text: line }
        : line.startsWith('+')
          ? { kind: '+' as const, text: line.slice(1) }
          : line.startsWith('-')
            ? { kind: '-' as const, text: line.slice(1) }
            : { kind: ' ' as const, text: line.slice(1) },
    );
}
