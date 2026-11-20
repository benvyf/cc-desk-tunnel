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
// The most a file's diff is read to (electron/git-changes.cjs DIFF_LIMIT); a longer one comes back cut short.
export const gitDiffLimit = 512 * 1024;
// What went wrong, without what Electron says about the call it went wrong in.
export const gitError = (error: unknown, fallback: string) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    : fallback;
// A listed file's full path as this computer writes it: git names the top of the tree with forward slashes.
export function gitFilePath(top: string, path: string) {
  const full = `${top.replace(/[\\/]$/, '')}/${path}`;
  return /^[A-Za-z]:/.test(full) ? full.replace(/\//g, '\\') : full;
}

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

// A row of a diff as the preview shows it (PreviewDiff.tsx): a hunk's heading, a line with its number on each
// side it is on, or git's note that a side ends without a line break.
export type DiffRow = {
  kind: '+' | '-' | ' ' | '@' | '\\';
  text: string;
  old?: number;
  new?: number;
};
// The rows of a file's unified diff, and where each hunk starts among them. What comes before the first hunk, and
// between hunks once a hunk's lines are all there (headers), is left out; a diff cut short ends where it was cut.
// `endings`: every line that went out came back the same but for its line ending (CRLF and LF).
export function diffRows(text: string): { rows: DiffRow[]; hunks: number[]; endings?: boolean } {
  const rows: DiffRow[] = [];
  const hunks: number[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  // The lines of the current hunk still to come on each side, as its heading counts them.
  let oldLeft = 0;
  let newLeft = 0;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const heading = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (heading) {
      oldLine = Number(heading[1]);
      newLine = Number(heading[3]);
      oldLeft = heading[2] === undefined ? 1 : Number(heading[2]);
      newLeft = heading[4] === undefined ? 1 : Number(heading[4]);
      // A side with no lines names the line before where they would be.
      if (!oldLeft) oldLine++;
      if (!newLeft) newLine++;
      hunks.push(rows.length);
      rows.push({ kind: '@', text: line });
      continue;
    }
    if (line.startsWith('\\')) {
      if (hunks.length) rows.push({ kind: '\\', text: line.slice(1).trim() });
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const mark = line[0];
    if (mark === '+') {
      rows.push({ kind: '+', text: line.slice(1), new: newLine++ });
      added.push(raw.slice(1));
      newLeft--;
    } else if (mark === '-') {
      rows.push({ kind: '-', text: line.slice(1), old: oldLine++ });
      removed.push(raw.slice(1));
      oldLeft--;
    } else {
      rows.push({ kind: ' ', text: line.slice(1), old: oldLine++, new: newLine++ });
      oldLeft--;
      newLeft--;
    }
  }
  const bare = (value: string) => value.replace(/\r$/, '');
  const endings =
    removed.length > 0 &&
    removed.length === added.length &&
    removed.every((value, index) => bare(value) === bare(added[index])) &&
    removed.some((value, index) => value !== added[index]);
  return endings ? { rows, hunks, endings } : { rows, hunks };
}
// An untracked file's text as one hunk of added lines, as git would show it once added.
export function addedRows(text: string): { rows: DiffRow[]; hunks: number[] } {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return { rows: [], hunks: [] };
  return {
    rows: [
      { kind: '@', text: `@@ -0,0 +1,${lines.length} @@` },
      ...lines.map((line, index) => ({
        kind: '+' as const,
        text: line.replace(/\r$/, ''),
        new: index + 1,
      })),
    ],
    hunks: [0],
  };
}
