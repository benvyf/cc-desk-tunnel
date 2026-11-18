import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { groupNames, rank } from './palette.ts';
import type { PaletteItem } from './palette.ts';

// One box to find and go to a session, a project, a setting, an action or a slash command, by keyboard alone.
// The input is a combobox that owns a listbox of grouped options; focus stays in it and the chosen option is
// told by aria-activedescendant. Nothing is asked of the service: the entries are what the window holds.
export default function CommandPalette({
  items,
  recent,
  close,
  choose,
  toggleCombo,
}: {
  items: PaletteItem[];
  recent: string[];
  close: () => void;
  // Called as the palette shuts (after `close`), so that an entry that moves focus moves it once the palette has
  // let it go.
  choose: (item: PaletteItem) => void;
  // The palette's own shortcut, which shuts it (the window's shortcuts are off while a dialog is open).
  toggleCombo: (event: React.KeyboardEvent) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  // While an input method composes, the list stays as it was and its keys are its own.
  const [frozen, setFrozen] = useState<string | null>(null);
  const composedAt = useRef(0);
  const [active, setActive] = useState(0);
  const id = useId();
  const sections = useMemo(
    () => rank(items, frozen ?? query, recent),
    [items, query, frozen, recent],
  );
  const flat = sections.flatMap((section) => section.items);
  const currentIndex = Math.min(active, flat.length - 1);
  const current = flat[currentIndex];
  // Options are named by their place, not their entry's id, which may hold a path's spaces and slashes.
  const optionId = (at: number) => `${id}-option-${at}`;
  const pressed = useRef<EventTarget | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    if (frozen === null) setActive(0);
  }, [query, frozen]);
  const currentKey = current?.id;
  useEffect(() => {
    if (currentKey === undefined) return;
    document.getElementById(optionId(currentIndex))?.scrollIntoView({ block: 'nearest' });
  }, [currentKey, currentIndex]);
  const pick = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    close();
    choose(item);
  };
  const move = (step: number) => {
    if (!flat.length) return;
    setActive((value) => (Math.min(value, flat.length - 1) + step + flat.length) % flat.length);
  };
  // To the first option of the next or previous group.
  const jump = (step: number) => {
    const starts: number[] = [];
    let at = 0;
    for (const section of sections) {
      starts.push(at);
      at += section.items.length;
    }
    let here = 0;
    starts.forEach((start, at) => {
      if (start <= active) here = at;
    });
    const next = starts[Math.max(0, Math.min(starts.length - 1, here + step))];
    if (next !== undefined) setActive(next);
  };
  let index = -1;
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="命令面板"
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
        aria-label="搜索会话、项目、设置、操作或斜杠命令"
        aria-expanded={flat.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={current ? optionId(currentIndex) : undefined}
        placeholder="搜索会话、项目、设置、操作；输入 / 查找斜杠命令"
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
          if (toggleCombo(event)) {
            event.preventDefault();
            close();
            return;
          }
          const keys: Record<string, () => void> = {
            ArrowDown: () => move(1),
            ArrowUp: () => move(-1),
            PageDown: () => jump(1),
            PageUp: () => jump(-1),
            Enter: () => pick(current),
          };
          const act = keys[event.key];
          if (!act || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault();
          act();
        }}
      />
      <div role="status" className="palette-status">
        {flat.length ? `${flat.length} 项结果` : '没有匹配的结果'}
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="结果"
        className="palette-list"
        // The box keeps the focus, whatever in the list is pressed.
        onMouseDown={(event) => event.preventDefault()}
      >
        {sections.map((section) => (
          <div
            key={section.group}
            role="group"
            aria-labelledby={`${id}-group-${section.group}`}
            className="palette-group"
          >
            <div id={`${id}-group-${section.group}`} className="palette-group-name">
              {groupNames[section.group]}
            </div>
            {section.items.map((item) => {
              index++;
              const at = index;
              return (
                <div
                  key={`${item.id}:${at}`}
                  id={optionId(at)}
                  role="option"
                  aria-selected={at === currentIndex}
                  aria-disabled={item.disabled ? true : undefined}
                  className="palette-option"
                  onMouseMove={() => setActive(at)}
                  onClick={() => pick(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {(item.disabled || item.detail) && (
                    <small className="palette-detail">{item.disabled ?? item.detail}</small>
                  )}
                  {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </dialog>
  );
}
