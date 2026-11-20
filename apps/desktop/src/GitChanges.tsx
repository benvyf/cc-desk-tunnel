import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw } from './icons.tsx';
import { IconButton } from './ui.tsx';
import { diffLines, gitError, gitFilePath, refName, statusNames } from './gitChanges.ts';
import type { GitChange, GitChangeList, GitFileDiff } from './gitChanges.ts';
import { gitBaseKey, useGitBase } from './useGitFile.ts';

// The changes of the project's working tree: against HEAD, or since it left a branch. Read only — nothing is
// staged, committed or discarded here. A file's diff is read when it is opened, and once.
export default function GitChanges({
  root,
  targetId,
  busy = false,
  openFile,
}: {
  root: string;
  // The SSH device the project is on; none for one on this computer.
  targetId?: string;
  // A run at work: once it ends, its changes are read again.
  busy?: boolean;
  // Opens a file of the project in the preview, as its changes; absent where files cannot be previewed.
  openFile?: (path: string) => void;
}) {
  // Shared with the preview's 改动 view of the project's files, which compares with the same base.
  const [base, setBase] = useGitBase(gitBaseKey(root, targetId));
  const [list, setList] = useState<GitChangeList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff | { error: string } | 'loading'>>(
    {},
  );
  const asked = useRef(0);
  const inFlight = useRef(false);
  const loadedAt = useRef(0);
  const load = useCallback(async () => {
    const turn = ++asked.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const result = await window.desktop!.git!.changes({
        root,
        ...(targetId ? { targetId } : {}),
        ...(base ? { base } : {}),
      });
      if (turn !== asked.current) return;
      setList(result);
      setError('');
      // What was read of the files before is of the tree as it was: they close, to be read again when opened.
      setDiffs({});
      setOpen(new Set());
    } catch (e) {
      if (turn !== asked.current) return;
      setList(null);
      setError(gitError(e, '读取 Git 改动失败。'));
    } finally {
      if (turn === asked.current) {
        setLoading(false);
        inFlight.current = false;
        loadedAt.current = Date.now();
      }
    }
  }, [root, targetId, base]);
  useEffect(() => {
    setOpen(new Set());
    void load();
  }, [load]);
  // Back in the window, or a run over: the tree may have changed.
  useEffect(() => {
    // Not while a read is under way, nor again within a few seconds of the last.
    const again = () => {
      if (!inFlight.current && Date.now() - loadedAt.current > 3000) void load();
    };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [load]);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void load();
    wasBusy.current = busy;
  }, [busy, load]);
  const toggle = (file: GitChange) => {
    const next = new Set(open);
    if (next.has(file.path)) next.delete(file.path);
    else {
      next.add(file.path);
      if (!diffs[file.path] && list) {
        setDiffs((value) => ({ ...value, [file.path]: 'loading' }));
        const against = list.against;
        // A diff asked before the list was read again is of the tree as it was: it is dropped.
        const turn = asked.current;
        const keep = (diff: GitFileDiff | { error: string }) => {
          if (turn === asked.current) setDiffs((value) => ({ ...value, [file.path]: diff }));
        };
        window
          .desktop!.git!.fileDiff({
            root,
            ...(targetId ? { targetId } : {}),
            against,
            path: file.path,
          })
          .then(keep, (e: unknown) => keep({ error: gitError(e, '读取差异失败。') }));
      }
    }
    setOpen(next);
  };
  // A file's full path as this computer writes it.
  const where = (path: string) => gitFilePath(list?.top ?? root, path);
  return (
    <section className="git-changes" aria-label="Git 改动">
      <header className="git-changes-head">
        <label>
          <span>对比</span>
          <select
            aria-label="对比基准"
            value={base}
            onChange={(event) => setBase(event.target.value)}
          >
            <option value="">HEAD（未提交的改动）</option>
            {!!list?.refs.local.length && (
              <optgroup label="本地分支">
                {list.refs.local.map((ref) => (
                  <option key={ref} value={ref}>
                    {refName(ref)}
                  </option>
                ))}
              </optgroup>
            )}
            {!!list?.refs.remote.length && (
              <optgroup label="远程跟踪分支（本地已有，不会获取）">
                {list.refs.remote.map((ref) => (
                  <option key={ref} value={ref}>
                    {refName(ref)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <IconButton title="刷新改动" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? 'spinning' : undefined} />
        </IconButton>
      </header>
      {error && (
        <p role="alert" className="git-changes-error">
          {error}
        </p>
      )}
      {list && (
        <>
          <p className="git-changes-summary">
            {list.branch && <span>当前分支 {list.branch}</span>}
            <span>{list.summary.files ? `${list.summary.files} 个文件` : '没有改动'}</span>
            {(list.summary.added > 0 || list.summary.deleted > 0) && (
              <span className="tool-diff">
                <ins>+{list.summary.added}</ins>
                <del>−{list.summary.deleted}</del>
              </span>
            )}
            {list.summary.untracked > 0 && <span>{list.summary.untracked} 项未跟踪</span>}
          </p>
          {list.truncated && (
            <p className="git-changes-note">改动太多，只列出前 {list.files.length} 个文件。</p>
          )}
          {list.filtered.length > 0 && (
            <p className="git-changes-note">
              为安全起见没有运行 Git 配置的过滤器（{list.filtered.join('、')}
              ），相关文件可能显示为已修改。
            </p>
          )}
          <ul className="git-changes-list">
            {list.files.map((file) => {
              const shown = open.has(file.path);
              const diff = diffs[file.path];
              const name = file.path.replace(/\/$/, '').split('/').pop();
              const folder = file.path
                .slice(0, file.path.length - (name?.length ?? 0))
                .replace(/\/$/, '');
              return (
                <li key={file.path} className="git-change">
                  <div className="git-change-row">
                    <button
                      type="button"
                      className="git-change-toggle"
                      aria-expanded={shown}
                      onClick={() => toggle(file)}
                      // ↑↓ go from file to file, → opens one's diff and ← shuts it, as in a tree.
                      onKeyDown={(event) => {
                        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
                          return;
                        const rows = [
                          ...(event.currentTarget
                            .closest('.git-changes-list')
                            ?.querySelectorAll<HTMLButtonElement>('.git-change-toggle') ?? []),
                        ];
                        const at = rows.indexOf(event.currentTarget);
                        const go = (index: number) => {
                          event.preventDefault();
                          rows[Math.max(0, Math.min(rows.length - 1, index))]?.focus();
                        };
                        if (event.key === 'ArrowDown') go(at + 1);
                        else if (event.key === 'ArrowUp') go(at - 1);
                        else if (event.key === 'Home') go(0);
                        else if (event.key === 'End') go(rows.length - 1);
                        else if (event.key === 'ArrowRight' && !shown) {
                          event.preventDefault();
                          toggle(file);
                        } else if (event.key === 'ArrowLeft' && shown) {
                          event.preventDefault();
                          toggle(file);
                        }
                      }}
                    >
                      <ChevronRight className="fold-chevron" />
                      <b
                        className={`git-status git-status-${file.status}`}
                        title={statusNames[file.status]}
                        aria-hidden="true"
                      >
                        {file.status}
                      </b>
                      <span className="sr-only">{statusNames[file.status]}</span>
                      <span className="git-change-name" title={file.path}>
                        {name}
                        {folder && <small>{folder}</small>}
                        {file.oldPath && <small>← {file.oldPath}</small>}
                      </span>
                      {file.conflict && <span className="git-change-conflict">冲突</span>}
                      {file.binary ? (
                        <small>二进制</small>
                      ) : (
                        (file.added ?? 0) + (file.deleted ?? 0) > 0 && (
                          <span className="tool-diff">
                            <ins>+{file.added}</ins>
                            <del>−{file.deleted}</del>
                          </span>
                        )
                      )}
                    </button>
                    {/* A deleted file opens too: its tab shows only its changes. */}
                    {openFile && !file.path.endsWith('/') && (
                      <button
                        type="button"
                        className="button secondary git-change-open"
                        onClick={() => openFile(where(file.path))}
                      >
                        打开
                      </button>
                    )}
                  </div>
                  {shown && <FileDiff diff={diff} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function FileDiff({ diff }: { diff: GitFileDiff | { error: string } | 'loading' | undefined }) {
  if (!diff || diff === 'loading') return <p className="git-diff-note">正在读取差异…</p>;
  if ('error' in diff)
    return (
      <p role="alert" className="git-diff-note">
        {diff.error}
      </p>
    );
  if (diff.kind === 'binary') return <p className="git-diff-note">二进制文件，不显示差异。</p>;
  if (diff.kind === 'other') return <p className="git-diff-note">未跟踪的目录，展开看不到差异。</p>;
  if (diff.kind === 'link') return <p className="git-diff-note">符号链接，指向 {diff.target}</p>;
  const lines =
    diff.kind === 'new'
      ? diff.text
          .replace(/\n$/, '')
          .split('\n')
          .map((text) => ({ kind: '+' as const, text }))
      : diffLines(diff.text);
  return (
    <>
      {lines.length ? (
        <pre className="tool-diff-view git-diff">
          {lines.map((line, index) => (
            <span
              key={index}
              className={
                line.kind === '+'
                  ? 'added'
                  : line.kind === '-'
                    ? 'removed'
                    : line.kind === '@'
                      ? 'hunk'
                      : undefined
              }
            >
              <i aria-hidden="true">
                {line.kind === '-' ? '−' : line.kind === '+' ? '+' : line.kind === '@' ? '⋯' : ' '}
              </i>
              {line.text || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <p className="git-diff-note">没有内容上的差异（可能只改了权限）。</p>
      )}
      {diff.truncated && <p className="git-diff-note">差异太长，只显示了开头部分。</p>}
    </>
  );
}
