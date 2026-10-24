import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { SearchExpanded } from './ConversationFind.tsx';
import { ChevronRight } from './icons.tsx';
import { thinkingPreview } from './transcriptView.ts';

export default function ThinkingAccordion({
  text,
  running,
  preview,
  children,
}: {
  text: string;
  running: boolean;
  preview?: boolean;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const searching = useContext(SearchExpanded);
  const shown = open || searching;
  const [retained, setRetained] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  const contentId = useId();
  if (shown && !retained) setRetained(true);
  useLayoutEffect(() => {
    if (shown || !retained) return;
    let cancelled = false;
    // Retain Markdown only for the visual exit. No timers, height measurements or hidden history cache.
    const transitions = (ref.current?.getAnimations({ subtree: true }) ?? []).filter(
      (animation) =>
        animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-rows',
    );
    void Promise.allSettled(transitions.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setRetained(false);
    });
    return () => {
      cancelled = true;
    };
  }, [shown, retained]);
  return (
    <details
      ref={ref}
      className="tool thinking-block"
      open={shown}
      data-thinking={running ? 'active' : 'complete'}
    >
      <summary
        aria-expanded={shown}
        aria-controls={contentId}
        onClick={(event) => {
          event.preventDefault();
          if (!searching) setOpen(!open);
        }}
      >
        <span className="tool-heading">
          <span className="thinking-indicator" aria-hidden="true">
            <span />
            {running && (
              <>
                <span />
                <span />
              </>
            )}
          </span>
          <span className="tool-verb" role="status">
            {running ? '思考中…' : '思考已结束'}
          </span>
          {preview && (
            <span className="thinking-preview" aria-hidden={shown} data-search-ignore>
              {thinkingPreview(text)}
            </span>
          )}
        </span>
        <ChevronRight className="fold-chevron" />
      </summary>
      <div className="thinking-grid" id={contentId} inert={!shown} aria-hidden={!shown}>
        <div className="thinking-content">{(shown || retained) && children()}</div>
      </div>
    </details>
  );
}
