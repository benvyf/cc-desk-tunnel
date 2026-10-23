import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UpdateError } from './store.ts';
import type { ModerationStore } from './moderation.ts';

export const moderationPath = '/cc-updates/v1/moderation/check';
const kinds = [
  'message.send',
  'run.continue',
  'session.compact',
  'approval.reply',
  'instructions.update',
];
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
type Review = {
  nodeId: string;
  requestId: string;
  sessionId: string;
  deviceId: string;
  kind: string;
  text: string;
};

// Separate from administrator credentials. Reading on each request makes revocation immediate.
export async function authenticateNode(root: string, authorization: string | undefined) {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new UpdateError(401, 'Node authentication required.');
  let registry: Record<string, string>;
  try {
    registry = JSON.parse(await readFile(join(root, 'private/moderation-nodes.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new UpdateError(401, 'Node authentication required.');
    throw error;
  }
  const hash = createHash('sha256').update(token).digest();
  for (const [id, expected] of Object.entries(registry)) {
    if (
      identifier.test(id) &&
      /^[a-f0-9]{64}$/.test(expected) &&
      timingSafeEqual(hash, Buffer.from(expected, 'hex'))
    )
      return id;
  }
  throw new UpdateError(401, 'Node authentication required.');
}

export class NodeReviews {
  private recent = new Map<
    string,
    { hash: string; at: number; result: Promise<{ id: string; allowed: boolean }> }
  >();
  async check(nodeId: string, value: unknown, store: ModerationStore) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new UpdateError(400, 'Invalid review.');
    const v = value as Review;
    if (
      Object.keys(v).length !== 6 ||
      v.nodeId !== nodeId ||
      ![v.requestId, v.sessionId, v.deviceId].every(
        (id) => typeof id === 'string' && identifier.test(id),
      ) ||
      !kinds.includes(v.kind) ||
      typeof v.text !== 'string' ||
      !v.text.trim() ||
      Buffer.byteLength(v.text) > 65536
    )
      throw new UpdateError(400, 'Invalid review.');
    const hash = createHash('sha256')
      .update(JSON.stringify([v.sessionId, v.deviceId, v.kind, v.text]))
      .digest('hex');
    const key = `${nodeId}:${v.requestId}`;
    for (const [id, entry] of this.recent)
      if (Date.now() - entry.at > 300000) this.recent.delete(id);
    const previous = this.recent.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new UpdateError(409, 'Review request ID conflict.');
      return previous.result;
    }
    if (this.recent.size >= 512) throw new UpdateError(429, 'Review service busy.');
    const result = store
      .review(v.text, nodeId, 'node.review', {
        requestId: v.requestId,
        sessionId: v.sessionId,
        deviceId: v.deviceId,
        inputKind: v.kind,
      })
      .then(({ id, allowed }) => ({ id, allowed }));
    this.recent.set(key, { hash, at: Date.now(), result });
    return result;
  }
}
