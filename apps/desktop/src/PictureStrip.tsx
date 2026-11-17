import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  memo,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, ReactNode, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { Image as ImageIcon } from './icons.tsx';
import { madeThumbnail, pictureSize, pictureUrl, thumbnail } from './pictures.ts';
import type { Thumbnail, ToolPicture } from './pictures.ts';
import { openPictures } from './PictureViewer.tsx';
import type { PictureEntry } from './PictureViewer.tsx';

// The pictures of a step as the same array while they are the same: the step's items are made anew on every event
// of the session, and its lines, drawn again with an equal list, would draw their thumbnails again for nothing.
export function useSamePictures(next: ToolPicture[]) {
  const kept = useRef(next);
  if (
    kept.current !== next &&
    (kept.current.length !== next.length ||
      next.some((picture, at) => picture !== kept.current[at]))
  )
    kept.current = next;
  return kept.current;
}

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

// A picture's small copy (pictures.ts), once made; until then its place is kept at its own proportions. A picture
// that cannot be decoded shows that it cannot, never the picture's own address.
function useThumbnail(picture: ToolPicture, made?: (value: Thumbnail) => void) {
  const [state, setState] = useState<Thumbnail | 'failed' | null>(() => madeThumbnail(picture));
  useEffect(() => {
    const ready = madeThumbnail(picture);
    if (ready) {
      setState(ready);
      return;
    }
    let live = true;
    setState(null);
    thumbnail(picture).then(
      (value) => {
        if (!live) return;
        setState(value);
        made?.(value);
      },
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, [picture]);
  return state;
}
const ratioOf = (picture: ToolPicture) => {
  const size = madeThumbnail(picture) ?? pictureSize(picture);
  return size ? size.width / size.height : 4 / 3;
};
// A row's thumbnail is 64px high and as wide as its picture's proportions, within these bounds.
const rowHeight = 64;
const rowWidth = (picture: ToolPicture) =>
  Math.round(Math.min(114, Math.max(44, rowHeight * ratioOf(picture))));

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

// A group of thumbnails is one stop of the Tab key, the one last focused; the arrow keys, Home and End move within
// it. Should the focused one go (a narrower row, a newer picture in the live line), the stop and the focus move to
// one that stays, so the group is never left without a stop and the focus never drops to the page.
function useRove(count: number) {
  const [stop, setStop] = useState(0);
  const group = useRef<HTMLElement | null>(null);
  const inside = useRef(false);
  const at = Math.min(stop, Math.max(0, count - 1));
  // Stable, so that a group's element is not handed over again on every drawing.
  const ref = useCallback((element: HTMLElement | null) => {
    group.current = element;
  }, []);
  useLayoutEffect(() => {
    const element = group.current;
    if (!element || !inside.current || element.contains(document.activeElement)) return;
    element.querySelector<HTMLButtonElement>(`button[data-rove="${at}"]`)?.focus();
  });
  return {
    tab: (index: number) => (index === at ? 0 : -1),
    props: {
      ref,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        inside.current = true;
        const index = Number((event.target as HTMLElement).dataset.rove);
        if (Number.isInteger(index)) setStop(index);
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          inside.current = false;
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-rove]'),
        ].sort((a, b) => Number(a.dataset.rove) - Number(b.dataset.rove));
        const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (from < 0) return;
        const to =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : Math.min(
                  buttons.length - 1,
                  Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1)),
                );
        event.preventDefault();
        event.stopPropagation();
        buttons[to].focus();
      },
    },
  };
}

function Thumb({
  picture,
  label,
  fresh,
  square,
  rove,
  tabIndex,
  made,
  onOpen,
  onPointerEnter,
  onPointerLeave,
}: {
  picture: ToolPicture;
  label: string;
  fresh: boolean;
  square?: boolean;
  rove: number;
  tabIndex: number;
  made?: (value: Thumbnail) => void;
  onOpen: (event: MouseEvent) => void;
  onPointerEnter?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: () => void;
}) {
  const state = useThumbnail(picture, made);
  const ready = state && state !== 'failed' ? state : null;
  return (
    <button
      type="button"
      className={`picture-thumb${fresh ? ' fresh' : ''}${state ? '' : ' pending'}${state === 'failed' ? ' failed' : ''}`}
      aria-label={state === 'failed' ? `${label}（无法显示）` : label}
      data-rove={rove}
      tabIndex={tabIndex}
      style={square ? undefined : { width: rowWidth(picture), height: rowHeight }}
      onClick={onOpen}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {ready && <img src={ready.url} alt="" decoding="async" draggable={false} />}
      {state === 'failed' && <ImageIcon className="picture-failed" aria-hidden="true" />}
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
// Whether the line's conversation is narrow; measured from when the line is first on the page, whenever that is.
function useNarrow(line: HTMLElement | null) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const conversation = line?.closest('.transcript');
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
// own, and arrive as the step takes them. Under the pointer one shows larger beside the line; a click opens the
// viewer. Inside a heading that folds, they never fold or unfold it.
function PictureStripLine({ pictures, label }: { pictures: ToolPicture[]; label: string }) {
  const [peek, setPeek] = useState<{ picture: ToolPicture; box: DOMRect } | null>(null);
  const open = useOpen(pictures);
  const [line, setLine] = useState<HTMLSpanElement | null>(null);
  const narrow = useNarrow(line);
  const offset = Math.max(0, pictures.length - (narrow ? 1 : latest));
  const shown = pictures.slice(offset);
  const fresh = useFresh(shown);
  const rove = useRove(shown.length + (offset > 0 ? 1 : 0));
  const roveRef = rove.props.ref;
  const lineRef = useCallback(
    (element: HTMLSpanElement | null) => {
      setLine(element);
      roveRef(element);
    },
    [roveRef],
  );
  if (!pictures.length) return null;
  return (
    <span
      ref={lineRef}
      className="picture-strip"
      role="group"
      aria-label={`${label}：${pictures.length} 张图片`}
      onClick={keep}
      onKeyDown={rove.props.onKeyDown}
      onFocus={rove.props.onFocus}
      onBlur={rove.props.onBlur}
    >
      {shown.map((picture, at) => (
        <Thumb
          // The same picture keeps its place as later ones arrive.
          key={offset + at}
          picture={picture}
          label={`查看图片 ${offset + at + 1} / ${pictures.length}`}
          fresh={fresh(picture)}
          square
          rove={at}
          tabIndex={rove.tab(at)}
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
          data-rove={shown.length}
          tabIndex={rove.tab(shown.length)}
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
// shows once its picture is loaded and its size is known, so no empty frame flashes first. It shows the picture
// itself, which a thumbnail is too small for, and only while the pointer rests on one.
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
// Only the pictures that fit are drawn, so only their small copies are made, and none before the row is measured.
function PictureRowLine({ pictures, label }: { pictures: ToolPicture[]; label: string }) {
  const row = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // A copy made at other proportions than its header said changes the widths: the row is laid out again.
  const [, relayout] = useState(0);
  const open = useOpen(pictures);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const content = () => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    setWidth(content());
    const observer = new ResizeObserver(() => setWidth(content()));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const gap = 6;
  let fit = 0;
  if (width) {
    const widths = pictures.map(rowWidth);
    const total = widths.reduce((sum, value) => sum + value + gap, -gap);
    if (total <= width) fit = pictures.length;
    else {
      let used = 0;
      // Room for the counting tile.
      while (fit < widths.length && used + widths[fit] + gap + rowHeight <= width)
        used += widths[fit++] + gap;
      fit = Math.max(1, fit);
    }
  }
  const shown = pictures.slice(0, fit);
  const fresh = useFresh(shown);
  const rest = width ? pictures.length - fit : 0;
  const rove = useRove(shown.length + (rest ? 1 : 0));
  const roveRef = rove.props.ref;
  const rowRef = useCallback(
    (element: HTMLDivElement | null) => {
      row.current = element;
      roveRef(element);
    },
    [roveRef],
  );
  if (!pictures.length) return null;
  return (
    <div
      ref={rowRef}
      className="picture-row"
      role="group"
      aria-label={`${label}：${pictures.length} 张图片`}
      onKeyDown={rove.props.onKeyDown}
      onFocus={rove.props.onFocus}
      onBlur={rove.props.onBlur}
    >
      {shown.map((picture, at) => (
        <Thumb
          key={at}
          picture={picture}
          label={`查看图片 ${at + 1} / ${pictures.length}`}
          fresh={fresh(picture)}
          rove={at}
          tabIndex={rove.tab(at)}
          made={() => relayout((value) => value + 1)}
          onOpen={(event) => {
            keep(event);
            open(picture);
          }}
        />
      ))}
      {rest > 0 && (
        <button
          type="button"
          className="picture-row-more"
          aria-label={`查看其余 ${rest} 张图片`}
          data-rove={shown.length}
          tabIndex={rove.tab(shown.length)}
          onClick={(event) => {
            keep(event);
            open(pictures[fit]);
          }}
        >
          +{rest}
        </button>
      )}
    </div>
  );
}

// While a run goes on, its latest pictures in one line at the end of its steps, above "正在执行…": seen as they are
// taken without unfolding anything. Its height is kept from the first picture on and it leaves with the run.
function LivePicturesLine({ turn, entries }: { turn: string; entries: PictureEntry[] }) {
  const pictures = entries.map((entry) => entry.picture);
  const offset = Math.max(0, pictures.length - 4);
  const shown = pictures.slice(offset);
  const fresh = useFresh(shown);
  // The thumbnails keep their places in the group's order whether or not the counting tile stands before them; it
  // comes after them, for the keys as well as for the Tab stop.
  const rove = useRove(shown.length + (offset > 0 ? 1 : 0));
  if (!pictures.length) return null;
  const open = (picture: ToolPicture) =>
    openPictures(
      turn,
      entries,
      entries.findIndex((entry) => entry.picture === picture),
    );
  return (
    <div
      ref={rove.props.ref}
      className="live-pictures"
      role="group"
      aria-label={`本轮最新图片：共 ${pictures.length} 张`}
      onKeyDown={rove.props.onKeyDown}
      onFocus={rove.props.onFocus}
      onBlur={rove.props.onBlur}
    >
      {offset > 0 && (
        <button
          type="button"
          className="picture-row-more"
          aria-label={`查看本轮全部 ${pictures.length} 张图片`}
          data-rove={shown.length}
          tabIndex={rove.tab(shown.length)}
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
          rove={at}
          tabIndex={rove.tab(at)}
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

// Drawn again only when their pictures change, not on every event of the run.
export const PictureStrip = memo(PictureStripLine);
export const PictureRow = memo(PictureRowLine);
export const LivePictures = memo(LivePicturesLine);
