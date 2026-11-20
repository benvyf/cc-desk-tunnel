import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isWindowsPath } from '@cc-desk-tunnel/protocol';

// How many matches the list shows; the rest are counted, and found by typing more.
const shownLimit = 100;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
type Indexed = { path: string; lower: string; name: string };
// Whether the letters of `query` come in this order in `text`, not necessarily together.
function subsequence(text: string, query: string) {
  let at = 0;
  for (const letter of query) {
    at = text.indexOf(letter, at) + 1;
    if (!at) return false;
  }
  return true;
}
// The files that match, best first: the name beginning with what is typed, then the name holding it, then the
// path holding it, then the name and at last the path holding its letters in order. Case is not minded; among
// equals the shorter path comes first.
export function rankFiles(files: Indexed[], typed: string) {
  const query = typed.trim().toLowerCase().replaceAll('\\', '/');
  if (!query)
    return { shown: files.slice(0, shownLimit).map((file) => file.path), count: files.length };
  const tiers: Indexed[][] = [[], [], [], [], []];
  for (const file of files) {
    const tier = file.name.startsWith(query)
      ? 0
      : file.name.includes(query)
        ? 1
        : file.lower.includes(query)
          ? 2
          : subsequence(file.name, query)
            ? 3
            : subsequence(file.lower, query)
              ? 4
              : -1;
    if (tier >= 0) tiers[tier].push(file);
  }
  const shown: string[] = [];
  for (const tier of tiers) {
    if (shown.length >= shownLimit) break;
    tier.sort((a, b) => a.path.length - b.path.length || collator.compare(a.path, b.path));
    for (const file of tier.slice(0, shownLimit - shown.length)) shown.push(file.path);
  }
  return { shown, count: tiers.reduce((sum, tier) => sum + tier.length, 0) };
}

// Ctrl+P's box (VS Code's quick open): a file of the workspace found by its name and opened in the preview. The
// desktop lists the workspace once for each opening of the box (preview-workspace.cjs index), within its bounds.
// Enter opens the file in the temporary tab, as a click in the tree does; Ctrl+Enter or Alt+Enter keeps it.
export default function PreviewQuickOpen({
  root,
  open,
  close,
  toggle,
}: {
  root: string;
  open: (path: string, temporary: boolean) => void;
  close: () => void;
  // The box's own shortcut, which shuts it (the window's shortcuts are off while a dialog is open).
  toggle?: (event: React.KeyboardEvent) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState<{ files: Indexed[]; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  // While an input method composes, the list stays as it was and its keys are its own.
  const [frozen, setFrozen] = useState<string | null>(null);
  const composedAt = useRef(0);
  const [active, setActive] = useState(0);
  const pressed = useRef<EventTarget | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    // Focus goes back where it was when the box shuts, however it shuts.
    const before = element.ownerDocument.activeElement as HTMLElement | null;
    element.showModal();
    input.current?.focus();
    return () => {
      element.close();
      if (before?.isConnected) before.focus();
    };
  }, []);
  useEffect(() => {
    let current = true;
    void window.desktop!.preview.index({ root }).then(
      (value) => {
        if (current)
          setIndex({
            truncated: value.truncated,
            files: value.files.map((path) => ({
              path,
              lower: path.toLowerCase(),
              name: path.slice(path.lastIndexOf('/') + 1).toLowerCase(),
            })),
          });
      },
      (e) => {
        if (current) setError(e instanceof Error ? e.message : '无法列出工作区文件。');
      },
    );
    return () => {
      current = false;
    };
  }, [root]);
  const { shown, count } = useMemo(
    () => (index ? rankFiles(index.files, frozen ?? query) : { shown: [], count: 0 }),
    [index, query, frozen],
  );
  useEffect(() => {
    if (frozen === null) setActive(0);
  }, [query, frozen]);
  const currentIndex = Math.min(active, shown.length - 1);
  const current = shown[currentIndex];
  const optionId = (at: number) => `${id}-option-${at}`;
  useEffect(() => {
    if (current !== undefined)
      dialog.current?.ownerDocument
        .getElementById(optionId(currentIndex))
        ?.scrollIntoView({ block: 'nearest' });
  }, [current, currentIndex]);
  const separator = isWindowsPath(root) ? '\\' : '/';
  const pick = (relative: string | undefined, temporary: boolean) => {
    if (relative === undefined) return;
    close();
    open(root.replace(/[\\/]+$/, '') + separator + relative.split('/').join(separator), temporary);
  };
  const move = (step: number) => {
    if (!shown.length) return;
    setActive((value) => (Math.min(value, shown.length - 1) + step + shown.length) % shown.length);
  };
  const notice = error
    ? error
    : !index
      ? '正在索引文件…'
      : !shown.length
        ? '没有匹配的文件'
        : count > shown.length
          ? `${count} 个匹配，显示前 ${shown.length} 个`
          : '';
  return (
    <dialog
      ref={dialog}
      className="palette preview-quick-open"
      aria-label="按名称打开文件"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      // Shut by a click on the shade alone: one that began in the box (selecting its text) and ended there is not.
      onMouseDown={(event) => {
        pressed.current = event.target;
      }}
      onClick={(event) => {
        if (event.target === dialog.current && pressed.current === dialog.current) close();
      }}
    >
      <input
        ref={input}
        className="palette-input"
        role="combobox"
        aria-label="文件名或路径"
        aria-expanded={shown.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-activedescendant={current !== undefined ? optionId(currentIndex) : undefined}
        placeholder="输入文件名；Enter 打开，Ctrl+Enter 打开并固定"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onCompositionStart={() => setFrozen(query)}
        onCompositionEnd={() => {
          setFrozen(null);
          composedAt.current = performance.now();
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            performance.now() - composedAt.current < 10
          )
            return;
          if (toggle?.(event)) {
            event.preventDefault();
            close();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey) {
            event.preventDefault();
            pick(current, !(event.ctrlKey || event.altKey));
            return;
          }
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const keys: Record<string, () => void> = {
            ArrowDown: () => move(1),
            ArrowUp: () => move(-1),
            Home: () => setActive(0),
            End: () => setActive(Math.max(0, shown.length - 1)),
          };
          const act = keys[event.key];
          if (!act || (['Home', 'End'].includes(event.key) && query)) return;
          event.preventDefault();
          act();
        }}
      />
      {index?.truncated && (
        <p className="preview-quick-notice" role="status">
          只索引了部分文件
        </p>
      )}
      <p className="preview-quick-notice" role="status" hidden={!notice}>
        {notice}
      </p>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="文件"
        className="palette-list"
        // The box keeps the focus, whatever in the list is pressed.
        onMouseDown={(event) => event.preventDefault()}
      >
        {shown.map((relative, at) => {
          const cut = relative.lastIndexOf('/');
          return (
            <div
              key={relative}
              id={optionId(at)}
              role="option"
              aria-selected={at === currentIndex}
              title={relative}
              className="palette-option"
              onMouseMove={() => setActive(at)}
              onClick={(event) => pick(relative, !(event.ctrlKey || event.altKey))}
            >
              <span className="palette-label">{relative.slice(cut + 1)}</span>
              {cut > 0 && <small className="palette-detail">{relative.slice(0, cut)}</small>}
            </div>
          );
        })}
      </div>
    </dialog>
  );
}
