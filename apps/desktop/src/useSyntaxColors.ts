import { useEffect } from 'react';
import type { RefObject } from 'react';

// Keep one source Text node: line navigation, native selection and copying use its exact offsets.
export function useSyntaxColors(
  source: RefObject<HTMLElement | null>,
  text: string,
  language: string,
) {
  useEffect(() => {
    const element = source.current;
    const node = element?.firstChild;
    const doc = element?.ownerDocument;
    const win = doc?.defaultView;
    if (
      !element ||
      !node ||
      node.nodeType !== 3 ||
      !doc ||
      !win?.CSS.highlights ||
      text.length > 100000
    )
      return;
    const registry = win.CSS.highlights;
    const owned: { name: string; range: Range }[] = [];
    let disposed = false;
    void import('./syntax.ts')
      .then(({ syntaxMarkup }) => {
        if (disposed) return;
        const markup = syntaxMarkup(text, language);
        if (!markup) return;
        // highlight.js escapes source text; only its generated span vocabulary enters this inert template.
        const template = doc.createElement('template');
        // Character references preserve CR bytes that the HTML parser would otherwise normalize to LF.
        template.innerHTML = markup.replaceAll('\r', '&#13;');
        if (template.content.textContent !== text) return;
        const walker = doc.createTreeWalker(template.content, 4);
        let offset = 0;
        for (let leaf = walker.nextNode(); leaf; leaf = walker.nextNode()) {
          const end = offset + (leaf.textContent?.length ?? 0);
          const scope = leaf.parentElement?.closest('[class*="hljs-"]')?.className ?? '';
          const kind = /hljs-(keyword|literal|built_in|type)/.test(scope)
            ? 'keyword'
            : /hljs-(string|regexp|attr)/.test(scope)
              ? 'string'
              : /hljs-(comment|quote)/.test(scope)
                ? 'comment'
                : /hljs-(number|symbol)/.test(scope)
                  ? 'number'
                  : /hljs-(title|section|tag|name)/.test(scope)
                    ? 'title'
                    : undefined;
          if (kind && end > offset && owned.length < 10000) {
            const range = doc.createRange();
            range.setStart(node, offset);
            range.setEnd(node, end);
            const name = `cc-syntax-${kind}`;
            let highlight = registry.get(name);
            if (!highlight) {
              highlight = new win.Highlight();
              registry.set(name, highlight);
            }
            highlight.add(range);
            owned.push({ name, range });
          }
          offset = end;
        }
      })
      .catch(() => {}); // A failed optional highlighter leaves the original source readable.
    return () => {
      disposed = true;
      for (const { name, range } of owned) {
        const highlight = registry.get(name);
        highlight?.delete(range);
        if (highlight?.size === 0) registry.delete(name);
      }
    };
  }, [source, text, language]);
}
