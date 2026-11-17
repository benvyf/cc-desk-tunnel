import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from './icons.tsx';
import { Modal } from './ui.tsx';
import { pictureUrl } from './pictures.ts';
import type { ToolPicture } from './pictures.ts';

// How many of the latest pictures stand in the line; the earlier ones are counted before them.
const latest = 3;
// The larger look's height at most (style.css), to tell whether it fits above its thumbnail.
const peekHeight = 240;

// The pictures a step looked at, as a few small thumbnails at the end of its heading: no line of their own, and
// they arrive as the step takes them. Under the pointer one shows larger beside the line without moving anything;
// a click opens them all, one at a time. Inside a heading that folds, using them does not fold or unfold it.
export function PictureStrip({ pictures, label }: { pictures: ToolPicture[]; label: string }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ index: number; box: DOMRect } | null>(null);
  if (!pictures.length) return null;
  const offset = Math.max(0, pictures.length - latest);
  const keep = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const open = (index: number) => (event: MouseEvent) => {
    keep(event);
    setPeek(null);
    setViewing(index);
  };
  return (
    <span
      className="picture-strip"
      role="group"
      aria-label={`${label}：${pictures.length} 张图片`}
      onClick={keep}
    >
      {offset > 0 && (
        <button
          type="button"
          className="picture-more"
          aria-label={`查看全部 ${pictures.length} 张图片`}
          onClick={open(0)}
        >
          +{offset}
        </button>
      )}
      {pictures.slice(offset).map((picture, at) => {
        const index = offset + at;
        return (
          <button
            // The same picture keeps its place as later ones arrive, so only a new one fades in.
            key={index}
            type="button"
            className="picture-thumb"
            aria-label={`查看图片 ${index + 1} / ${pictures.length}`}
            onClick={open(index)}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse')
                setPeek({ index, box: event.currentTarget.getBoundingClientRect() });
            }}
            onPointerLeave={() => setPeek(null)}
          >
            <img src={pictureUrl(picture)} alt="" decoding="async" draggable={false} />
          </button>
        );
      })}
      {peek &&
        createPortal(<PicturePeek picture={pictures[peek.index]} box={peek.box} />, document.body)}
      {viewing !== null &&
        createPortal(
          <PictureViewer pictures={pictures} start={viewing} onClose={() => setViewing(null)} />,
          document.body,
        )}
    </span>
  );
}

// The larger look under the pointer, as wide as the picture needs up to its limit: centred on the thumbnail,
// above it where there is room and else below, and kept inside the window. It is placed once its size is known.
function PicturePeek({ picture, box }: { picture: ToolPicture; box: DOMRect }) {
  const card = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  const above = box.top > peekHeight + 24;
  const place = () => {
    const width = card.current?.offsetWidth;
    if (!width) return;
    const centred = box.left + box.width / 2 - width / 2;
    setLeft(Math.min(Math.max(8, centred), window.innerWidth - width - 8));
  };
  useLayoutEffect(place, [box]);
  return (
    <div
      ref={card}
      className="picture-peek"
      aria-hidden="true"
      data-place={above ? 'above' : 'below'}
      style={{
        left: left ?? box.left,
        visibility: left === null ? 'hidden' : undefined,
        ...(above ? { bottom: window.innerHeight - box.top + 8 } : { top: box.bottom + 8 }),
      }}
    >
      {/* A large picture is only known to be large once loaded: it is placed again then. */}
      <img src={pictureUrl(picture)} alt="" onLoad={place} />
    </div>
  );
}
// All of a step's pictures, whole, one at a time: the arrows, or the left and right keys, go between them.
function PictureViewer({
  pictures,
  start,
  onClose,
}: {
  pictures: ToolPicture[];
  start: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const count = pictures.length;
  useEffect(() => {
    const move = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1));
      if (event.key === 'ArrowRight') setIndex((value) => Math.min(count - 1, value + 1));
    };
    window.addEventListener('keydown', move);
    return () => window.removeEventListener('keydown', move);
  }, [count]);
  return (
    <Modal title={count > 1 ? `图片 ${index + 1} / ${count}` : '图片'} onClose={onClose}>
      <div className="picture-view" onContextMenu={(event) => event.stopPropagation()}>
        <img src={pictureUrl(pictures[index])} alt={`图片 ${index + 1}`} />
      </div>
      {count > 1 && (
        <div className="picture-nav">
          <button
            type="button"
            className="icon-button"
            aria-label="上一张"
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
          >
            <ChevronLeft />
          </button>
          <span>
            {index + 1} / {count}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="下一张"
            disabled={index === count - 1}
            onClick={() => setIndex(index + 1)}
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </Modal>
  );
}
