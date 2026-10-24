import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UpdateError } from './store.ts';
import type { ModerationStore } from './moderation.ts';
import { readFreshNodes } from './fresh-nodes.ts';

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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    registry = {};
  }
  for (const [id, node] of Object.entries(readFreshNodes(root)))
    if (node.moderationHash) registry[id] = node.moderationHash;
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
    {
      hash: string;
      revision: number;
      at: number;
      result: Promise<{ id: string; allowed: boolean }>;
    }
  >();
  // Native hooks are separate processes and generate a fresh request ID for every tool batch.
  // Keep the last approved input per native session, not a writable approval file on Ubuntu.
  private nativeContent = new Map<
    string,
    { hash: string; revision: number; result: Promise<{ id: string; allowed: boolean }> }
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
    const revision = store.config().revision;
    for (const [id, entry] of this.recent)
      if (Date.now() - entry.at > 300000) this.recent.delete(id);
    const previous = this.recent.get(key);
    if (previous) {
      if (previous.hash !== hash) throw new UpdateError(409, 'Review request ID conflict.');
      if (previous.revision === revision) return previous.result;
    }
    if (!previous && this.recent.size >= 512) throw new UpdateError(429, 'Review service busy.');
    const context = v.deviceId === 'native-terminal' ? `${nodeId}:${v.sessionId}` : undefined;
    const textHash = createHash('sha256').update(v.text).digest('hex');
    const cached = context ? this.nativeContent.get(context) : undefined;
    const reuse = cached?.revision === revision && cached.hash === textHash;
    const result = reuse
      ? cached.result
      : store
          .review(v.text, nodeId, 'node.review', {
            requestId: v.requestId,
            sessionId: v.sessionId,
            deviceId: v.deviceId,
            inputKind: v.kind,
          })
          .then(({ id, allowed }) => ({ id, allowed }));
    if (context && !reuse) {
      const entry = { hash: textHash, revision, result };
      this.nativeContent.set(context, entry);
      if (this.nativeContent.size > 512)
        this.nativeContent.delete(this.nativeContent.keys().next().value!);
      const forget = () => {
        if (this.nativeContent.get(context) === entry) this.nativeContent.delete(context);
      };
      void result.then((decision) => {
        if (!decision.allowed) forget();
      }, forget);
    }
    this.recent.set(key, { hash, revision, at: Date.now(), result });
    return result;
  }
}
