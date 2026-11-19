import type { SessionEvent } from '@cc-desk-tunnel/protocol';
import type { CachedHistory } from './desktop.d.ts';

const encoder = new TextEncoder();
const softBytes = 1024 * 1024;
const hardBytes = 4 * 1024 * 1024;
const maxEvents = 2000;
// An event's size as a cached line, measured once: the window is worked out about once a second while a reply
// streams, and recorded events do not change.
const sizes = new WeakMap<SessionEvent, number>();
function lineBytes(event: SessionEvent) {
  let size = sizes.get(event);
  if (size === undefined) {
    size = encoder.encode(JSON.stringify(event) + '\n').byteLength;
    sizes.set(event, size);
  }
  return size;
}

// Keep complete runs at the tail. The newest run is useful even above the soft
// window budgets, but a single run above the IPC budget is not cached.
export function historyWindow(
  events: readonly SessionEvent[],
  hasEarlier: boolean,
): CachedHistory | null {
  let start = events.length,
    bytes = 0,
    count = 0;
  while (start > 0) {
    const newest = start === events.length;
    if (!newest && (bytes >= softBytes || count >= maxEvents)) break;
    let first = start - 1;
    const runId = events[first].runId;
    while (first > 0 && events[first - 1].runId === runId) first--;
    if (!newest && count + start - first > maxEvents) break;
    let runBytes = 0;
    const limit = newest ? hardBytes : softBytes - bytes;
    for (let i = first; i < start; i++) {
      runBytes += lineBytes(events[i]);
      if (runBytes > limit) {
        if (newest) return null;
        return {
          firstSequence: events[start].sequence,
          hasEarlier: true,
          events: events.slice(start),
        };
      }
    }
    bytes += runBytes;
    count += start - first;
    start = first;
  }
  return {
    firstSequence: events[start]?.sequence ?? 0,
    hasEarlier: hasEarlier || start > 0,
    events: events.slice(start),
  };
}
