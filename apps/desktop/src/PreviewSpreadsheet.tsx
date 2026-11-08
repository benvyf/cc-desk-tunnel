import { useEffect, useId, useRef, useState } from 'react';
import type { Spreadsheet } from './spreadsheet.ts';
import './PreviewSpreadsheet.css';

const rowHeight = 32;
function columnName(index: number) {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

export default function PreviewSpreadsheet({ data, format }: { data: string; format: string }) {
  const [loaded, setLoaded] = useState<{
    source: string;
    format: string;
    book?: Spreadsheet;
    error?: string;
  } | null>(null);
  const [active, setActive] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const scroll = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const fail = (error: string) => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      worker?.terminate();
      setLoaded({ source: data, format, error });
    };
    try {
      if (data.length > 28 * 1024 * 1024) throw new Error('表格超过 20 MiB 预览大小限制。');
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      worker = new Worker(new URL('./spreadsheet.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ book?: Spreadsheet; error?: string }>) => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        worker?.terminate();
        setActive(0);
        setLoaded({ source: data, format, ...event.data });
        setViewport((old) => ({ ...old, top: 0 }));
        if (scroll.current) scroll.current.scrollTop = 0;
      };
      worker.onerror = () => fail('无法读取表格，请刷新重试或在系统应用中打开。');
      timer = setTimeout(() => fail('表格解析超时，请在系统应用中打开。'), 15000);
      worker.postMessage({ bytes: bytes.buffer, format }, [bytes.buffer]);
    } catch (error) {
      fail(error instanceof Error ? error.message : '无法读取表格。');
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [data, format]);
  const book = loaded?.source === data && loaded.format === format ? loaded.book : undefined;
  const error = loaded?.source === data && loaded.format === format ? loaded.error : undefined;
  const sheet = book?.sheets[active];
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const resize = new ResizeObserver(() =>
      setViewport({ top: element.scrollTop, height: element.clientHeight }),
    );
    resize.observe(element);
    return () => resize.disconnect();
  }, [book]);
  if (error)
    return (
      <p role="alert" className="preview-error">
        {error}
      </p>
    );
  if (!sheet)
    return (
      <p role="status" className="preview-loading">
        正在读取表格…
      </p>
    );
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - 4);
  const end = Math.min(sheet.rows.length, start + Math.ceil(viewport.height / rowHeight) + 10);
  const columns = Array.from({ length: sheet.columns }, (_, index) => index);
  return (
    <section className="preview-spreadsheet" aria-label="只读表格预览">
      <div role="tablist" aria-label="工作表" className="spreadsheet-tabs">
        {book!.sheets.map((sheet, index) => (
          <button
            key={index}
            type="button"
            role="tab"
            aria-controls={panelId}
            tabIndex={index === active ? 0 : -1}
            aria-selected={index === active}
            onKeyDown={(event) => {
              const last = book!.sheets.length - 1;
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % (last + 1)
                  : event.key === 'ArrowLeft'
                    ? (index + last) % (last + 1)
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? last
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const buttons =
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              buttons[next].click();
              buttons[next].focus();
            }}
            onClick={() => {
              setActive(index);
              setViewport((old) => ({ ...old, top: 0 }));
              if (scroll.current) {
                scroll.current.scrollTop = 0;
                scroll.current.scrollLeft = 0;
              }
            }}
          >
            {sheet.name}
          </button>
        ))}
      </div>
      <div
        ref={scroll}
        id={panelId}
        role="tabpanel"
        className="spreadsheet-scroll"
        aria-label="表格滚动区域"
        tabIndex={0}
        onScroll={(event) =>
          setViewport({
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          })
        }
      >
        <table
          aria-label={`工作表 ${sheet.name}`}
          aria-rowcount={sheet.rows.length + 1}
          aria-colcount={sheet.columns + 1}
        >
          <thead>
            <tr aria-rowindex={1}>
              <th aria-label="行号" />
              {columns.map((column) => (
                <th scope="col" key={column}>
                  {columnName(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {start > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={sheet.columns + 1}
                  style={{ height: start * rowHeight, padding: 0, border: 0 }}
                />
              </tr>
            )}
            {sheet.rows.slice(start, end).map((row, index) => (
              <tr key={start + index} aria-rowindex={start + index + 2}>
                <th scope="row">{start + index + 1}</th>
                {columns.map((column) => (
                  <td key={column} title={row[column] ?? ''}>
                    <span>{row[column] ?? ''}</span>
                  </td>
                ))}
              </tr>
            ))}
            {end < sheet.rows.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={sheet.columns + 1}
                  style={{ height: (sheet.rows.length - end) * rowHeight, padding: 0, border: 0 }}
                />
              </tr>
            )}
          </tbody>
        </table>
        {!sheet.rows.length && <p className="preview-empty">工作表为空。</p>}
      </div>
      <small className="spreadsheet-summary">
        {sheet.rows.length} 行 · {sheet.columns} 列 · 只读预览，公式显示已保存结果
      </small>
    </section>
  );
}
