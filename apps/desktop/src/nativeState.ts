import type { EventPayload, SessionEvent } from '@cc-desk-tunnel/protocol';
export function latest<T extends EventPayload['type']>(events: SessionEvent[], type: T) {
  return (events.findLast((event) => event.payload.type === type)?.payload ?? null) as Extract<
    EventPayload,
    { type: T }
  > | null;
}
