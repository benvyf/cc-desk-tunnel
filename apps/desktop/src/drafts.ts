import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, SetAttachments } from './attachments.ts';
import { cleanQuotes } from './quotes.ts';
import type { QuoteReference, SetQuotes } from './quotes.ts';

// Unsent text is the user's work: it is kept per session and written to disk shortly after every edit,
// so switching sessions, closing the window or a crash does not lose it.
export type Drafts = Record<string, string>;
export type SavedDrafts = Record<
  string,
  string | { text: string; attachments: Attachment[]; quotes?: QuoteReference[] }
>;
type Entry = { text: string; attachments: Attachment[]; quotes: QuoteReference[] };
type Entries = Record<string, Entry>;
const storageKey = 'proxy-drafts';
const delay = 300;

function clean(value: unknown): Entries {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Entries = {};
  for (const [id, item] of Object.entries(value)) {
    if (typeof item === 'string') entries[id] = { text: item, attachments: [], quotes: [] };
    else if (item && typeof item === 'object' && typeof item.text === 'string') {
      const attachments: Attachment[] = [];
      for (const file of Array.isArray(item.attachments) ? item.attachments : []) {
        if (!file || typeof file.id !== 'string' || typeof file.name !== 'string') continue;
        const path = typeof file.path === 'string' && file.path ? file.path : undefined;
        attachments.push({
          id: file.id,
          name: file.name,
          path,
          status: path ? 'ready' : 'error',
          ...(path ? {} : { error: '处理已中断，请移除后重新添加' }),
        });
      }
      entries[id] = {
        text: item.text,
        attachments,
        quotes: cleanQuotes('quotes' in item ? item.quotes : []),
      };
    }
  }
  return entries;
}
async function load(): Promise<Entries> {
  try {
    if (window.desktop) return clean(await window.desktop.loadDrafts());
    return clean(JSON.parse(localStorage.getItem(storageKey) ?? '{}'));
  } catch {
    return {};
  }
}
function store(entries: Entries) {
  const drafts: SavedDrafts = Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => entry.text || entry.attachments.length || entry.quotes.length)
      .map(([id, entry]) => [
        id,
        entry.quotes.length
          ? entry
          : entry.attachments.length
            ? { text: entry.text, attachments: entry.attachments }
            : entry.text,
      ]),
  );
  try {
    if (window.desktop) void window.desktop.saveDrafts(drafts).catch(() => {});
    else localStorage.setItem(storageKey, JSON.stringify(drafts));
  } catch {
    /* A full or unavailable browser store must not interrupt editing. */
  }
}

export function useDrafts() {
  const [entries, setEntries] = useState<Entries>({});
  const latest = useRef(entries);
  const loaded = useRef(false);
  const editedText = useRef(new Set<string>());
  const fileUpdates = useRef(new Map<string, ((files: Attachment[]) => Attachment[])[]>());
  const quoteUpdates = useRef(
    new Map<string, ((quotes: QuoteReference[]) => QuoteReference[])[]>(),
  );
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    if (pending.current === undefined) return;
    clearTimeout(pending.current);
    pending.current = undefined;
    store(latest.current);
  }, []);
  const change = useCallback(
    (update: (entries: Entries) => Entries) => {
      latest.current = update(latest.current);
      setEntries(latest.current);
      // Nothing is written before the saved drafts are read, or they would be replaced by a partial set.
      if (!loaded.current) return;
      clearTimeout(pending.current);
      pending.current = setTimeout(flush, delay);
    },
    [flush],
  );
  useEffect(() => {
    let active = true;
    void load().then((saved) => {
      if (!active) return;
      loaded.current = true;
      // Loading text and attachments is independent: typing early must not erase saved attachments,
      // nor should adding a picture before disk loading completes erase the saved message.
      change((current) =>
        Object.fromEntries(
          [...new Set([...Object.keys(saved), ...Object.keys(current)])].map((id) => [
            id,
            {
              text: editedText.current.has(id)
                ? (current[id]?.text ?? '')
                : (saved[id]?.text ?? ''),
              quotes: (quoteUpdates.current.get(id) ?? []).reduce(
                (quotes, update) => update(quotes),
                saved[id]?.quotes ?? [],
              ),
              attachments: (fileUpdates.current.get(id) ?? []).reduce(
                (files, update) => update(files),
                saved[id]?.attachments ?? [],
              ),
            },
          ]),
        ),
      );
      fileUpdates.current.clear();
      quoteUpdates.current.clear();
    });
    window.addEventListener('pagehide', flush);
    return () => {
      active = false;
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [change, flush]);
  const setDraft = useCallback(
    (sessionId: string, text: string, expectedText?: string) => {
      // A send can finish after this draft was edited in another view of the same chat.
      if (expectedText !== undefined && (latest.current[sessionId]?.text ?? '') !== expectedText)
        return;
      editedText.current.add(sessionId);
      change((current) => ({
        ...current,
        [sessionId]: {
          text,
          attachments: current[sessionId]?.attachments ?? [],
          quotes: current[sessionId]?.quotes ?? [],
        },
      }));
    },
    [change],
  );
  const setAttachments: SetAttachments = useCallback(
    (sessionId, update) => {
      if (!loaded.current)
        fileUpdates.current.set(sessionId, [...(fileUpdates.current.get(sessionId) ?? []), update]);
      change((current) => ({
        ...current,
        [sessionId]: {
          text: current[sessionId]?.text ?? '',
          attachments: update(current[sessionId]?.attachments ?? []),
          quotes: current[sessionId]?.quotes ?? [],
        },
      }));
    },
    [change],
  );
  const setQuotes: SetQuotes = useCallback(
    (sessionId, update) => {
      if (!loaded.current)
        quoteUpdates.current.set(sessionId, [
          ...(quoteUpdates.current.get(sessionId) ?? []),
          update,
        ]);
      change((current) => ({
        ...current,
        [sessionId]: {
          text: current[sessionId]?.text ?? '',
          attachments: current[sessionId]?.attachments ?? [],
          quotes: cleanQuotes(update(current[sessionId]?.quotes ?? [])),
        },
      }));
    },
    [change],
  );
  const quotes = useMemo(
    () => Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.quotes])),
    [entries],
  );
  const drafts = useMemo(
    () => Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.text])),
    [entries],
  );
  const attachments = useMemo(
    () => Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.attachments])),
    [entries],
  );
  return [drafts, setDraft, attachments, setAttachments, quotes, setQuotes] as const;
}
