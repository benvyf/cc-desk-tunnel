import { DomainError } from './errors.ts';

export type ModerationOptions = {
  endpoint: string;
  nodeId: string;
  token: string;
  // Offline tests only; production uses ordinary HTTPS fetch, independently of Claude's transport.
  fetcher?: typeof fetch;
};
function refused(requestId: string, code: string, reviewId?: unknown): never {
  console.error('Input review refused.', { requestId, code, ...(reviewId ? { reviewId } : {}) });
  // Detailed reasons stay in the management center, not in ordinary CC clients.
  throw new DomainError('operation_failed', '操作失败，请稍后再试。');
}
export function moderationConfig(value: unknown): ModerationOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid moderation node configuration.');
  const v = value as ModerationOptions;
  const url = new URL(v.endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/cc-updates/v1/moderation/check' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.nodeId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.token)
  )
    throw new Error('Invalid moderation node configuration.');
  return { endpoint: url.href, nodeId: v.nodeId, token: v.token };
}

export async function reviewInput(
  options: ModerationOptions,
  input: {
    requestId: string;
    sessionId: string;
    deviceId: string;
    kind: string;
    text: string;
  },
  timeoutMs = 7500,
) {
  if (timeoutMs <= 0) refused(input.requestId, 'moderation_deadline');
  if (!input.text.trim() || Buffer.byteLength(input.text) > 65536)
    refused(input.requestId, 'moderation_input_limit');
  let result: { id?: unknown; allowed?: unknown };
  try {
    const response = await (options.fetcher ?? fetch)(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: options.nodeId, ...input }),
    });
    if (response.status !== 200) throw new Error('review_http');
    // Responses contain a decision and one correlation ID, never the original text.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('review_empty');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) throw new Error('review_response_limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !result ||
      typeof result.allowed !== 'boolean' ||
      typeof result.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(result.id)
    )
      throw new Error('review_invalid');
  } catch {
    refused(input.requestId, 'moderation_unavailable');
  }
  if (!result.allowed) refused(input.requestId, 'moderation_rejected', result.id);
}
