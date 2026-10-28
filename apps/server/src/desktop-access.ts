import type { AccountMonitorOptions } from './account-monitor.ts';

export type DesktopAccessOptions = AccountMonitorOptions & { allowLegacy: boolean };
export async function validateDesktopTicket(
  options: DesktopAccessOptions,
  ticket: string,
  renewal = false,
) {
  if (!/^ccs_[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('Invalid desktop ticket');
  const target = new URL('/cc-access/v1/validate', options.url);
  const response = await fetch(target, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(4000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
    body: JSON.stringify({ nodeId: options.nodeId, ticket, renewal }),
  });
  if (!response.ok) throw new Error('Desktop authorization refused');
  const result = (await response.json()) as { userId?: unknown; validUntil?: unknown };
  if (
    typeof result.userId !== 'string' ||
    typeof result.validUntil !== 'number' ||
    result.validUntil <= Date.now() ||
    result.validUntil > Date.now() + 65_000
  )
    throw new Error('Invalid desktop authorization lease');
  return { ticket, userId: result.userId, validUntil: result.validUntil };
}
