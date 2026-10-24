import { useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { SearchExpanded } from './ConversationFind.tsx';

// Keep the complete notice in the DOM for selection, copying and search. Only ordinary notices fold;
// errors always show every line. Resizing can turn a short notice into an overflowing one.
export default function RunNotice({ text, error }: { text: string; error: boolean }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const searching = useContext(SearchExpanded);
  const shown = error || expanded || searching;

  useLayoutEffect(() => {
    const node = content.current;
    if (!node || error) return;
    const measure = () => {
      const limit = parseFloat(getComputedStyle(node).lineHeight) * 3;
      setOverflowing(node.scrollHeight > limit + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, error]);

  return (
    <div className={`run-notice${error ? ' failed' : ''}`}>
      <div
        id={id}
        ref={content}
        className={`run-notice-text${shown ? ' expanded' : ''}`}
        role={error ? 'alert' : 'status'}
        data-search-content
        data-copy-text={text}
      >
        {text}
      </div>
      {!error && overflowing && !searching && (
        <button
          type="button"
          className="notice-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          data-search-ignore
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  );
}
