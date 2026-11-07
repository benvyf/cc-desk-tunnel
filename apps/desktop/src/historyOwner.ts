type Identity =
  | { mode: 'email'; email?: string; nodeId?: string }
  | { mode: 'remote'; url: string; fingerprint: string }
  | { mode: 'local'; url: string };

// Email must come from the account service, never from an editable login form or a ticket.
export function historyOwner(identity: Identity): string | undefined {
  if (identity.mode === 'email') {
    if (!identity.email?.trim() || !identity.nodeId?.trim()) return;
    return `email|${identity.email.toLowerCase()}|${identity.nodeId}`;
  }
  if (identity.mode === 'remote') return `manual|${identity.url}|${identity.fingerprint}`;
  return `local|${identity.url}`;
}
