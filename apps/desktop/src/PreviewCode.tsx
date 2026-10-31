import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { FileCode } from './icons.tsx';
import { Button } from './ui.tsx';
import { CopyButton } from './copy.tsx';
import { codeLineStarts, codePosition, requestedLine } from './previewCode.ts';
import type { PreviewTab } from './preview.ts';
import './PreviewCode.css';

type Mark = { line: number; top: number; height: number };

export default function PreviewCode({
  text,
  language,
  wrap,
  setWrap,
  navigation,
  onNavigated,
  root,
  captureReading,
  beforeNavigate,
}: {
  text: string;
  language: string;
  wrap: boolean;
  setWrap: (value: boolean) => void;
  navigation?: PreviewTab['navigation'];
  onNavigated: (request: string) => void;
  root: RefObject<HTMLDivElement | null>;
  captureReading: () => void;
  beforeNavigate: () => void;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const source = useRef<HTMLElement>(null);
  const starts = useMemo(() => codeLineStarts(text), [text]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [line, setLine] = useState('');
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState<Mark>();
  const targetLine = useRef<number | undefined>(undefined);
  const consumed = useRef<string | undefined>(undefined);
  const schedule = useRef(() => {});
  const position = (row: number, column?: number) => codePosition(text, row, column, starts);
  useLayoutEffect(() => {
    const element = pre.current!,
      code = source.current!,
      box = root.current ?? element.closest<HTMLDivElement>('.preview-document');
    if (!box) return;
    const win = element.ownerDocument.defaultView!;
    let frame = 0,
      disposed = false;
    const rectAt = (row: number, whole = false) => {
      const value = position(row);
      const node = code.firstChild;
      if (!node) {
        const style = win.getComputedStyle(element);
        return {
          top: element.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0),
          height: parseFloat(style.lineHeight) || 22,
        };
      }
      const range = element.ownerDocument.createRange();
      if (value.start === text.length && text.endsWith('\n')) {
        range.setStart(node, text.length - 1);
        range.setEnd(node, text.length);
        const last = range.getBoundingClientRect();
        const height = parseFloat(win.getComputedStyle(element).lineHeight) || 22;
        return { top: last.top + height, height };
      }
      range.setStart(node, value.start);
      range.setEnd(node, whole ? value.end : Math.min(text.length, value.start + 1));
      return whole
        ? range.getBoundingClientRect()
        : (range.getClientRects()[0] ?? range.getBoundingClientRect());
    };
    const update = () => {
      frame = 0;
      if (disposed || !element.clientWidth || !box.clientHeight) return;
      const area = box.getBoundingClientRect(),
        origin = element.getBoundingClientRect();
      const style = win.getComputedStyle(element);
      const lineHeight = parseFloat(style.lineHeight) || 22;
      const padding = parseFloat(style.paddingTop) || 0;
      // A source paragraph is a single text node. Find only the first visible source line,
      // then create the viewport's gutter; large files never allocate a row per source line.
      let low = 1,
        high = starts.length;
      if (!wrap)
        low = Math.max(
          1,
          Math.min(starts.length, Math.floor((area.top - origin.top - padding) / lineHeight) + 1),
        );
      while (wrap && low < high) {
        const middle = Math.ceil((low + high) / 2);
        const rect = rectAt(middle);
        if (rect && rect.top <= area.top) low = middle;
        else high = middle - 1;
      }
      const next: Mark[] = [];
      for (let row = Math.max(1, low - 2); row <= starts.length && next.length < 256; row++) {
        const rect = wrap ? rectAt(row) : { top: origin.top + padding + (row - 1) * lineHeight };
        if (!rect) continue;
        if (rect.top > area.bottom + lineHeight * 2) break;
        next.push({ line: row, top: rect.top - origin.top, height: lineHeight });
      }
      setMarks((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
      const target = targetLine.current;
      if (target) {
        const value = position(target);
        const first = wrap
          ? rectAt(value.line)
          : { top: origin.top + padding + (value.line - 1) * lineHeight };
        const whole = wrap ? rectAt(value.line, true) : { height: lineHeight };
        if (first && whole)
          setHighlight({
            line: value.line,
            top: first.top - origin.top,
            height: Math.max(lineHeight, whole.height),
          });
      }
    };
    const enqueue = () => {
      if (!frame) frame = win.requestAnimationFrame(update);
    };
    schedule.current = enqueue;
    const observer = new ResizeObserver(enqueue);
    observer.observe(element);
    observer.observe(box);
    box.addEventListener('scroll', enqueue, { passive: true });
    element.addEventListener('scroll', enqueue, { passive: true });
    void element.ownerDocument.fonts.ready.then(() => {
      if (!disposed) enqueue();
    });
    update();
    return () => {
      disposed = true;
      win.cancelAnimationFrame(frame);
      observer.disconnect();
      box.removeEventListener('scroll', enqueue);
      element.removeEventListener('scroll', enqueue);
      if (schedule.current === enqueue) schedule.current = () => {};
    };
  }, [text, starts, wrap, root]);

  const go = (row: number, column?: number) => {
    const element = pre.current!,
      box = root.current!,
      node = source.current?.firstChild;
    if (!node) {
      beforeNavigate();
      const top =
        parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).paddingTop) || 0;
      targetLine.current = 1;
      setLine('1');
      setError('');
      setHighlight({
        line: 1,
        top,
        height:
          parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).lineHeight) || 22,
      });
      box.scrollTop = 0;
      return;
    }
    const value = position(row, column);
    // Explicit navigation supersedes a pending passive reading restore, without taking focus.
    beforeNavigate();
    box.dispatchEvent(
      new element.ownerDocument.defaultView!.WheelEvent('wheel', { bubbles: false }),
    );
    const range = element.ownerDocument.createRange();
    range.setStart(node, value.offset);
    range.setEnd(node, Math.min(text.length, value.offset + 1));
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    let rect = wrap
      ? (range.getClientRects()[0] ?? range.getBoundingClientRect())
      : {
          top:
            element.getBoundingClientRect().top +
            (parseFloat(style.paddingTop) || 0) +
            (value.line - 1) * lineHeight,
        };
    if (wrap && value.start === text.length) {
      if (text.length) {
        range.setStart(node, text.length - 1);
        range.setEnd(node, text.length);
        rect = { ...rect, top: range.getBoundingClientRect().top + lineHeight };
      } else
        rect = {
          ...rect,
          top: element.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0),
        };
    }
    const viewport = box.getBoundingClientRect();
    box.scrollTop += rect.top - viewport.top - viewport.height / 2;
    if (!wrap) {
      element.scrollLeft = 0;
      if (column && column > 1) {
        range.setStart(node, value.offset);
        range.setEnd(node, Math.min(text.length, value.offset + 1));
        element.scrollLeft = Math.max(
          0,
          range.getBoundingClientRect().left - element.getBoundingClientRect().left - 70,
        );
      }
    }
    captureReading();
    targetLine.current = value.line;
    setLine(String(value.line));
    setError('');
    const first = codePosition(text, value.line, 1, starts);
    range.setStart(node, first.start);
    range.setEnd(node, first.end);
    let whole = range.getBoundingClientRect();
    const terminal = value.start === text.length && text.endsWith('\n');
    if (terminal) {
      range.setStart(node, text.length - 1);
      range.setEnd(node, text.length);
      whole = range.getBoundingClientRect();
    }
    setHighlight({
      line: value.line,
      top: wrap
        ? whole.top + (terminal ? lineHeight : 0) - element.getBoundingClientRect().top
        : (parseFloat(style.paddingTop) || 0) + (value.line - 1) * lineHeight,
      height: wrap ? Math.max(lineHeight, whole.height) : lineHeight,
    });
    schedule.current();
  };
  const navigateCurrent = useRef(go);
  navigateCurrent.current = go;
  useLayoutEffect(() => {
    if (!navigation || consumed.current === navigation.id) return;
    const win = pre.current!.ownerDocument.defaultView!;
    // The parent's layout hook must first bind the source-mode reading callbacks.
    // A moved/closed view cancels this explicit intent instead of replaying it later.
    const frame = win.requestAnimationFrame(() => {
      consumed.current = navigation.id;
      navigateCurrent.current(navigation.line, navigation.column);
      onNavigated(navigation.id);
    });
    return () => win.cancelAnimationFrame(frame);
  }, [navigation?.id, text]);

  return (
    <div className="code-block preview-code-block">
      <div className="code-header preview-code-header">
        <span className="code-language">
          <FileCode />
          {language}
        </span>
        <div className="code-actions preview-code-actions">
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={wrap}
            onClick={() => {
              captureReading();
              setWrap(!wrap);
            }}
          >
            自动换行
          </Button>
          <form
            className="preview-code-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const target = requestedLine(line);
              if (!target) {
                setError('请输入有效的正整数行号');
                return;
              }
              go(target);
            }}
          >
            <input
              aria-label="跳转到行"
              inputMode="numeric"
              placeholder="行号"
              value={line}
              aria-invalid={!!error}
              onChange={(event) => {
                setLine(event.target.value);
                setError('');
              }}
            />
            <Button size="sm" variant="ghost" type="submit">
              跳转
            </Button>
          </form>
          <CopyButton text={text} label="复制代码" variant="code" />
        </div>
      </div>
      {error && (
        <p className="preview-code-error" role="status">
          {error}
        </p>
      )}
      <div
        className="preview-code-body"
        style={
          {
            '--preview-line-digits': String(starts.length).length,
            '--preview-code-line-count': starts.length,
          } as CSSProperties
        }
      >
        <pre
          ref={pre}
          className={`preview-code-lines${wrap ? ' wraps' : ''}${text.endsWith('\n') || !text ? ' terminal-line' : ''}`}
          tabIndex={0}
          aria-label="代码预览"
        >
          <code ref={source}>{text}</code>
        </pre>
        <div className="preview-code-gutter" aria-hidden="true">
          {marks.map((mark) => (
            <span
              className="preview-line-number"
              data-line={mark.line}
              aria-hidden="true"
              key={mark.line}
              style={{ top: mark.top, height: mark.height }}
            >
              {mark.line}
            </span>
          ))}
        </div>
        {highlight && (
          <div
            className="preview-code-highlight"
            data-line={highlight.line}
            aria-hidden="true"
            style={{ top: highlight.top, height: highlight.height }}
          />
        )}
      </div>
    </div>
  );
}
