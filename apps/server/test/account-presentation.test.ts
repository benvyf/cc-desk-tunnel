import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  accountNumberFromId,
  serverMessageSchema,
} from '../../../packages/protocol/src/account-display.ts';
import type { EventPayload, ServerMessage } from '@cc-desk-tunnel/protocol';
import { accountMessageForClient } from '../src/account-presentation.ts';

const email = 'Owner@example.invalid';
const accountId = createHash('sha256').update(email.toLowerCase()).digest('hex');
const number = accountNumberFromId(accountId);
const capabilities: EventPayload = {
  type: 'native.capabilities',
  models: [],
  commands: [],
  account: { email, organization: email, subscriptionType: 'pro' },
};

test('client identity has a stable number and no identity email, organization or login material', () => {
  const raw: ServerMessage = {
    type: 'account.state',
    loggedIn: true,
    email: '  OWNER@EXAMPLE.INVALID  ',
    organization: email,
    subscriptionType: 'pro',
    login: { url: 'https://example.invalid/private-auth-link' },
    notice: email,
  };
  const visible = accountMessageForClient(raw);
  assert.equal(visible.type, 'account.state');
  assert.ok(visible.type === 'account.state');
  assert.equal(visible.accountNumber, number);
  assert.match(number, /^CC-(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);
  assert.equal(visible.email, undefined);
  assert.equal(visible.organization, undefined);
  assert.equal(visible.login, null);
  assert.equal(visible.notice, undefined);
  assert.deepEqual(serverMessageSchema.parse(visible), visible);
  assert.equal(raw.email, '  OWNER@EXAMPLE.INVALID  ');
  assert.ok(raw.login, 'source identity must remain available to the existing monitor');
});

test('live, fragment and historical native metadata use the same number without mutating history', () => {
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: capabilities,
  };
  const messages = [
    { type: 'session.event', event },
    {
      type: 'session.fragment',
      sessionId: event.sessionId,
      runId: event.runId,
      payload: capabilities,
    },
    { type: 'session.snapshot', events: [event] },
  ] as ServerMessage[];
  for (const raw of messages) {
    const visible = JSON.stringify(accountMessageForClient(raw));
    assert.ok(visible.includes(number));
    assert.ok(!visible.includes(email));
    assert.ok(!visible.includes('organization'));
  }
  assert.equal(capabilities.account.email, email);
});

test('original identity remains intact and user message text is not rewritten', () => {
  const raw: ServerMessage = { type: 'account.state', loggedIn: true, email, login: null };
  const visible = accountMessageForClient(raw);
  assert.ok(!JSON.stringify(visible).includes(email));
  assert.equal(raw.email, email);
  const message = {
    type: 'session.fragment',
    sessionId: randomUUID(),
    runId: randomUUID(),
    payload: { type: 'text.delta', messageId: randomUUID(), text: email },
  } as ServerMessage;
  assert.deepEqual(accountMessageForClient(message), message);
});

test('the client parser retains display numbers in live, fragment and paged history frames', () => {
  const sessionId = randomUUID(),
    runId = randomUUID(),
    now = new Date().toISOString();
  const event = { sessionId, runId, sequence: 1, createdAt: now, payload: capabilities };
  const messages: ServerMessage[] = [
    { type: 'session.event', event },
    { type: 'session.fragment', sessionId, runId, payload: capabilities },
    {
      type: 'session.snapshot',
      requestId: randomUUID(),
      mode: 'replace',
      session: {
        id: sessionId,
        title: 'Offline fixture',
        autoTitle: false,
        projectPath: '/tmp/fixture',
        permissionMode: 'auto',
        model: 'default',
        effort: null,
        createdAt: now,
        updatedAt: now,
        activeRun: null,
      },
      events: [event],
      firstSequence: 1,
      lastSequence: 1,
      hasEarlier: false,
    },
  ];
  for (const message of messages) {
    const wire = accountMessageForClient(message);
    const parsed = serverMessageSchema.parse(wire);
    assert.deepEqual(parsed, wire);
    assert.ok(JSON.stringify(parsed).includes(number));
  }
  // Existing services and persisted events can still omit the optional display metadata.
  assert.deepEqual(serverMessageSchema.parse(messages[0]), messages[0]);
});
