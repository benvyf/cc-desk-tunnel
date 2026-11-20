import type { AccountMonitorOptions } from './account-monitor.ts';

export type DesktopAccessOptions = AccountMonitorOptions & { allowLegacy: boolean };
type Fetch = typeof fetch;

// How a desktop's authorization is kept: the management center gives each ticket a lease, and this node renews the
// leases of all its connections together every RENEW_INTERVAL_MS (createDesktopLeases). A refusal ends a connection
// at once; a center that cannot be reached only stops renewing, and a connection ends when its lease runs out.
export const RENEW_INTERVAL_MS = 30_000;
const RENEW_TIMEOUT_MS = 8_000;
const VALIDATE_TIMEOUT_MS = 4_000;
export const RENEW_BATCH = 200;
// The longest lease taken from the center, whatever it says (it gives 300 s).
export const MAX_LEASE_MS = 330_000;
// The lease of a first sign-in, until the first batched renewal.
export const INITIAL_LEASE_MS = 60_000;
// The lease of a renewal through `validate` (a center without `renew`): long enough that one lost round, with the
// timer running a little late, does not end a connection before the next round tries again.
export const LEGACY_LEASE_MS = 100_000;
const ticketPattern = /^ccs_[A-Za-z0-9_-]{43}$/;

function request(options: DesktopAccessOptions, path: string, body: unknown, timeout: number) {
  return {
    target: new URL(path, options.url),
    init: {
      method: 'POST',
      redirect: 'error' as const,
      signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body),
    },
  };
}

// Leases are counted from when this node asked, on its own clock: the center's clock is never compared with it.
export async function validateDesktopTicket(
  options: DesktopAccessOptions,
  ticket: string,
  renewal = false,
  fetchImpl: Fetch = fetch,
) {
  if (!ticketPattern.test(ticket)) throw new Error('Invalid desktop ticket');
  const sent = Date.now();
  const { target, init } = request(
    options,
    '/cc-access/v1/validate',
    { nodeId: options.nodeId, ticket, renewal },
    VALIDATE_TIMEOUT_MS,
  );
  const response = await fetchImpl(target, init);
  if (!response.ok)
    throw Object.assign(new Error('Desktop authorization refused'), { status: response.status });
  const result = (await response.json()) as { userId?: unknown; validUntil?: unknown };
  if (typeof result.userId !== 'string' || typeof result.validUntil !== 'number')
    throw new Error('Invalid desktop authorization lease');
  return { ticket, userId: result.userId, validUntil: sent + INITIAL_LEASE_MS };
}

// Several tickets renewed in one request: for each, in order, whether it still stands, and the lease of those
// that do. 'unsupported' where the center has no such request (one older than this node).
export async function renewDesktopTickets(
  options: DesktopAccessOptions,
  tickets: string[],
  fetchImpl: Fetch = fetch,
): Promise<{ leaseMs: number; valid: boolean[] } | 'unsupported'> {
  const { target, init } = request(
    options,
    '/cc-access/v1/renew',
    { nodeId: options.nodeId, tickets },
    RENEW_TIMEOUT_MS,
  );
  const response = await fetchImpl(target, init);
  if (response.status === 404) return 'unsupported';
  if (!response.ok)
    throw Object.assign(new Error('Desktop renewal failed'), { status: response.status });
  const result = (await response.json()) as { leaseMs?: unknown; valid?: unknown };
  if (
    typeof result.leaseMs !== 'number' ||
    !Number.isFinite(result.leaseMs) ||
    result.leaseMs <= 0 ||
    !Array.isArray(result.valid) ||
    result.valid.length !== tickets.length ||
    !result.valid.every((value) => typeof value === 'boolean')
  )
    throw new Error('Invalid desktop renewal');
  return { leaseMs: result.leaseMs, valid: result.valid as boolean[] };
}

export type LeasePeer = {
  access?: { ticket: string; userId: string; validUntil: number };
  revoke: () => void;
};

// The leases of this node's connections. Tickets are not used up by signing in, so connections may share one; they
// are renewed and refused together.
export function createDesktopLeases(
  options: DesktopAccessOptions,
  { now = Date.now, fetchImpl = fetch }: { now?: () => number; fetchImpl?: Fetch } = {},
) {
  const byTicket = new Map<string, Set<LeasePeer>>();
  let inFlight = false;
  const end = (peers: Iterable<LeasePeer>) => {
    for (const peer of [...peers]) {
      untrack(peer);
      peer.revoke();
    }
  };
  function untrack(peer: LeasePeer) {
    const ticket = peer.access?.ticket;
    const peers = ticket ? byTicket.get(ticket) : undefined;
    if (!peers) return;
    peers.delete(peer);
    if (!peers.size) byTicket.delete(ticket!);
  }
  const extend = (ticket: string, until: number) => {
    for (const peer of byTicket.get(ticket) ?? [])
      if (peer.access) peer.access = { ...peer.access, validUntil: until };
  };
  async function renewChunk(tickets: string[]) {
    const sent = now();
    let answer: Awaited<ReturnType<typeof renewDesktopTickets>>;
    try {
      answer = await renewDesktopTickets(options, tickets, fetchImpl);
    } catch {
      // Not renewed this round; the leases run on.
      return;
    }
    if (answer === 'unsupported') {
      // An older center: one ticket at a time, under the same rule. Only its refusal ends a connection.
      await Promise.all(
        tickets.map(async (ticket) => {
          const asked = now();
          try {
            await validateDesktopTicket(options, ticket, true, fetchImpl);
            extend(ticket, asked + LEGACY_LEASE_MS);
          } catch (error) {
            if ((error as { status?: number }).status === 401) end(byTicket.get(ticket) ?? []);
          }
        }),
      );
      return;
    }
    const until = sent + Math.min(answer.leaseMs, MAX_LEASE_MS);
    tickets.forEach((ticket, index) => {
      if (answer.valid[index]) extend(ticket, until);
      else end(byTicket.get(ticket) ?? []);
    });
  }
  return {
    track(peer: LeasePeer) {
      const ticket = peer.access?.ticket;
      if (!ticket) return;
      const peers = byTicket.get(ticket) ?? new Set<LeasePeer>();
      peers.add(peer);
      byTicket.set(ticket, peers);
    },
    untrack,
    async tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const at = now();
        for (const peers of [...byTicket.values()])
          end([...peers].filter((peer) => !peer.access || peer.access.validUntil <= at));
        const tickets = [...byTicket.keys()];
        for (let start = 0; start < tickets.length; start += RENEW_BATCH)
          await renewChunk(tickets.slice(start, start + RENEW_BATCH));
      } finally {
        inFlight = false;
      }
    },
    size: () => byTicket.size,
  };
}
