import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ChevronLeft, ChevronRight } from './icons.tsx';
import { Modal } from './ui.tsx';
import { pictureUrl } from './pictures.ts';
import type { ToolPicture } from './pictures.ts';

// How many of the latest pictures stand in the line; the earlier ones are counted before them.
const latest = 3;
// The larger look's picture at most (style.css), and the room kept around it.
const peekHeight = 232;
const margin = 8;

// The viewer stands on its own, outside every conversation: a picture opened from a step's line stays open when
// that line goes away (the run finishing folds its steps into the turn's line, a step unfolds, a search opens it),
// and every conversation of the window shares the one viewer.
let outlet: Root | null = null;
let opened = 0;
function showPictures(pictures: ToolPicture[], index: number) {
  if (!outlet) {
    const place = document.createElement('div');
    place.dataset.pictureViewer = '';
    document.body.append(place);
    outlet = createRoot(place);
  }
  const root = outlet;
  root.render(
    <PictureViewer
      key={++opened}
      pictures={pictures}
      start={index}
      onClose={() => root.render(null)}
    />,
  );
}
// Pictures that have stood in a line already: only one shown for the first time fades in, not every picture of a
// line that is drawn again, as a step that is folded and unfolded is.
const seen = new WeakSet<ToolPicture>();

// The pictures a step looked at, as a few small thumbnails at the end of its heading: no line of their own, and
// they arrive as the step takes them. Under the pointer one shows larger beside the line without moving anything;
// a click opens them all, one at a time. Inside a heading that folds, using them does not fold or unfold it.
export function PictureStrip({ pictures, label }: { pictures: ToolPicture[]; label: string }) {
  const [peek, setPeek] = useState<{ index: number; box: DOMRect } | null>(null);
  const offset = Math.max(0, pictures.length - latest);
  const shown = pictures.slice(offset);
  // Which pictures this line showed for the first time: they keep fading in however often the line is drawn while
  // they do, and the line's other pictures never start to.
  const firstHere = useRef(new WeakSet<ToolPicture>()).current;
  for (const picture of shown) if (!seen.has(picture)) firstHere.add(picture);
  const fresh = shown.map((picture) => firstHere.has(picture));
  useEffect(() => {
    for (const picture of shown) seen.add(picture);
  });
  if (!pictures.length) return null;
  const keep = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const open = (index: number) => (event: MouseEvent) => {
    keep(event);
    setPeek(null);
    showPictures(pictures, index);
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
      {shown.map((picture, at) => {
        const index = offset + at;
        return (
          <button
            // The same picture keeps its place as later ones arrive.
            key={index}
            type="button"
            className={`picture-thumb${fresh[at] ? ' fresh' : ''}`}
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
    </span>
  );
}

// The larger look under the pointer, as wide as the picture needs up to its limit: centred on the thumbnail,
// above it where there is room and else on the roomier side, shrunk to fit there, and kept inside the window. It
// shows once its picture is loaded and its size is known, so no empty frame flashes first.
function PicturePeek({ picture, box }: { picture: ToolPicture; box: DOMRect }) {
  const card = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  const room = { above: box.top - margin * 3, below: window.innerHeight - box.bottom - margin * 3 };
  const above = room.above >= peekHeight + margin || room.above > room.below;
  const height = Math.max(40, Math.min(peekHeight, (above ? room.above : room.below) - margin));
  const place = () => {
    const width = card.current?.offsetWidth;
    if (!width || !image.current?.naturalWidth) return;
    const centred = box.left + box.width / 2 - width / 2;
    setLeft(Math.min(Math.max(margin, centred), window.innerWidth - width - margin));
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
        ...(above
          ? { bottom: window.innerHeight - box.top + margin }
          : { top: box.bottom + margin }),
      }}
    >
      <img
        ref={image}
        src={pictureUrl(picture)}
        alt=""
        style={{ maxHeight: height }}
        onLoad={place}
      />
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
