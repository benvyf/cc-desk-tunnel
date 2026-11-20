import { useSyncExternalStore } from 'react';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { getPrefs, onPrefs } from './prefs.ts';

// The opening words of each session's latest reply, for the activity view's second line. They are taken from the
// history this window already holds, when it changes, and kept on this computer for the sessions not open now:
// nothing is fetched for them. A session never opened here has none. They are kept on disk only where the
// conversations' own copies may be (the desktop window, with 在本机保存聊天记录 on), and go with them.

const storageKey = 'proxy-activity-previews';
const LIMIT = 300;
const LENGTH = 160;

const stored = () => !!window.desktop?.historyCache && getPrefs().localHistoryCache;
function load() {
  if (!stored()) return new Map<string, string>();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return new Map<string, string>(
      Array.isArray(saved)
        ? saved.filter(
            (item): item is [string, string] =>
              Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string',
          )
        : [],
    );
  } catch {
    return new Map<string, string>();
  }
}
let previews = load();
const listeners = new Set<() => void>();
let saving: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saving);
  saving = undefined;
  try {
    if (stored()) localStorage.setItem(storageKey, JSON.stringify([...previews].slice(-LIMIT)));
    else localStorage.removeItem(storageKey);
  } catch {
    /* A full storage loses the previews, not the window. */
  }
}
// Turning the local copies off takes the previews off the disk; this window keeps them while it is open.
onPrefs(() => {
  if (!stored() && localStorage.getItem(storageKey) !== null) localStorage.removeItem(storageKey);
});
// Forgets them all: the local copies were cleared, or the user signed out.
export function clearPreviews() {
  previews = new Map();
  clearTimeout(saving);
  saving = undefined;
  localStorage.removeItem(storageKey);
  for (const listener of listeners) listener();
}
function changed() {
  for (const listener of listeners) listener();
  if (saving === undefined) saving = setTimeout(save, 1000);
}

// Markdown's marks and the spaces between lines say nothing on one short line.
const plain = (text: string) =>
  text
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// How far back from the end a reply is looked for: a session of tool calls only is not read through each time.
const LOOKBACK = 500;
// The latest reply's text: the last stretch of Claude's own words (not a sub-agent's), from its first piece.
export function latestReply(events: readonly SessionEvent[]) {
  let messageId: string | undefined;
  let text = '';
  for (let index = events.length - 1; index >= Math.max(0, events.length - LOOKBACK); index--) {
    const payload = events[index].payload;
    if (payload.type !== 'text.delta' || payload.parentToolId) {
      if (messageId) break;
      continue;
    }
    if (messageId && payload.messageId !== messageId) break;
    messageId = payload.messageId;
    text = payload.text + text;
  }
  const words = plain(text);
  return words ? words.slice(0, LENGTH) : undefined;
}

// Follows the client's history for as long as the window is open: called once, by App.
export function trackPreviews(client: ProxyClient) {
  const seen = new Map<string, readonly SessionEvent[]>();
  let status = client.state.status;
  const inspect = () => {
    // Signed out (not a connection lost on the way): what the account's sessions said is not left behind.
    if (client.state.status !== status) {
      if (client.state.status === 'disconnected' && status === 'connected') clearPreviews();
      status = client.state.status;
    }
    let moved = false;
    for (const [id, events] of Object.entries(client.state.events)) {
      if (seen.get(id) === events) continue;
      seen.set(id, events);
      const text = latestReply(events);
      if (!text || previews.get(id) === text) continue;
      // Newest last, so that the oldest are the ones dropped past the limit.
      previews.delete(id);
      previews.set(id, text);
      moved = true;
    }
    for (const id of seen.keys()) if (!(id in client.state.events)) seen.delete(id);
    if (moved) changed();
  };
  inspect();
  const stop = client.subscribe(inspect);
  window.addEventListener('pagehide', save);
  return () => {
    stop();
    window.removeEventListener('pagehide', save);
  };
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const usePreview = (id: string) => useSyncExternalStore(subscribe, () => previews.get(id));
