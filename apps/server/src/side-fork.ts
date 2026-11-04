import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

// A saved assistant block is not necessarily a complete tool exchange. Keep the latest prefix whose
// tool calls all have results; neither later text nor one result of a parallel batch closes the others.
export function sideForkBoundary(messages: readonly SessionMessage[]): string | undefined {
  const pending = new Set<string>();
  let boundary: string | undefined;
  for (const entry of messages) {
    if (entry.type === 'system' || entry.parent_tool_use_id) continue;
    const content = (entry.message as { content?: unknown } | null)?.content;
    let text = typeof content === 'string' && content.length > 0;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') {
          if (
            entry.type !== 'assistant' ||
            typeof block.id !== 'string' ||
            !block.id ||
            pending.has(block.id)
          )
            return boundary;
          pending.add(block.id);
        } else if (block.type === 'tool_result') {
          // An unmatched result makes the rest of this prefix invalid too. Preserve the last safe cut.
          if (
            entry.type !== 'user' ||
            typeof block.tool_use_id !== 'string' ||
            !pending.delete(block.tool_use_id)
          )
            return boundary;
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
          text = true;
      }
    }
    // Do not stop on an isolated thinking block or a system/compaction marker without its summary.
    if (!pending.size && (entry.type === 'user' || text)) boundary = entry.uuid;
  }
  return boundary;
}
