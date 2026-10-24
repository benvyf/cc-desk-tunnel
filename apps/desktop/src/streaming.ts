import type { Element, Root, RootContent, Text } from 'hast';

type Reveal = { source: string; start: number; revision: number };
const immediate = new Set(['pre', 'code', 'math', 'svg', 'table']);
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const maxReveals = 24;

// The Markdown parser already gives source offsets. Reveal only the appended prose, without another
// parser or a token queue. Bound grapheme nodes across the whole update, including large Markdown bursts.
// Rewritten/escaped partial leaves stay immediate.
export function revealStreaming({ source, start, revision }: Reveal) {
  return (tree: Root) => {
    if (start >= source.length) return;
    let revealed = 0;
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
        if (node.type !== 'text' || !node.position || revealed >= maxReveals) return [node];
        const from = node.position.start.offset;
        const end = node.position.end.offset;
        if (from === undefined || end === undefined || end <= start || !node.value.trim())
          return [node];
        let split = Math.max(0, start - from);
        if (split && source.slice(from, end) !== node.value) return [node];
        // A later chunk can complete an emoji/combining sequence already at the end of the prefix.
        if (split) split = graphemes.segment(node.value).containing(split)?.index ?? split;
        const prefix = node.value.slice(0, split);
        const suffix = node.value.slice(split);
        if (!suffix.trim()) return [node];
        const children: Element['children'] = [];
        let plainStart = 0;
        for (const { segment, index } of graphemes.segment(suffix)) {
          if (revealed >= maxReveals) break;
          if (!segment.trim()) continue;
          // Preserve whitespace as slices, never one React text child per space.
          if (index > plainStart)
            children.push({ type: 'text', value: suffix.slice(plainStart, index) });
          children.push({
            type: 'element',
            tagName: 'span',
            properties: {
              className: ['stream-grapheme'],
              style: `--stream-index:${revealed++}`,
            },
            children: [{ type: 'text', value: segment }],
          });
          plainStart = index + segment.length;
        }
        if (plainStart < suffix.length)
          children.push({ type: 'text', value: suffix.slice(plainStart) });
        const span: Element = {
          type: 'element',
          tagName: 'span',
          properties: { className: ['stream-reveal'], 'data-reveal-key': `${revision}:${from}` },
          children,
        };
        return prefix ? [{ type: 'text', value: prefix } satisfies Text, span] : [span];
      });
    };
    visit(tree);
  };
}
