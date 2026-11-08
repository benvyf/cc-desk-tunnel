import { z } from 'zod';
import {
  eventPayloadSchema,
  eventSchema,
  nativeAccountSchema,
  serverMessageSchema as baseServerMessageSchema,
} from './index.ts';
import type {
  AccountState as BaseAccountState,
  EventPayload as BaseEventPayload,
  NativeCapabilities as BaseNativeCapabilities,
  ServerMessage as BaseServerMessage,
  SessionEvent as BaseSessionEvent,
} from './index.ts';

export { accountNumberFromId } from './account-number.ts';

// Presentation metadata travels separately from the pinned persisted protocol schemas.
// Internal events and the private monitor keep their original account identity.
export type AccountState = BaseAccountState & { accountNumber?: string };
export type NativeCapabilities = BaseNativeCapabilities & {
  account: { accountNumber?: string };
};
export type EventPayload = Exclude<BaseEventPayload, BaseNativeCapabilities> | NativeCapabilities;
type SessionEvent = Omit<BaseSessionEvent, 'payload'> & { payload: EventPayload };
type Frame<T extends BaseServerMessage['type']> = Extract<BaseServerMessage, { type: T }>;
export type ServerMessage =
  | Exclude<
      BaseServerMessage,
      { type: 'account.state' | 'session.event' | 'session.fragment' | 'session.snapshot' }
    >
  | (Frame<'account.state'> & AccountState)
  | (Omit<Frame<'session.event'>, 'event'> & { event: SessionEvent })
  | (Omit<Frame<'session.fragment'>, 'payload'> & { payload: EventPayload })
  | (Omit<Frame<'session.snapshot'>, 'events'> & { events: SessionEvent[] });

const number = { accountNumber: z.string().optional() };
const payloadOptions = eventPayloadSchema.options.map((schema) =>
  schema.shape.type.value === 'native.capabilities'
    ? schema.extend({ account: nativeAccountSchema.extend(number) })
    : schema,
);
const displayPayloadSchema = z
  .discriminatedUnion('type', [payloadOptions[0], ...payloadOptions.slice(1)])
  .transform((payload): EventPayload => payload);
const displayEventSchema = eventSchema.extend({ payload: displayPayloadSchema });

// Select the extended frames before parsing; the original Zod objects strip unknown fields.
const messageOptions = baseServerMessageSchema.options.map((schema) => {
  switch (schema.shape.type.value) {
    case 'account.state':
      return schema.extend(number);
    case 'session.event':
      return schema.extend({ event: displayEventSchema });
    case 'session.fragment':
      return schema.extend({ payload: displayPayloadSchema });
    case 'session.snapshot':
      return schema.extend({ events: z.array(displayEventSchema) });
    default:
      return schema;
  }
});
export const serverMessageSchema = z
  .discriminatedUnion('type', [messageOptions[0], ...messageOptions.slice(1)])
  .transform((message): ServerMessage => message);
