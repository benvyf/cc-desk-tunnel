import type { Session } from '@cc-desk-tunnel/protocol';

// A row of a list that shows forks under what they were forked from (Sidebar.tsx).
export type ForkRow = {
  session: Session;
  // 0 for a session at the top; 1 for a fork of it; and so on.
  depth: number;
  // The last fork of its parent in the list.
  last: boolean;
  // For each level above its own, from 1: whether the line of that level goes on past this row, to a later fork
  // of an ancestor's parent.
  rails: boolean[];
  parentTitle?: string;
};

// A list's sessions as a tree of forks: each fork under its source, if the source is in the same list; otherwise at
// the top (a source deleted, in another project, filtered out by a search). The list is only arranged: a family
// takes the place of its member that came first in the list, and within it, forks keep the list's order. Nothing
// is added or dropped, a list with no forks is as it was, and a loop (which nothing makes, but data may hold) is
// broken at its oldest member.
export function forkRows(members: Session[]): ForkRow[] {
  const index = new Map(members.map((session, at) => [session.id, at]));
  const byId = new Map(members.map((session) => [session.id, session]));
  const parent = new Map<string, string>();
  for (const session of members) {
    const source = session.forkedFromSessionId;
    if (source && source !== session.id && byId.has(source)) parent.set(session.id, source);
  }
  // Each loop loses the link out of its oldest member.
  const settled = new Set<string>();
  for (const session of members) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let at: string | undefined = session.id;
    while (at && !settled.has(at) && !onPath.has(at)) {
      path.push(at);
      onPath.add(at);
      at = parent.get(at);
    }
    if (at && onPath.has(at)) {
      const loop = path.slice(path.indexOf(at));
      const oldest = loop
        .map((id) => byId.get(id)!)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      parent.delete(oldest.id);
    }
    for (const id of path) settled.add(id);
  }
  const children = new Map<string, Session[]>();
  for (const session of members) {
    const source = parent.get(session.id);
    if (!source) continue;
    const list = children.get(source);
    if (list) list.push(session);
    else children.set(source, [session]);
  }
  // Where a family stands: where its first member in the list does.
  const first = new Map<string, number>();
  const order: string[] = [];
  const stack = members.filter((session) => !parent.has(session.id)).map((session) => session.id);
  while (stack.length) {
    const id = stack.pop()!;
    order.push(id);
    for (const child of children.get(id) ?? []) stack.push(child.id);
  }
  for (const id of order.reverse()) {
    let at = index.get(id)!;
    for (const child of children.get(id) ?? []) at = Math.min(at, first.get(child.id)!);
    first.set(id, at);
  }
  const byPlace = (a: Session, b: Session) => first.get(a.id)! - first.get(b.id)!;
  const rows: ForkRow[] = [];
  const pending: { session: Session; depth: number; last: boolean; rails: boolean[] }[] = members
    .filter((session) => !parent.has(session.id))
    .sort(byPlace)
    .reverse()
    .map((session) => ({ session, depth: 0, last: false, rails: [] }));
  while (pending.length) {
    const { session, depth, last, rails } = pending.pop()!;
    const source = parent.get(session.id);
    rows.push({
      session,
      depth,
      last,
      rails,
      ...(source ? { parentTitle: byId.get(source)!.title } : {}),
    });
    const forks = [...(children.get(session.id) ?? [])].sort(byPlace);
    // A fork of this one draws this one's line on through it while this one has forks of its parent still to come.
    const through = depth > 0 ? [...rails, !last] : [];
    for (let at = forks.length - 1; at >= 0; at--)
      pending.push({
        session: forks[at],
        depth: depth + 1,
        last: at === forks.length - 1,
        rails: through,
      });
  }
  return rows;
}

// The sessions kept in a shortened list, with the sources they were forked from that are in the full list: a fork
// is not shown without what it hangs from. In the full list's order.
export function withAncestors(kept: Session[], members: Session[]): Session[] {
  const byId = new Map(members.map((session) => [session.id, session]));
  const shown = new Set(kept.map((session) => session.id));
  for (const session of kept) {
    let source = session.forkedFromSessionId;
    const seen = new Set([session.id]);
    while (source && byId.has(source) && !seen.has(source)) {
      seen.add(source);
      shown.add(source);
      source = byId.get(source)!.forkedFromSessionId;
    }
  }
  return members.filter((session) => shown.has(session.id));
}
