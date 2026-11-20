import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { ArrowDown, ArrowUp, LoaderCircle } from './icons.tsx';
import { Button, IconButton } from './ui.tsx';
import { addedRows, diffRows, gitDiffLimit } from './gitChanges.ts';
import type { DiffRow, GitChange } from './gitChanges.ts';
import type { GitFileDiffState } from './useGitFile.ts';

// Rows are laid out a chunk at a time: a chunk off screen is skipped by the page (content-visibility, style.css),
// and the chunks after the first few are added over the next frames, so a diff of thousands of lines opens at once.
const chunkRows = 200;
const firstChunks = 4;

// A file's changes in its preview tab: the unified diff against the base its project's changes panel uses, with
// each side's line number. A number of the file as it is now opens the file's source at that line (`openLine`).
export default function PreviewDiff({
  diff,
  change,
  wrap,
  setWrap,
  reveal,
  openLine,
}: {
  // Not read yet: undefined.
  diff: GitFileDiffState | undefined;
  change?: GitChange;
  wrap: boolean;
  setWrap: (value: boolean) => void;
  // A request to show the first change (the changes panel's 打开), however far the diff was scrolled.
  reveal?: string;
  openLine?: (line: number) => void;
}) {
  const parsed = useMemo(
    () =>
      !diff || 'error' in diff
        ? undefined
        : diff.kind === 'diff'
          ? diffRows(diff.text)
          : diff.kind === 'new'
            ? addedRows(diff.text)
            : undefined,
    [diff],
  );
  const rows = parsed?.rows ?? [];
  const hunks = parsed?.hunks ?? [];
  const chunks = Math.ceil(rows.length / chunkRows);
  const [shown, setShown] = useState(firstChunks);
  useEffect(() => {
    if (shown >= chunks) return;
    const frame = requestAnimationFrame(() => setShown((value) => value + 8));
    return () => cancelAnimationFrame(frame);
  }, [shown, chunks]);
  const body = useRef<HTMLDivElement>(null);
  // The hunk last gone to, by the buttons or keys; a scroll of the reader's own makes it the one at the top.
  const [current, setCurrent] = useState(-1);
  const scrolling = useRef(false);
  const atTop = () => {
    const element = body.current;
    if (!element) return -1;
    const top = element.getBoundingClientRect().top;
    let found = -1;
    for (let index = 0; index < hunks.length; index++) {
      const row = element.querySelector(`[data-hunk="${index}"]`);
      if (!row) break;
      if (row.getBoundingClientRect().top - top > 8) break;
      found = index;
    }
    return found;
  };
  const go = (index: number) => {
    const element = body.current;
    if (!element || index < 0 || index >= hunks.length) return;
    // A hunk not laid out yet is laid out first.
    if (Math.floor(hunks[index] / chunkRows) >= shown) flushSync(() => setShown(chunks));
    const row = element.querySelector<HTMLElement>(`[data-hunk="${index}"]`);
    if (!row) return;
    const before = element.scrollTop;
    element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    // The scroll this makes is not the reader's own (onScroll below); one that did not move makes none.
    scrolling.current = element.scrollTop !== before;
    setCurrent(index);
  };
  const step = (by: 1 | -1) => {
    const from = current >= 0 ? current : atTop();
    go(by > 0 ? from + 1 : Math.max(0, from - 1));
  };
  // The first change is shown when the diff is first read, and when the changes panel opens the file again.
  const revealed = useRef<string | undefined>(undefined);
  const loaded = !!parsed;
  useLayoutEffect(() => {
    if (!loaded || (revealed.current !== undefined && revealed.current === (reveal ?? ''))) return;
    revealed.current = reveal ?? '';
    if (hunks.length) go(0);
  }, [loaded, reveal]);
  const digits = String(
    rows.reduce((most, row) => Math.max(most, row.old ?? 0, row.new ?? 0), 0),
  ).length;
  const keys = (event: KeyboardEvent) => {
    // F7 and Shift+F7, as in VS Code's diff; Alt+↓ and Alt+↑ as well (Alt+← and Alt+→ go back and forward).
    const next =
      (event.key === 'F7' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey) ||
      (event.key === 'ArrowDown' &&
        event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey);
    const previous =
      (event.key === 'F7' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) ||
      (event.key === 'ArrowUp' &&
        event.altKey &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey);
    if (!next && !previous) return;
    event.preventDefault();
    step(next ? 1 : -1);
  };
  const message = !diff ? null : 'error' in diff ? (
    <p role="alert" className="preview-diff-message">
      {diff.error}
    </p>
  ) : diff.kind === 'binary' ? (
    <p className="preview-diff-message">二进制文件，无法显示差异</p>
  ) : diff.kind === 'other' ? (
    <p className="preview-diff-message">这不是普通文件，无法显示差异</p>
  ) : diff.kind === 'link' ? (
    <p className="preview-diff-message">符号链接，指向 {diff.target}</p>
  ) : !rows.length ? (
    <p className="preview-diff-message">没有内容上的差异（可能只改了权限）</p>
  ) : null;
  const truncated = !!diff && !('error' in diff) && 'truncated' in diff && diff.truncated;
  return (
    <div className="preview-diff" onKeyDown={keys}>
      <div className="preview-diff-bar">
        {change &&
          (change.binary ? (
            <span>二进制</span>
          ) : (
            (change.added ?? 0) + (change.deleted ?? 0) > 0 && (
              <span className="tool-diff">
                <ins>+{change.added}</ins>
                <del>−{change.deleted}</del>
              </span>
            )
          ))}
        {hunks.length > 0 && (
          <span className="preview-diff-position" aria-live="polite">
            {current >= 0 ? `第 ${current + 1} / ${hunks.length} 处改动` : `${hunks.length} 处改动`}
          </span>
        )}
        <span className="preview-diff-actions">
          <IconButton
            title="上一处改动"
            aria-keyshortcuts="Shift+F7 Alt+ArrowUp"
            size="sm"
            disabled={!hunks.length || current === 0}
            onClick={() => step(-1)}
          >
            <ArrowUp />
          </IconButton>
          <IconButton
            title="下一处改动"
            aria-keyshortcuts="F7 Alt+ArrowDown"
            size="sm"
            disabled={!hunks.length || current === hunks.length - 1}
            onClick={() => step(1)}
          >
            <ArrowDown />
          </IconButton>
          <Button size="sm" variant="ghost" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            自动换行
          </Button>
        </span>
      </div>
      {truncated && (
        <div className="preview-notice">
          <span>差异超过 {gitDiffLimit / 1024} KB，只显示了开头部分。</span>
        </div>
      )}
      <div
        ref={body}
        className={`preview-document preview-diff-body${wrap ? ' wraps' : ''}`}
        tabIndex={0}
        aria-label="改动内容"
        style={{ '--preview-diff-digits': Math.max(2, digits) } as CSSProperties}
        onScroll={() => {
          if (scrolling.current) scrolling.current = false;
          else if (current >= 0) setCurrent(-1);
        }}
        onClick={(event) => {
          const button = (event.target as HTMLElement).closest<HTMLElement>('button[data-line]');
          if (button && openLine) openLine(Number(button.dataset.line));
        }}
      >
        {!diff ? (
          <div className="preview-loading" role="status">
            <LoaderCircle className="spinning" />
            正在读取改动…
          </div>
        ) : (
          (message ??
          Array.from({ length: Math.min(shown, chunks) }, (_, chunk) => (
            <DiffChunk
              key={chunk}
              rows={rows}
              start={chunk * chunkRows}
              hunks={hunks}
              current={current}
              openLine={!!openLine}
            />
          )))
        )}
      </div>
    </div>
  );
}

function DiffChunk({
  rows,
  start,
  hunks,
  current,
  openLine,
}: {
  rows: DiffRow[];
  start: number;
  hunks: number[];
  current: number;
  openLine: boolean;
}) {
  const end = Math.min(rows.length, start + chunkRows);
  return (
    <pre
      className="tool-diff-view preview-diff-chunk"
      style={{ '--preview-diff-rows': end - start } as CSSProperties}
    >
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        const hunk = row.kind === '@' ? hunks.indexOf(index) : -1;
        return (
          <span
            key={index}
            className={
              row.kind === '+'
                ? 'added'
                : row.kind === '-'
                  ? 'removed'
                  : row.kind === '@'
                    ? 'hunk'
                    : row.kind === '\\'
                      ? 'note'
                      : undefined
            }
            data-hunk={hunk >= 0 ? hunk : undefined}
            aria-current={hunk >= 0 && hunk === current ? true : undefined}
          >
            <b className="preview-diff-number" data-side="old">
              {row.old ?? ''}
            </b>
            {row.new && openLine ? (
              <button
                type="button"
                tabIndex={-1}
                className="preview-diff-number"
                data-side="new"
                data-line={row.new}
                title={`在源码中查看第 ${row.new} 行`}
              >
                {row.new}
              </button>
            ) : (
              <b className="preview-diff-number" data-side="new">
                {row.new ?? ''}
              </b>
            )}
            <i aria-hidden="true">
              {row.kind === '-' ? '−' : row.kind === '+' ? '+' : row.kind === '@' ? '⋯' : ' '}
            </i>
            <span className="preview-diff-text">{row.text || ' '}</span>
          </span>
        );
      })}
    </pre>
  );
}
