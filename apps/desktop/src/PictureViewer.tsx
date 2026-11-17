import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { ChevronLeft, ChevronRight, Copy, Download, Minus, Plus, X } from './icons.tsx';
import { madeThumbnail, pictureBlob, pictureSize, pictureUrl, thumbnail } from './pictures.ts';
import type { Thumbnail, ToolPicture } from './pictures.ts';

// A picture of a turn and the step that took it (1 for the turn's first step of work).
export type PictureEntry = { picture: ToolPicture; step: number };
type Opened = {
  key: string;
  entries: PictureEntry[];
  index: number;
  // How many pictures the turn had when the viewer opened: later ones are new.
  known: number;
  opener: HTMLElement | null;
  generation: number;
};

// The viewer stands on its own, outside every conversation, and the window has one: a picture opened from a step's
// line stays open when that line goes away (the run finishing folds its steps, a search opens them), and pictures
// the turn takes while it is open are added to it.
let opened: Opened | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let outlet: Root | null = null;

export function openPictures(key: string, entries: PictureEntry[], index: number) {
  if (!entries.length) return;
  opened = {
    key,
    entries,
    index: Math.min(Math.max(0, index), entries.length - 1),
    known: entries.length,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    generation: ++generation,
  };
  if (!outlet) {
    const place = document.createElement('div');
    place.dataset.pictureViewer = '';
    document.body.append(place);
    outlet = createRoot(place);
    outlet.render(<ViewerOutlet />);
  }
  emit();
}
// The turn's pictures as they now are; the viewer of that turn, if open, takes up the new ones.
export function updatePictures(key: string, entries: PictureEntry[]) {
  if (!opened || opened.key !== key || opened.entries === entries) return;
  if (entries.length < opened.entries.length) return;
  opened = { ...opened, entries };
  emit();
}
function closePictures() {
  const opener = opened?.opener;
  opened = null;
  emit();
  // Once the modal viewer has left the page: while it is open, everything outside it is inert and takes no focus.
  // Where the line it was opened from has gone (the live line leaves with the run), the message box has it.
  setTimeout(() => {
    if (opener?.isConnected) opener.focus();
    else document.querySelector<HTMLElement>('textarea[aria-label="消息"]')?.focus();
  });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function ViewerOutlet() {
  const state = useSyncExternalStore(subscribe, () => opened);
  return state ? <PictureViewer key={state.generation} state={state} /> : null;
}

// The picture's bytes as PNG, which is what a clipboard takes.
async function pngOf(picture: ToolPicture) {
  let blob = pictureBlob(picture);
  if (blob.type !== 'image/png') {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  return blob;
}
// The desktop window copies through its main process, whose clipboard it may use; a browser asks its own.
async function copyPicture(picture: ToolPicture) {
  const png = await pngOf(picture);
  if (window.desktop?.copyImage)
    await window.desktop.copyImage(new Uint8Array(await png.arrayBuffer()));
  else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

const MIN = 0.05;
const MAX = 8;
const clampScale = (value: number) => Math.min(MAX, Math.max(MIN, value));
// `auto` is fit, or across its width for a tall page; `fit` and `width` are those chosen; `actual` is 100%; `scale`
// is any other zoom. Paging keeps the first three and returns the last two to `auto`.
type Mode = 'auto' | 'fit' | 'width' | 'actual' | 'scale';
type Size = { width: number; height: number };
// A tall page, as a document page is, is read across its width from the top; anything else is seen whole.
const isPage = (size: Size) => size.height >= size.width * 1.25;

// A film's thumbnail is made once it scrolls into view: a turn of hundreds of screenshots does not make them all.
function FilmThumb({
  entry,
  index,
  current,
  stepStart,
  select,
}: {
  entry: PictureEntry;
  index: number;
  current: boolean;
  stepStart: boolean;
  select: (index: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [made, setMade] = useState<Thumbnail | null>(() => madeThumbnail(entry.picture));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (made) return;
    const element = button.current!;
    let live = true;
    const seen = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        seen.disconnect();
        thumbnail(entry.picture).then(
          (value) => live && setMade(value),
          () => live && setFailed(true),
        );
      },
      { root: element.parentElement, rootMargin: '0px 200px' },
    );
    seen.observe(element);
    return () => {
      live = false;
      seen.disconnect();
    };
  }, [entry.picture, made]);
  useEffect(() => {
    if (current) button.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);
  const size = made ?? pictureSize(entry.picture);
  const ratio = size ? size.width / size.height : 4 / 3;
  const width = Math.round(Math.min(86, Math.max(32, 48 * ratio)));
  return (
    <button
      ref={button}
      type="button"
      className={`viewer-film-thumb${stepStart ? ' step-start' : ''}${failed ? ' failed' : ''}`}
      aria-label={`图片 ${index + 1}，第 ${entry.step} 步`}
      aria-current={current || undefined}
      style={{ width }}
      onClick={() => select(index)}
    >
      {made && <img src={made.url} alt="" draggable={false} />}
    </button>
  );
}

function PictureViewer({ state }: { state: Opened }) {
  const { entries } = state;
  const count = entries.length;
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(state.index);
  const [known, setKnown] = useState(state.known);
  const [mode, setMode] = useState<Mode>('auto');
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const [stageSize, setStageSize] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [broken, setBroken] = useState(false);
  const [note, setNote] = useState('');
  const drag = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
    dark: boolean;
  } | null>(null);
  const preloaded = useRef<HTMLImageElement[]>([]);
  const entry = entries[Math.min(index, count - 1)];
  const picture = entry.picture;
  const url = pictureUrl(picture);

  useLayoutEffect(() => {
    dialog.current?.showModal();
    // The viewer opens on the picture, not on its first button: the keys work from here, and Enter copies nothing.
    stage.current?.focus();
  }, []);
  useLayoutEffect(() => {
    const element = stage.current!;
    const measure = () =>
      setStageSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A new picture: its size from its header until it loads, and the view from its top.
  useLayoutEffect(() => {
    setNatural(pictureSize(picture));
    setBroken(false);
    setOffset(null);
  }, [picture]);
  // The neighbours are decoded ahead, and held until the next page, so paging does not wait for them.
  useEffect(() => {
    preloaded.current = [index - 1, index + 1]
      .filter((near) => near >= 0 && near < count)
      .map((near) => {
        const image = new Image();
        image.src = pictureUrl(entries[near].picture);
        image.decode?.().catch(() => {});
        return image;
      });
  }, [index, count, entries]);
  useEffect(() => {
    if (index >= known) setKnown(count);
  }, [index, known, count]);

  const size = natural ?? { width: 4, height: 3 };
  const room = {
    width: Math.max(1, stageSize.width - 112),
    height: Math.max(1, stageSize.height - 32),
  };
  const fitScale = Math.min(room.width / size.width, room.height / size.height, 1);
  // Across its width, but never enlarged past its own size, which would only blur it; zoom is there for that.
  const widthScale = Math.min(room.width / size.width, 1);
  const effective: Exclude<Mode, 'auto'> =
    mode === 'auto' ? (isPage(size) ? 'width' : 'fit') : mode;
  const s =
    effective === 'fit'
      ? fitScale
      : effective === 'width'
        ? widthScale
        : effective === 'actual'
          ? 1
          : clampScale(scale);
  const W = size.width * s;
  const H = size.height * s;
  const centred = { x: (stageSize.width - W) / 2, y: (stageSize.height - H) / 2 };
  const top = H > stageSize.height ? 0 : centred.y;
  const bound = (value: number, length: number, extent: number, centre: number) =>
    length <= extent ? centre : Math.min(0, Math.max(extent - length, value));
  const x = bound(offset?.x ?? centred.x, W, stageSize.width, centred.x);
  const y = bound(offset?.y ?? top, H, stageSize.height, centred.y);
  const overflows = W > stageSize.width + 0.5 || H > stageSize.height + 0.5;
  // Until it loads, a picture whose header gave no size is not drawn at a guessed one.
  const sized = natural !== null;

  const go = (next: number) => {
    const target = Math.min(count - 1, Math.max(0, next));
    if (target === index) return;
    setIndex(target);
    // A zoom chosen for one picture is not right for the next; fit and fit-width are a way of seeing, and stay.
    if (mode === 'scale' || mode === 'actual') setMode('auto');
    setOffset(null);
  };
  // Zooms to `next`, keeping the point (px, py) of the stage where it is.
  const zoom = (next: number, px = stageSize.width / 2, py = stageSize.height / 2) => {
    const to = clampScale(next);
    const u = (px - x) / s;
    const v = (py - y) / s;
    setMode('scale');
    setScale(to);
    setOffset({ x: px - u * to, y: py - v * to });
  };
  const reset = () => {
    setMode('auto');
    setOffset(null);
  };
  const actual = (px?: number, py?: number) => {
    zoom(1, px, py);
    setMode('actual');
  };
  const copy = async () => {
    try {
      await copyPicture(picture);
      setNote('已复制图片');
    } catch {
      setNote('复制失败');
    }
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey) return;
      const k = event.key;
      // Ctrl with a key is the window's (Ctrl+= zooms the whole window), but Ctrl+C copies the picture.
      if (event.ctrlKey) {
        if (k === 'c' || k === 'C') {
          event.preventDefault();
          void copy();
        }
        return;
      }
      if (k === 'ArrowLeft') go(index - 1);
      else if (k === 'ArrowRight') go(index + 1);
      else if (k === 'Home') go(0);
      else if (k === 'End') go(count - 1);
      else if (k === '+' || k === '=') zoom(s * 1.25);
      else if (k === '-' || k === '_') zoom(s / 1.25);
      else if (k === '0') reset();
      else if (k === '1') actual();
      else if ((k === 'ArrowDown' || k === 'ArrowUp') && overflows)
        setOffset({ x, y: y + (k === 'ArrowDown' ? -80 : 80) });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  // The wheel zooms about the pointer while the picture fits, and scrolls it once it does not; with Ctrl it always
  // zooms, which is how a picture zoomed past the window is zoomed back.
  const wheel = (event: ReactWheelEvent) => {
    const box = stage.current!.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    if (event.ctrlKey || !overflows) zoom(s * Math.exp(-event.deltaY * 0.0015), px, py);
    else
      setOffset({
        x: x - (event.shiftKey ? event.deltaY : event.deltaX),
        y: y - (event.shiftKey ? 0 : event.deltaY),
      });
  };
  const down = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    // Where it went down decides whether a click closes: once the pointer is captured, every event lands on the
    // stage, the picture's as well.
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ox: x,
      oy: y,
      moved: false,
      dark: event.target === stage.current,
    };
    if (overflows) (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !overflows) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setOffset({ x: d.ox + dx, y: d.oy + dy });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    // A click on the dark around the picture closes; a drag, or a click on the picture, does not.
    if (d && !d.moved && d.dark) closePictures();
  };

  const extension = picture.type.split('/')[1] === 'jpeg' ? 'jpg' : picture.type.split('/')[1];
  const download = () => {
    const link = document.createElement('a');
    link.href = url;
    link.download = `图片-${index + 1}.${extension}`;
    link.click();
  };
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), 1800);
    return () => clearTimeout(timer);
  }, [note]);

  const fresh = count - known;
  return (
    <dialog
      ref={dialog}
      className="picture-viewer"
      aria-label="图片查看器"
      onCancel={(event) => {
        event.preventDefault();
        closePictures();
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="viewer-top">
        <span className="viewer-count" aria-live="polite">
          {`${index + 1} / ${count}`}
          {entry.step > 0 && ` · 第 ${entry.step} 步`}
        </span>
        {fresh > 0 && (
          <button type="button" className="viewer-new" onClick={() => go(known)}>
            有 {fresh} 张新图
          </button>
        )}
        <span className="viewer-actions">
          {note && (
            <span className="viewer-note" role="status">
              {note}
            </span>
          )}
          <button
            type="button"
            className="viewer-button"
            aria-label="复制图片"
            title="复制图片 (Ctrl+C)"
            disabled={broken}
            onClick={copy}
          >
            <Copy />
          </button>
          <button
            type="button"
            className="viewer-button"
            aria-label="下载图片"
            title="下载图片"
            onClick={download}
          >
            <Download />
          </button>
          <button
            type="button"
            className="viewer-button"
            aria-label="关闭"
            title="关闭 (Esc)"
            onClick={closePictures}
          >
            <X />
          </button>
        </span>
      </div>
      <div
        ref={stage}
        className={`viewer-stage${overflows ? ' pannable' : ''}`}
        tabIndex={-1}
        onWheel={wheel}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(event) => {
          if (broken) return;
          const box = stage.current!.getBoundingClientRect();
          if (effective === 'actual' || (effective === 'scale' && s >= 1)) reset();
          else actual(event.clientX - box.left, event.clientY - box.top);
        }}
      >
        {broken ? (
          <p className="viewer-broken" role="alert">
            图片无法显示
          </p>
        ) : (
          <img
            src={url}
            alt={`图片 ${index + 1}`}
            draggable={false}
            style={{
              left: x,
              top: y,
              width: W,
              height: H,
              visibility: sized ? undefined : 'hidden',
            }}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth && image.naturalHeight)
                setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            }}
            onError={() => setBroken(true)}
          />
        )}
        {count > 1 && (
          <>
            <button
              type="button"
              className="viewer-side previous"
              aria-label="上一张"
              disabled={index === 0}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => go(index - 1)}
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              className="viewer-side next"
              aria-label="下一张"
              disabled={index === count - 1}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => go(index + 1)}
            >
              <ChevronRight />
            </button>
          </>
        )}
      </div>
      <div className="viewer-zoom" role="group" aria-label="缩放" title="Ctrl + 滚轮缩放">
        <button
          type="button"
          className="viewer-button"
          aria-label="缩小"
          disabled={broken}
          onClick={() => zoom(s / 1.25)}
        >
          <Minus />
        </button>
        <button
          type="button"
          className="viewer-percent"
          title="恢复默认大小 (0)"
          disabled={broken}
          onClick={reset}
        >
          {Math.round(s * 100)}%
        </button>
        <button
          type="button"
          className="viewer-button"
          aria-label="放大"
          disabled={broken}
          onClick={() => zoom(s * 1.25)}
        >
          <Plus />
        </button>
      </div>
      {count > 1 && (
        <div className="viewer-film" role="group" aria-label="本轮图片">
          {entries.map((item, at) => (
            <FilmThumb
              key={at}
              entry={item}
              index={at}
              current={at === index}
              stepStart={at > 0 && entries[at - 1].step !== item.step}
              select={go}
            />
          ))}
        </div>
      )}
    </dialog>
  );
}
