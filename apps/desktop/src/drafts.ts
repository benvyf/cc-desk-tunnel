import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, SetAttachments } from './attachments.ts';

// Unsent text is the user's work: it is kept per session and written to disk shortly after every edit,
// so switching sessions, closing the window or a crash does not lose it.
export type Drafts = Record<string, string>;
export type SavedDrafts = Record<string, string | { text: string; attachments: Attachment[] }>;
type Entry = { text: string; attachments: Attachment[] };
type Entries = Record<string, Entry>;
const storageKey = 'proxy-drafts';
const delay = 300;

function clean(value: unknown): Entries {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Entries = {};
  for (const [id, item] of Object.entries(value)) {
    if (typeof item === 'string') entries[id] = { text: item, attachments: [] };
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
      entries[id] = { text: item.text, attachments };
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
      .filter(([, entry]) => entry.text || entry.attachments.length)
      .map(([id, entry]) => [id, entry.attachments.length ? entry : entry.text]),
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
              attachments: (fileUpdates.current.get(id) ?? []).reduce(
                (files, update) => update(files),
                saved[id]?.attachments ?? [],
              ),
            },
          ]),
        ),
      );
      fileUpdates.current.clear();
    });
    window.addEventListener('pagehide', flush);
    return () => {
      active = false;
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [change, flush]);
  const setDraft = useCallback(
    (sessionId: string, text: string) => {
      editedText.current.add(sessionId);
      change((current) => ({
        ...current,
        [sessionId]: { text, attachments: current[sessionId]?.attachments ?? [] },
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
        },
      }));
    },
    [change],
  );
  const drafts = useMemo(
    () => Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.text])),
    [entries],
  );
  const attachments = useMemo(
    () => Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.attachments])),
    [entries],
  );
  return [drafts, setDraft, attachments, setAttachments] as const;
}
