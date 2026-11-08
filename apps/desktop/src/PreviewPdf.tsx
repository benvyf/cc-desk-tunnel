import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { getDocument, GlobalWorkerOptions, normalizeUnicode, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from './ui.tsx';
import { usePreviewReading } from './usePreviewReading.ts';
import { clampPdfReading } from './previewViewState.ts';
import type { PreviewWorkspace } from './preview.ts';
import './PreviewPdfText.css';
import textStyles from './PreviewPdfText.css?inline';

GlobalWorkerOptions.workerSrc = workerUrl;
// Vite packages these assets with the application. No CDN or document URL is used.
const assets = import.meta.glob('../../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
async function asset(name: string) {
  const url = Object.entries(assets).find(([path]) => path.endsWith('/' + name))?.[1];
  if (!url) throw new Error('PDF 本机资源不可用。');
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}
class LocalCMaps {
  async fetch({ name }: { name: string }) {
    return { cMapData: await asset(name + '.bcmap'), compressionType: 1 };
  }
}
class LocalFonts {
  async fetch({ filename }: { filename: string }) {
    return asset(filename);
  }
}
class LocalWasm {
  async fetch({ filename }: { filename: string }) {
    return asset(filename);
  }
}

export default function PreviewPdf({
  data,
  missingFonts = [],
  reading,
  tabId,
  interruption,
}: {
  data: string;
  missingFonts?: string[];
  reading: PreviewWorkspace['reading'];
  tabId: string;
  interruption: RefObject<boolean>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null),
    pageElement = useRef<HTMLDivElement>(null),
    textHost = useRef<HTMLDivElement>(null);
  const saved = reading.get(tabId);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(saved?.kind === 'pdf' ? saved.page : 1),
    [zoom, setZoom] = useState(saved?.kind === 'pdf' ? saved.zoom : 1),
    [error, setError] = useState(''),
    [rendering, setRendering] = useState(true),
    [textStatus, setTextStatus] = useState(''),
    [width, setWidth] = useState(500);
  const [rendered, setRendered] = useState<{
    document: PDFDocumentProxy;
    page: number;
    zoom: number;
    width: number;
  } | null>(null);
  const ready =
    document &&
    !rendering &&
    !error &&
    rendered?.document === document &&
    rendered.page === page &&
    rendered.zoom === zoom &&
    rendered.width === width
      ? rendered
      : null;
  const captureReading = usePreviewReading(
    container,
    ready,
    'pdf',
    () => {
      const current = reading.get(tabId);
      return current?.kind === 'pdf' && current.page === page && current.zoom === zoom
        ? current
        : { top: 0, left: 0 };
    },
    (position) => reading.set(tabId, { kind: 'pdf', page, zoom, ...position }),
    undefined,
    reading,
    interruption,
  );
  const changePage = (next: number) => {
    captureReading();
    const integer = Number.isFinite(next) ? Math.trunc(next) : 1;
    const value = Math.max(1, Math.min(document?.numPages ?? 1, integer));
    reading.set(tabId, { kind: 'pdf', page: value, zoom, top: 0, left: 0 });
    setPage(value);
  };
  const changeZoom = (next: number) => {
    captureReading();
    const current = reading.get(tabId);
    const position = current?.kind === 'pdf' ? current : { top: 0, left: 0 };
    reading.set(tabId, { kind: 'pdf', page, zoom: next, top: position.top, left: position.left });
    setZoom(next);
  };
  useEffect(() => {
    setDocument(null);
    setRendered(null);
    setError('');
    setRendering(true);
    const task = getDocument({
      data: Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
      isEvalSupported: false,
      useSystemFonts: true,
      useWorkerFetch: false,
      CMapReaderFactory: LocalCMaps,
      StandardFontDataFactory: LocalFonts,
      WasmFactory: LocalWasm,
    });
    let disposed = false;
    void task.promise.then(
      (value) => {
        if (!disposed) {
          const current = reading.get(tabId);
          if (current?.kind === 'pdf') {
            const restored = clampPdfReading(current, value.numPages);
            reading.set(tabId, restored);
            setPage(restored.page);
          } else setPage((previous) => Math.min(previous, value.numPages));
          setDocument(value);
        }
      },
      () => {
        if (!disposed) setError('PDF 无法读取，可能已损坏或需要密码。');
      },
    );
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [data, reading, tabId]);
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(() => setWidth(Math.max(100, element.clientWidth - 32)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    let disposed = false,
      render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined,
      textLayer: TextLayer | undefined,
      textDiv: HTMLDivElement | undefined;
    const host = textHost.current!;
    const copy = (event: ClipboardEvent) => {
      const selection = host.ownerDocument.getSelection();
      if (
        !selection ||
        selection.isCollapsed ||
        !textDiv?.contains(selection.anchorNode) ||
        !textDiv.contains(selection.focusNode) ||
        !event.clipboardData
      )
        return;
      event.clipboardData.setData(
        'text/plain',
        normalizeUnicode(selection.toString()).replaceAll('\0', ''),
      );
      event.preventDefault();
      event.stopPropagation();
    };
    setRendering(true);
    setError('');
    setTextStatus('');
    void document
      .getPage(page)
      .then((value) => {
        if (disposed) return;
        const natural = value.getViewport({ scale: 1 });
        const scale = Math.min(2, width / natural.width) * zoom;
        const viewport = value.getViewport({ scale });
        const target = canvas.current!,
          context = target.getContext('2d')!;
        const ratio = Math.min(target.ownerDocument.defaultView?.devicePixelRatio || 1, 2);
        // Limit canvas allocation even for maliciously large page dimensions.
        const fit = Math.min(1, 4096 / Math.max(viewport.width * ratio, viewport.height * ratio));
        target.width = Math.ceil(viewport.width * ratio * fit);
        target.height = Math.ceil(viewport.height * ratio * fit);
        target.style.width = `${viewport.width * fit}px`;
        target.style.height = `${viewport.height * fit}px`;
        pageElement.current!.style.width = target.style.width;
        pageElement.current!.style.height = target.style.height;
        // Core TextLayer uses the same layout engine as TextLayerBuilder. Its local
        // copy listener uses ownerDocument so portal windows never read another selection.
        textDiv = host.ownerDocument.createElement('div');
        textDiv.className = 'textLayer';
        textDiv.style.setProperty('--total-scale-factor', String(scale * fit * value.userUnit));
        host.append(textDiv);
        textDiv.addEventListener('copy', copy);
        try {
          textLayer = new TextLayer({
            textContentSource: value
              .streamTextContent({ includeMarkedContent: true, disableNormalization: true })
              .pipeThrough(
                new TransformStream({
                  transform(chunk, controller) {
                    // Match PDF.js's measurement language, rather than inheriting the
                    // app locale (which can select a different generic font on Windows).
                    textDiv!.lang = chunk.lang || 'en';
                    controller.enqueue(chunk);
                  },
                }),
              ),
            container: textDiv,
            viewport: value.getViewport({ scale: scale * fit }),
          });
          void textLayer
            .render()
            .then(() => {
              if (!disposed && !textLayer!.textContentItemsStr.some((item) => item.trim()))
                setTextStatus('此页没有可选文字，可能是扫描件。');
            })
            .catch(() => {
              if (!disposed) {
                textDiv?.remove();
                setTextStatus('此页文字暂时无法选择，可继续查看页面。');
              }
            })
            .finally(() => TextLayer.cleanup());
        } catch {
          textDiv.remove();
          setTextStatus('此页文字暂时无法选择，可继续查看页面。');
          TextLayer.cleanup();
        }
        render = value.render({
          canvasContext: context,
          canvas: target,
          viewport,
          transform: [ratio * fit, 0, 0, ratio * fit, 0, 0],
        });
        return render.promise;
      })
      .then(() => {
        if (!disposed) setRendered({ document, page, zoom, width });
      })
      .catch((e) => {
        if (!disposed && e?.name !== 'RenderingCancelledException') setError('PDF 页面无法显示。');
      })
      .finally(() => {
        if (!disposed) setRendering(false);
      });
    return () => {
      disposed = true;
      render?.cancel();
      textLayer?.cancel();
      const selection = host.ownerDocument.getSelection();
      if (
        textDiv?.contains(selection?.anchorNode ?? null) &&
        textDiv.contains(selection?.focusNode ?? null)
      )
        selection?.removeAllRanges();
      textDiv?.removeEventListener('copy', copy);
      textDiv?.remove();
      TextLayer.cleanup();
    };
  }, [document, page, zoom, width]);
  return (
    <div className="preview-pdf">
      {/* Lazy CSS loaded in the opener must also follow a portal into its owner window. */}
      <style>{textStyles}</style>
      <div className="preview-pdf-toolbar">
        <Button size="sm" disabled={!document || page <= 1} onClick={() => changePage(page - 1)}>
          上一页
        </Button>
        <input
          aria-label="PDF 页码"
          type="number"
          min={1}
          max={document?.numPages ?? 1}
          value={page}
          onChange={(e) => changePage(Number(e.target.value) || 1)}
        />
        <span>/ {document?.numPages ?? '…'}</span>
        <Button
          size="sm"
          disabled={!document || page >= document.numPages}
          onClick={() => changePage(page + 1)}
        >
          下一页
        </Button>
        <Button
          size="sm"
          aria-label="缩小 PDF"
          disabled={zoom <= 0.5}
          onClick={() => changeZoom(Math.max(0.5, zoom - 0.25))}
        >
          −
        </Button>
        <Button size="sm" title="恢复 PDF 比例" onClick={() => changeZoom(1)}>
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          size="sm"
          aria-label="放大 PDF"
          disabled={zoom >= 3}
          onClick={() => changeZoom(Math.min(3, zoom + 0.25))}
        >
          +
        </Button>
      </div>
      {!!missingFonts.length && (
        <p className="preview-tree-notice">
          缺少字体：{missingFonts.join('、')}，已使用本机替代字体。
        </p>
      )}
      {error && (
        <p className="preview-error" role="alert">
          {error}
        </p>
      )}
      {textStatus && <p className="preview-tree-notice preview-pdf-text-status">{textStatus}</p>}
      <div
        className="preview-pdf-pages"
        ref={container}
        aria-busy={!error && (!document || rendering)}
      >
        {(!document || rendering) && !error && (
          <p className="preview-tree-notice" role="status">
            正在显示 PDF…
          </p>
        )}
        <div className="preview-pdf-page" ref={pageElement} hidden={!document || !!error}>
          <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
          <div className="preview-pdf-text-host" ref={textHost} />
        </div>
      </div>
    </div>
  );
}
