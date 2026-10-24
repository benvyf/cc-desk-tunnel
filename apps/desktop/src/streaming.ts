import type { Element, Root, RootContent, Text } from 'hast';

type Reveal = { source: string; start: number; revision: number };
const immediate = new Set(['pre', 'code', 'math', 'svg', 'table']);

// The Markdown parser already gives source offsets. Reveal only the appended prose, without another
// parser, a token queue, or a DOM node for each character. Rewritten/escaped partial leaves stay immediate.
export function revealStreaming({ source, start, revision }: Reveal) {
  return (tree: Root) => {
    if (start >= source.length) return;
    const visit = (parent: Root | Element) => {
      if (
        parent.type === 'element' &&
        (immediate.has(parent.tagName) ||
          (parent.properties.className as string[] | undefined)?.some((name) =>
            name.startsWith('katex'),
          ))
      )
        return;
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === 'element') {
          visit(node);
          return [node];
        }
        if (node.type !== 'text' || !node.position) return [node];
        const from = node.position.start.offset;
        const end = node.position.end.offset;
        if (from === undefined || end === undefined || end <= start || !node.value.trim())
          return [node];
        const split = Math.max(0, start - from);
        if (split && source.slice(from, end) !== node.value) return [node];
        const prefix = node.value.slice(0, split);
        const suffix = node.value.slice(split);
        if (!suffix.trim()) return [node];
        const span: Element = {
          type: 'element',
          tagName: 'span',
          properties: { className: ['stream-reveal'], 'data-reveal-key': `${revision}:${from}` },
          children: [{ type: 'text', value: suffix }],
        };
        return prefix ? [{ type: 'text', value: prefix } satisfies Text, span] : [span];
      });
    };
    visit(tree);
  };
}
