import { createHash } from 'node:crypto';
import { accountNumberFromId } from '../../../packages/protocol/src/account-number.ts';
import type { EventPayload, ServerMessage } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload as DisplayEventPayload,
  ServerMessage as DisplayServerMessage,
} from '../../../packages/protocol/src/account-display.ts';

function publicIdentity<T extends { email?: string; organization?: string }>(account: T) {
  const { email, organization: _organization, ...visible } = account;
  return {
    ...visible,
    ...(email?.trim()
      ? {
          accountNumber: accountNumberFromId(
            createHash('sha256').update(email.trim().toLowerCase()).digest('hex'),
          ),
        }
      : {}),
  };
}

function publicPayload(payload: EventPayload): DisplayEventPayload {
  return payload.type === 'native.capabilities'
    ? { ...payload, account: publicIdentity(payload.account) }
    : payload;
}

// Project identity only at the transport boundary: local events and monitor reports retain the
// original identity. Cover old history as well as live events without rewriting session databases.
export function accountMessageForClient(message: ServerMessage): DisplayServerMessage {
  switch (message.type) {
    case 'account.state':
      return { ...publicIdentity(message), login: null, notice: undefined };
    case 'session.event':
      return {
        ...message,
        event: { ...message.event, payload: publicPayload(message.event.payload) },
      };
    case 'session.fragment':
      return { ...message, payload: publicPayload(message.payload) };
    case 'session.snapshot':
      return {
        ...message,
        events: message.events.map((event) => ({
          ...event,
          payload: publicPayload(event.payload),
        })),
      };
    default:
      return message;
  }
}
