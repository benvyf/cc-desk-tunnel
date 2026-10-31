import type { PreviewBoard } from './previewLayout.ts';
import { cleanReading, readPreviewReading, serializePreviewState } from './previewViewState.ts';
import type { PreviewReading } from './previewViewState.ts';

type Layout = { width: number; boards: Record<string, PreviewBoard> };

// One owner per connection/workspace/surface. Scroll writes stay outside React state.
export function createPreviewPersistence(
  key: string | null,
  initial: Layout,
  serialized: string | null,
  storage: Pick<Storage, 'setItem'>,
) {
  let layout = initial;
  const reading = readPreviewReading(serialized, initial.boards);
  let closed = false;
  let dirtySince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const captures = new Set<() => void>();
  const owns = (session: string, tab: string) =>
    !['__proto__', 'constructor', 'prototype'].includes(session) &&
    !['__proto__', 'constructor', 'prototype'].includes(tab) &&
    Object.hasOwn(layout.boards, session) &&
    layout.boards[session].tabs.some((value) => value.id === tab && value.kind === 'file');
  const flush = () => {
    if (closed) return;
    // Sample before serializing: window-target exit events don't guarantee capture-first ordering.
    for (const capture of captures) capture();
    clearTimeout(timer);
    timer = undefined;
    if (dirtySince === undefined) return;
    dirtySince = undefined;
    if (key)
      try {
        storage.setItem(key, serializePreviewState(layout, reading));
      } catch {
        // A full/unavailable profile must not interrupt reading the current document.
      }
  };
  const schedule = () => {
    dirtySince ??= Date.now();
    clearTimeout(timer);
    timer = setTimeout(flush, Math.min(500, Math.max(0, 2000 - (Date.now() - dirtySince))));
  };
  return {
    key,
    reading,
    beforeFlush(capture: () => void) {
      if (!closed) captures.add(capture);
      return () => {
        captures.delete(capture);
      };
    },
    get closed() {
      return closed;
    },
    get layout() {
      return layout;
    },
    get(session: string, tab: string) {
      return owns(session, tab) &&
        Object.hasOwn(reading, session) &&
        Object.hasOwn(reading[session], tab)
        ? reading[session][tab]
        : undefined;
    },
    set(session: string, tab: string, value: PreviewReading | undefined) {
      if (closed || !owns(session, tab)) return;
      const next = cleanReading(value);
      const tabs = Object.hasOwn(reading, session) ? reading[session] : undefined;
      const previous = tabs && Object.hasOwn(tabs, tab) ? tabs[tab] : undefined;
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      if (next) {
        if (!tabs) reading[session] = Object.create(null);
        reading[session][tab] = next;
      } else if (tabs) {
        delete reading[session][tab];
        if (!Object.keys(reading[session]).length) delete reading[session];
      }
      schedule();
    },
    updateLayout(next: Layout) {
      if (closed || (layout.width === next.width && layout.boards === next.boards)) return;
      layout = next;
      for (const [session, tabs] of Object.entries(reading)) {
        for (const tab of Object.keys(tabs)) if (!owns(session, tab)) delete tabs[tab];
        if (!Object.keys(tabs).length) delete reading[session];
      }
      schedule();
    },
    flush,
    close() {
      flush();
      closed = true;
      captures.clear();
    },
  };
}

export type PreviewPersistence = ReturnType<typeof createPreviewPersistence>;
