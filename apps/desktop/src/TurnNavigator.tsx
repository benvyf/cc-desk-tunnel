import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Turn } from './transcript.ts';
import { splitAttachmentMessage } from './attachments.ts';
import { Bookmark } from './icons.tsx';
import { setPrefs, toggled, usePrefs } from './prefs.ts';

// A fixed-pitch rail beside the transcript; previews never change the scroll position.
export default function TurnNavigator({
  turns,
  scroll,
  navigate,
  hasEarlier,
  loadEarlier,
  loadingEarlier,
}: {
  turns: Turn[];
  scroll: RefObject<HTMLDivElement | null>;
  navigate: (id: string) => void;
  hasEarlier: boolean;
  loadEarlier: () => void;
  loadingEarlier: boolean;
}) {
  const items = useMemo(
    () => turns.filter((turn) => turn.question && !turn.question.continued),
    [turns],
  );
  const ids = items.map((turn) => turn.id).join(',');
  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; top: number } | null>(null);
  const frame = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const previewAnchor = useRef<HTMLElement | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const tooltipId = useId();
  const { bookmarkedMessages } = usePrefs();
  const bookmarks = useMemo(() => new Set(bookmarkedMessages), [bookmarkedMessages]);
  const previewId = preview?.id;
  useEffect(() => {
    setPreview(null);
    const box = scroll.current;
    if (!box) return;
    const marks = new Set(ids.split(','));
    const anchors = Array.from(
      box.querySelectorAll<HTMLElement>('.message.user[data-message-id]'),
    ).filter((element) => marks.has(element.dataset.messageId!));
    let request = 0;
    const measure = () => {
      if (request) return;
      request = requestAnimationFrame(() => {
        request = 0;
        const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        if (atEnd) {
          setActive(anchors.at(-1)?.dataset.messageId ?? null);
          return;
        }
        const line = box.getBoundingClientRect().top + Math.min(100, box.clientHeight / 3);
        // Message anchors are ordered; find the question at or just above the reading position.
        let low = 0,
          high = anchors.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (anchors[mid].getBoundingClientRect().top <= line) low = mid;
          else high = mid - 1;
        }
        setActive(anchors[low]?.dataset.messageId ?? null);
      });
    };
    box.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const transcript = box.querySelector('.transcript');
    if (transcript) observer.observe(transcript);
    measure();
    return () => {
      box.removeEventListener('scroll', measure);
      observer.disconnect();
      cancelAnimationFrame(request);
    };
  }, [ids, scroll]);
  useEffect(() => {
    if (pointerInside || previewId || !rail.current || !active) return;
    const mark = Array.from(rail.current.querySelectorAll<HTMLElement>('[data-turn-mark]')).find(
      (element) => element.dataset.turnMark === active,
    );
    if (!mark) return;
    const bounds = rail.current.getBoundingClientRect(),
      rect = mark.getBoundingClientRect();
    if (rect.top < bounds.top || rect.bottom > bounds.bottom)
      rail.current.scrollTop += rect.top - bounds.top - bounds.height / 2;
  }, [active, previewId, pointerInside]);
  const turn = items.find((item) => item.id === preview?.id);
  const peakIndex = Math.max(
    0,
    items.findIndex((item) => item.id === preview?.id),
  );
  function show(id: string, element: HTMLElement) {
    previewAnchor.current = element;
    const bounds = frame.current!.getBoundingClientRect();
    const top = element.getBoundingClientRect().top - bounds.top - 36;
    const nextTop = Math.max(4, Math.min(top, bounds.height - 120));
    setPreview((current) =>
      current?.id === id && current.top === nextTop ? current : { id, top: nextTop },
    );
  }
  if (items.length < 2) return null;
  return (
    <nav
      className="turn-navigation"
      aria-label="对话导航"
      ref={frame}
      onPointerEnter={() => {
        setPointerInside(true);
      }}
      onPointerLeave={() => {
        setPointerInside(false);
        setPreview(null);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPreview(null);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(
          rail.current!.querySelectorAll<HTMLButtonElement>('[data-turn-mark]'),
        );
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        event.preventDefault();
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : Math.max(
                  0,
                  Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)),
                );
        buttons[next]?.focus();
      }}
    >
      <div
        className="turn-navigation-rail"
        ref={rail}
        onScroll={(event) => {
          if (!preview || !previewAnchor.current) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const rect = previewAnchor.current.getBoundingClientRect();
          if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) setPreview(null);
          else show(previewAnchor.current.dataset.turnMark!, previewAnchor.current);
        }}
      >
        {hasEarlier && (
          <button
            type="button"
            className="turn-load-earlier"
            aria-label="导航加载更早记录"
            disabled={loadingEarlier}
            onClick={loadEarlier}
          >
            ···
          </button>
        )}
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            className="turn-mark"
            data-turn-mark={item.id}
            data-wave-distance={preview ? Math.min(4, Math.abs(index - peakIndex)) : undefined}
            data-bookmarked={bookmarks.has(item.id) || undefined}
            aria-label={`跳转到第 ${index + 1} 条消息`}
            aria-current={active === item.id ? 'true' : undefined}
            aria-describedby={preview?.id === item.id ? tooltipId : undefined}
            tabIndex={active === item.id || (!active && index === 0) ? 0 : -1}
            onPointerEnter={(event) => show(item.id, event.currentTarget)}
            onFocus={(event) => show(item.id, event.currentTarget)}
            onClick={() => navigate(item.id)}
          >
            <span />
          </button>
        ))}
      </div>
      {turn && preview && (
        <div className="turn-preview" id={tooltipId} style={{ top: preview.top }}>
          <div className="turn-preview-heading">
            <strong>{splitAttachmentMessage(turn.question!.text).text || '附件消息'}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label={bookmarkedMessages.includes(turn.id) ? '取消消息书签' : '添加消息书签'}
              aria-pressed={bookmarkedMessages.includes(turn.id)}
              onClick={() =>
                setPrefs((prefs) => ({
                  ...prefs,
                  bookmarkedMessages: toggled(prefs.bookmarkedMessages, turn.id),
                }))
              }
            >
              <Bookmark />
            </button>
          </div>
          <p>
            {turn.answer?.text ||
              turn.steps.flatMap((step) => (step.kind === 'assistant' ? [step.text] : [])).at(-1) ||
              (turn.outcome === 'failed'
                ? '本轮处理失败'
                : turn.endedAt
                  ? '本轮没有文字回复'
                  : '正在处理…')}
          </p>
        </div>
      )}
    </nav>
  );
}
