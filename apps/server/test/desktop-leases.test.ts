import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDesktopLeases,
  INITIAL_LEASE_MS,
  LEGACY_LEASE_MS,
  MAX_LEASE_MS,
  RENEW_BATCH,
  RENEW_INTERVAL_MS,
  validateDesktopTicket,
  type LeasePeer,
} from '../src/desktop-access.ts';

const options = {
  url: 'https://center.test',
  nodeId: 'node-a',
  token: 't'.repeat(40),
  allowLegacy: false,
};
const ticket = (n: number) => `ccs_${String(n).padStart(43, '0')}`;
type Answer = { status: number; body?: unknown } | 'throw';

// A center answering from a script: renew and validate calls, recorded.
function center(answer: (path: string, body: Record<string, unknown>) => Answer) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (target: URL | string, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    const result = answer(path, body);
    if (result === 'throw') throw new Error('network down');
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}
function peer(ticketId: string, validUntil: number) {
  const value: LeasePeer & { revoked: number } = {
    access: { ticket: ticketId, userId: 'u', validUntil },
    revoked: 0,
    revoke: () => {
      value.revoked++;
    },
  };
  return value;
}
const renewAll = (body: Record<string, unknown>, leaseMs = 300_000) => ({
  status: 200,
  body: { leaseMs, valid: (body.tickets as string[]).map(() => true) },
});

test('a center out of reach only stops renewal: connections end when their lease runs out', async () => {
  let clock = 1_000_000;
  let down = false;
  const { fetchImpl } = center((_, body) => (down ? 'throw' : renewAll(body)));
  const leases = createDesktopLeases(options, { now: () => clock, fetchImpl });
  const a = peer(ticket(1), clock + INITIAL_LEASE_MS);
  leases.track(a);
  await leases.tick();
  assert.equal(a.access!.validUntil, clock + 300_000);
  down = true;
  for (let round = 0; round < 9; round++) {
    clock += RENEW_INTERVAL_MS;
    await leases.tick();
  }
  assert.equal(a.revoked, 0);
  clock += 2 * RENEW_INTERVAL_MS;
  await leases.tick();
  assert.equal(a.revoked, 1);
  assert.equal(leases.size(), 0);
});

test('a refusal ends every connection on that ticket at once; others are renewed', async () => {
  const clock = 5_000_000;
  const { fetchImpl, calls } = center((_, body) => ({
    status: 200,
    body: { leaseMs: 300_000, valid: (body.tickets as string[]).map((t) => t !== ticket(2)) },
  }));
  const leases = createDesktopLeases(options, { now: () => clock, fetchImpl });
  const [a, b1, b2] = [
    peer(ticket(1), clock + 1),
    peer(ticket(2), clock + 1),
    peer(ticket(2), clock + 1),
  ];
  for (const p of [a, b1, b2]) leases.track(p);
  await leases.tick();
  assert.deepEqual(
    calls.map((call) => call.body.tickets),
    [[ticket(1), ticket(2)]],
  );
  assert.equal(calls[0]!.body.nodeId, 'node-a');
  assert.deepEqual([a.revoked, b1.revoked, b2.revoked], [0, 1, 1]);
  assert.equal(a.access!.validUntil, clock + 300_000);
});

test('errors and malformed answers neither renew nor revoke', async () => {
  const clock = 7_000_000;
  for (const answer of [
    { status: 401 },
    { status: 403 },
    { status: 500 },
    { status: 429 },
    { status: 200, body: { leaseMs: 300_000, valid: [] } },
    { status: 200, body: { leaseMs: -1, valid: [false] } },
    { status: 200, body: { leaseMs: 300_000, valid: ['no'] } },
  ]) {
    const { fetchImpl } = center(() => answer);
    const leases = createDesktopLeases(options, { now: () => clock, fetchImpl });
    const a = peer(ticket(1), clock + 1000);
    leases.track(a);
    await leases.tick();
    assert.equal(a.revoked, 0, JSON.stringify(answer));
    assert.equal(a.access!.validUntil, clock + 1000, JSON.stringify(answer));
  }
});

test('a center without batched renewal is asked ticket by ticket; only its refusal ends a connection', async () => {
  const clock = 9_000_000;
  const { fetchImpl, calls } = center((path, body) =>
    path === '/cc-access/v1/renew'
      ? { status: 404 }
      : body.ticket === ticket(1)
        ? { status: 200, body: { userId: 'u', validUntil: 1 } }
        : body.ticket === ticket(2)
          ? { status: 401 }
          : { status: 500 },
  );
  const leases = createDesktopLeases(options, { now: () => clock, fetchImpl });
  const [a, b, c] = [
    peer(ticket(1), clock + 10),
    peer(ticket(2), clock + 10),
    peer(ticket(3), clock + 10),
  ];
  for (const p of [a, b, c]) leases.track(p);
  await leases.tick();
  assert.deepEqual(
    calls.filter((call) => call.path === '/cc-access/v1/validate').map((call) => call.body.renewal),
    [true, true, true],
  );
  assert.deepEqual([a.revoked, b.revoked, c.revoked], [0, 1, 0]);
  assert.equal(a.access!.validUntil, clock + LEGACY_LEASE_MS);
  assert.equal(c.access!.validUntil, clock + 10);
});

test('large nodes renew in chunks; the lease is capped and counted on this clock', async () => {
  const clock = 11_000_000;
  const { fetchImpl, calls } = center((_, body) => renewAll(body, 10 * 86400_000));
  const leases = createDesktopLeases(options, { now: () => clock, fetchImpl });
  const peers = Array.from({ length: RENEW_BATCH + 1 }, (_, n) => peer(ticket(n), clock + 1));
  for (const p of peers) leases.track(p);
  await leases.tick();
  assert.deepEqual(
    calls.map((call) => (call.body.tickets as string[]).length),
    [RENEW_BATCH, 1],
  );
  assert.ok(peers.every((p) => p.access!.validUntil === clock + MAX_LEASE_MS));
});

test('a renewal in flight is not asked again, and untracked connections are left alone', async () => {
  const clock = 13_000_000;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let asked = 0;
  const fetchImpl = (async (_: URL | string, init?: RequestInit) => {
    asked++;
    await gate;
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ leaseMs: 300_000, valid: body.tickets.map(() => false) }),
      {
        status: 200,
      },
    );
  }) as typeof fetch;
  const leases = createDesktopLeases(options, { now: () => clock, fetchImpl });
  const a = peer(ticket(1), clock + 1);
  const gone = peer(ticket(1), clock + 1);
  leases.track(a);
  leases.track(gone);
  const first = leases.tick();
  await leases.tick();
  leases.untrack(gone);
  release();
  await first;
  assert.equal(asked, 1);
  assert.equal(a.revoked, 1);
  assert.equal(gone.revoked, 0);
});

test('a first sign-in lease is counted from when this node asked, whatever the center clock says', async () => {
  const before = Date.now();
  const { fetchImpl } = center(() => ({ status: 200, body: { userId: 'u', validUntil: 42 } }));
  const access = await validateDesktopTicket(options, ticket(1), false, fetchImpl);
  assert.ok(access.validUntil >= before + INITIAL_LEASE_MS);
  assert.ok(access.validUntil <= Date.now() + INITIAL_LEASE_MS);
  const refused = center(() => ({ status: 401 }));
  await assert.rejects(validateDesktopTicket(options, ticket(1), false, refused.fetchImpl), {
    status: 401,
  });
});
