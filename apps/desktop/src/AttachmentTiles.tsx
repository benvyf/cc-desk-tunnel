import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileCode, FileText, X } from './icons.tsx';
import { attachmentKind, fileName } from './attachments.ts';
import type { Attachment } from './attachments.ts';

function Tile({
  item,
  remove,
  disabled,
}: {
  item: Attachment;
  remove?: () => void;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const kind = attachmentKind(fileName(item.path ?? item.name));
  useEffect(() => {
    setPreview(null);
    setPreviewLoading(false);
    if (kind !== 'IMAGE' || !item.path || !window.desktop?.attachmentPreview) return;
    let current = true;
    setPreviewLoading(true);
    void window.desktop.attachmentPreview(item.path).then(
      (value) => {
        if (current) {
          setPreview(value);
          setPreviewLoading(false);
        }
      },
      () => {
        if (current) setPreviewLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [item.path, kind]);
  const Icon = kind === 'CODE' ? FileCode : FileText;
  const preparing = item.status === 'preparing' || (previewLoading && !!remove);
  return (
    <div className="attachment-slot" role="listitem">
      <div
        className="attachment-tile"
        data-status={preparing ? 'preparing' : item.status}
        aria-busy={preparing}
        title={item.path ?? item.name}
      >
        {preview && (
          <img
            className="attachment-preview"
            src={preview}
            alt={item.name}
            decoding="async"
            onError={() => setPreview(null)}
          />
        )}
        <span className="attachment-kind">
          <Icon />
          {kind}
        </span>
        {remove && (
          <button
            type="button"
            className="attachment-remove"
            aria-label={`移除 ${item.name}`}
            disabled={disabled}
            onClick={remove}
          >
            <X />
          </button>
        )}
        <span className="attachment-name">{item.name}</span>
        {(preparing || item.status === 'error') && (
          <span className="attachment-status" role="status" title={item.error}>
            {preparing ? '处理中…' : '添加失败，请重新添加'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function AttachmentTiles({
  items,
  remove,
  disabled = false,
}: {
  items: Attachment[];
  remove?: (id: string) => void;
  disabled?: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  const previous = useRef(new Set(items.map((item) => item.id)));
  useLayoutEffect(() => {
    if (items.some((item) => !previous.current.has(item.id))) {
      const element = row.current;
      if (element) element.scrollLeft = element.scrollWidth;
    }
    previous.current = new Set(items.map((item) => item.id));
  }, [items]);
  if (!items.length) return null;
  return (
    <div
      className="attachment-tiles"
      role="list"
      aria-label="附件"
      ref={row}
      onAnimationEnd={(event) => {
        // Initial measurement happens before the entering slot has its final width.
        if (
          event.animationName === 'attachment-enter' &&
          event.target === row.current?.lastElementChild
        )
          row.current.scrollLeft = row.current.scrollWidth;
      }}
    >
      {items.map((item) => (
        <Tile
          key={item.id}
          item={item}
          disabled={disabled}
          remove={remove ? () => remove(item.id) : undefined}
        />
      ))}
    </div>
  );
}
