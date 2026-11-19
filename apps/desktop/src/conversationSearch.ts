// Search rendered text, including text split by inline Markdown formatting. Ranges highlight without changing
// React's DOM or the user's selection. Separate paragraphs/cells do not form an accidental joined match.
// `known` keeps the matches of each content block for the same query: a block not in `changed` (and found before)
// is not searched again, so a reply streaming at the end does not have the whole conversation searched each frame.
export function matchingRanges(
  root: HTMLElement,
  query: string,
  known?: Map<Element, Range[]>,
  changed?: Set<Element>,
): Range[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const all: Range[] = [];
  const blocks = root.querySelectorAll<HTMLElement>('[data-search-content]');
  for (const content of blocks) {
    const kept = known?.get(content);
    if (kept && !changed?.has(content)) {
      all.push(...kept);
      continue;
    }
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('button, [data-search-ignore]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let group: Element | null = null;
    let nodes: { node: Text; offset: number }[] = [];
    let text = '';
    const collect = () => {
      for (const match of text.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        const first = nodes.findLast((item) => item.offset <= start)!;
        const last = nodes.find((item) => item.offset + item.node.length >= end)!;
        const range = document.createRange();
        range.setStart(first.node, start - first.offset);
        range.setEnd(last.node, end - last.offset);
        ranges.push(range);
      }
      nodes = [];
      text = '';
    };
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const block =
        node.parentElement?.closest('p, li, pre, td, th, h1, h2, h3, h4, blockquote') ?? content;
      if (block !== group) {
        collect();
        group = block;
      }
      nodes.push({ node, offset: text.length });
      text += node.data;
    }
    collect();
    known?.set(content, ranges);
    all.push(...ranges);
  }
  if (known) for (const block of known.keys()) if (!block.isConnected) known.delete(block);
  return all;
}
