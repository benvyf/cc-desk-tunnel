import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

export function useInputHistory(
  sessionId: string,
  entries: string[],
  draft: string,
  setDraft: (text: string, expectedText?: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
) {
  const cursor = useRef<{
    sessionId: string;
    entries: string[];
    index: number;
    original: string;
    selection: number;
    displayed: string;
  } | null>(null);
  const caret = useRef<number | null>(null);
  const reset = () => {
    cursor.current = null;
    caret.current = null;
  };
  useLayoutEffect(() => {
    // The setter belongs to this session. Leaving a temporary history preview
    // restores its original work only if no other view has edited the draft.
    return () => {
      const current = cursor.current;
      if (current?.sessionId === sessionId) {
        setDraft(current.original, current.displayed);
        reset();
      }
    };
  }, [sessionId]);
  useLayoutEffect(() => {
    if (
      cursor.current &&
      (cursor.current.sessionId !== sessionId || cursor.current.displayed !== draft)
    )
      reset();
    if (caret.current !== null) {
      input.current?.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [sessionId, draft, input]);

  return {
    reset,
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (
        !['ArrowUp', 'ArrowDown'].includes(event.key) ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      )
        return false;
      const box = event.currentTarget;
      const position = box.selectionStart;
      if (position !== box.selectionEnd) return false;
      const up = event.key === 'ArrowUp';
      if (
        up ? box.value.slice(0, position).includes('\n') : box.value.slice(position).includes('\n')
      )
        return false;
      if (cursor.current?.sessionId !== sessionId || cursor.current.displayed !== box.value)
        reset();
      if (!cursor.current) {
        if (!up || !entries.length) return false;
        cursor.current = {
          sessionId,
          entries: [...entries],
          index: entries.length,
          original: box.value,
          selection: position,
          displayed: box.value,
        };
      }
      const current = cursor.current;
      event.preventDefault();
      current.index = Math.max(0, Math.min(current.entries.length, current.index + (up ? -1 : 1)));
      const restoring = current.index === current.entries.length;
      const text = restoring ? current.original : current.entries[current.index];
      const nextCaret = restoring ? current.selection : text.length;
      current.displayed = text;
      if (box.value === text) box.setSelectionRange(nextCaret, nextCaret);
      else {
        caret.current = nextCaret;
        setDraft(text);
      }
      if (restoring) cursor.current = null;
      return true;
    },
  };
}
