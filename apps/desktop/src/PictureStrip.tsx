import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { madeThumbnail, pictureSize, pictureUrl, thumbnail } from './pictures.ts';
import type { Thumbnail, ToolPicture } from './pictures.ts';
import { openPictures } from './PictureViewer.tsx';
import type { PictureEntry } from './PictureViewer.tsx';

// The pictures of the turn a line belongs to, so that a picture opened from any line pages through the whole turn.
export const TurnPictures = createContext<{ key: string; entries: PictureEntry[] } | null>(null);

// Opens a picture of `pictures` in the viewer, among the turn's pictures where the line knows its turn.
function useOpen(pictures: ToolPicture[]) {
  const turn = useContext(TurnPictures);
  return (picture: ToolPicture) => {
    const at = turn ? turn.entries.findIndex((entry) => entry.picture === picture) : -1;
    if (turn && at >= 0) openPictures(turn.key, turn.entries, at);
    else
      openPictures(
        'loose',
        pictures.map((item) => ({ picture: item, step: 0 })),
        pictures.indexOf(picture),
      );
  };
}

// A picture's small copy (pictures.ts), once made; until then its place is kept at its own proportions.
function useThumbnail(picture: ToolPicture) {
  const [made, setMade] = useState<Thumbnail | null>(() => madeThumbnail(picture));
  useEffect(() => {
    if (made && made === madeThumbnail(picture)) return;
    let live = true;
    setMade(madeThumbnail(picture));
    thumbnail(picture).then(
      (value) => live && setMade(value),
      // Where no copy can be made, the picture itself stands in.
      () =>
        live &&
        setMade({ url: pictureUrl(picture), ...(pictureSize(picture) ?? { width: 4, height: 3 }) }),
    );
    return () => {
      live = false;
    };
  }, [picture]);
  return made;
}
const ratioOf = (picture: ToolPicture, made: Thumbnail | null) => {
  const size = made ?? pictureSize(picture);
  return size ? size.width / size.height : 4 / 3;
};
// A row's thumbnail is 64px high and as wide as its picture's proportions, within these bounds.
const rowHeight = 64;
const rowWidth = (ratio: number) => Math.round(Math.min(114, Math.max(44, rowHeight * ratio)));

// Pictures that have stood in a line already: only one shown for the first time fades in, not every picture of a
// line that is drawn again, as a step that is folded and unfolded is.
const seen = new WeakSet<ToolPicture>();
function useFresh(shown: ToolPicture[]) {
  // Which pictures this line showed first: they keep fading in however often it is drawn while they do.
  const firstHere = useRef(new WeakSet<ToolPicture>()).current;
  for (const picture of shown) if (!seen.has(picture)) firstHere.add(picture);
  useEffect(() => {
    for (const picture of shown) seen.add(picture);
  });
  return (picture: ToolPicture) => firstHere.has(picture);
}

// A group of thumbnails is one stop of the Tab key; the arrow keys, Home and End move within it.
function roving(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, at + (event.key === 'ArrowLeft' ? -1 : 1)));
  event.preventDefault();
  event.stopPropagation();
  buttons[next].focus();
}
function rove(event: React.FocusEvent<HTMLElement>) {
  if (!(event.target instanceof HTMLButtonElement)) return;
  for (const button of event.currentTarget.querySelectorAll('button'))
    button.tabIndex = button === event.target ? 0 : -1;
}

function Thumb({
  picture,
  label,
  fresh,
  height,
  square,
  first,
  onOpen,
  onPointerEnter,
  onPointerLeave,
}: {
  picture: ToolPicture;
  label: string;
  fresh: boolean;
  height: number;
  square?: boolean;
  first: boolean;
  onOpen: (event: MouseEvent) => void;
  onPointerEnter?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: () => void;
}) {
  const made = useThumbnail(picture);
  const width = square ? height : rowWidth(ratioOf(picture, made));
  return (
    <button
      type="button"
      className={`picture-thumb${fresh ? ' fresh' : ''}${made ? '' : ' pending'}`}
      aria-label={label}
      tabIndex={first ? 0 : -1}
      style={square ? undefined : { width, height }}
      onClick={onOpen}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {made && <img src={made.url} alt="" decoding="async" draggable={false} />}
    </button>
  );
}

// How many of the latest pictures stand at the end of a line; the earlier ones are counted after them. A narrow
// conversation keeps only the latest.
const latest = 3;
const narrowWidth = 520;

// The width of the conversation a line stands in, for every line through one observer. Measured, not queried by
// the stylesheet: a size container on the conversation keeps the browser from holding the reader's place while
// earlier history is put in above it.
const widths = new Map<Element, Set<(width: number) => void>>();
let sizes: ResizeObserver | null = null;
function watchWidth(element: Element, listener: (width: number) => void) {
  sizes ??= new ResizeObserver((records) => {
    for (const record of records)
      widths.get(record.target)?.forEach((notify) => notify(record.contentRect.width));
  });
  let listeners = widths.get(element);
  if (!listeners) {
    widths.set(element, (listeners = new Set()));
    sizes.observe(element);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (!listeners!.size) {
      widths.delete(element);
      sizes!.unobserve(element);
    }
  };
}
function useNarrow(line: React.RefObject<HTMLElement | null>) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const conversation = line.current?.closest('.transcript');
    if (!conversation) return;
    setNarrow(conversation.clientWidth < narrowWidth);
    return watchWidth(conversation, (width) => setNarrow(width < narrowWidth));
  }, [line]);
  return narrow;
}
// The larger look's picture at most (style.css), and the room kept around it.
const peekHeight = 232;
const margin = 8;
const keep = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

// The pictures of a step or a turn, as small thumbnails at the end of its folded line: they take no height of their
// own, and arrive as the step takes them. A narrow conversation keeps only the latest. Under the pointer one shows
// larger beside the line; a click opens the viewer. Inside a heading that folds, they never fold or unfold it.
export function PictureStrip({ pictures, label }: { pictures: ToolPicture[]; label: string }) {
  const [peek, setPeek] = useState<{ picture: ToolPicture; box: DOMRect } | null>(null);
  const open = useOpen(pictures);
  const line = useRef<HTMLSpanElement>(null);
  const narrow = useNarrow(line);
  const offset = Math.max(0, pictures.length - (narrow ? 1 : latest));
  const shown = pictures.slice(offset);
  const fresh = useFresh(shown);
  if (!pictures.length) return null;
  return (
    <span
      ref={line}
      className="picture-strip"
      role="group"
      aria-label={`${label}：${pictures.length} 张图片`}
      onClick={keep}
      onKeyDown={roving}
      onFocus={rove}
    >
      {shown.map((picture, at) => (
        <Thumb
          // The same picture keeps its place as later ones arrive.
          key={offset + at}
          picture={picture}
          label={`查看图片 ${offset + at + 1} / ${pictures.length}`}
          fresh={fresh(picture)}
          height={20}
          square
          first={at === 0}
          onOpen={(event) => {
            keep(event);
            setPeek(null);
            open(picture);
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse')
              setPeek({ picture, box: event.currentTarget.getBoundingClientRect() });
          }}
          onPointerLeave={() => setPeek(null)}
        />
      ))}
      {offset > 0 && (
        <button
          type="button"
          className="picture-more"
          aria-label={`查看全部 ${pictures.length} 张图片`}
          tabIndex={-1}
          onClick={(event) => {
            keep(event);
            open(pictures[0]);
          }}
        >
          +{offset}
        </button>
      )}
      {peek && createPortal(<PicturePeek picture={peek.picture} box={peek.box} />, document.body)}
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

// The pictures of an open step or a tool's output, as one row of 64px thumbnails under its line. However many
// there are, they keep to one row: those that do not fit are counted in a last tile that opens the first of them.
export function PictureRow({ pictures, label }: { pictures: ToolPicture[]; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const open = useOpen(pictures);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const gap = 6;
  const widths = pictures.map((picture) => rowWidth(ratioOf(picture, madeThumbnail(picture))));
  let fit = pictures.length;
  if (width) {
    const total = widths.reduce((sum, value) => sum + value + gap, -gap);
    if (total > width) {
      fit = 0;
      let used = 0;
      // Room for the counting tile.
      while (fit < widths.length && used + widths[fit] + gap + rowHeight <= width)
        used += widths[fit++] + gap;
      fit = Math.max(1, fit);
    }
  }
  const shown = pictures.slice(0, fit);
  const fresh = useFresh(shown);
  if (!pictures.length) return null;
  return (
    <div
      ref={row}
      className="picture-row"
      role="group"
      aria-label={`${label}：${pictures.length} 张图片`}
      onKeyDown={roving}
      onFocus={rove}
    >
      {shown.map((picture, at) => (
        <Thumb
          key={at}
          picture={picture}
          label={`查看图片 ${at + 1} / ${pictures.length}`}
          fresh={fresh(picture)}
          height={rowHeight}
          first={at === 0}
          onOpen={(event) => {
            keep(event);
            open(picture);
          }}
        />
      ))}
      {fit < pictures.length && (
        <button
          type="button"
          className="picture-row-more"
          aria-label={`查看其余 ${pictures.length - fit} 张图片`}
          tabIndex={-1}
          onClick={(event) => {
            keep(event);
            open(pictures[fit]);
          }}
        >
          +{pictures.length - fit}
        </button>
      )}
    </div>
  );
}

// While a run goes on, its latest pictures in one line at the end of its steps, above "正在执行…": seen as they are
// taken without unfolding anything. Its height is kept from the first picture on and it leaves with the run.
export function LivePictures({ turn, entries }: { turn: string; entries: PictureEntry[] }) {
  const pictures = entries.map((entry) => entry.picture);
  const offset = Math.max(0, pictures.length - 4);
  const shown = pictures.slice(offset);
  const fresh = useFresh(shown);
  if (!pictures.length) return null;
  const open = (picture: ToolPicture) =>
    openPictures(
      turn,
      entries,
      entries.findIndex((entry) => entry.picture === picture),
    );
  return (
    <div
      className="live-pictures"
      role="group"
      aria-label={`本轮最新图片：共 ${pictures.length} 张`}
      onKeyDown={roving}
      onFocus={rove}
    >
      {offset > 0 && (
        <button
          type="button"
          className="picture-row-more"
          aria-label={`查看本轮全部 ${pictures.length} 张图片`}
          tabIndex={-1}
          onClick={() => open(pictures[0])}
        >
          +{offset}
        </button>
      )}
      {shown.map((picture, at) => (
        <Thumb
          key={offset + at}
          picture={picture}
          label={`查看图片 ${offset + at + 1} / ${pictures.length}`}
          fresh={fresh(picture)}
          height={rowHeight}
          first={at === 0}
          onOpen={() => open(picture)}
        />
      ))}
    </div>
  );
}

export function TurnPicturesProvider({
  value,
  children,
}: {
  value: { key: string; entries: PictureEntry[] };
  children: ReactNode;
}) {
  return <TurnPictures.Provider value={value}>{children}</TurnPictures.Provider>;
}
