import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileCode, FileText, X } from './icons.tsx';
import { attachmentKind, fileName } from './attachments.ts';
import type { Attachment } from './attachments.ts';
import { localPicture } from './links.ts';
import { Modal } from './ui.tsx';
export const ArchivedAttachments = createContext<Record<string, string> | null>(null);

// A picture's small preview, read by the desktop app; none in the browser or for other files.
function usePreview(path: string | undefined, kind: string) {
  const archive = useContext(ArchivedAttachments);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setPreview(null);
    setLoading(false);
    if (archive !== null) {
      const data = path ? archive[path] : undefined;
      if (data && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(data)) setPreview(data);
      return;
    }
    if (kind !== 'IMAGE' || !path || !window.desktop?.attachmentPreview) return;
    let current = true;
    setLoading(true);
    void window.desktop.attachmentPreview(path).then(
      (value) => {
        if (current) {
          setPreview(value);
          setLoading(false);
        }
      },
      () => {
        if (current) setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [path, kind, archive]);
  return { preview, loading, drop: () => setPreview(null) };
}

// What a sent question carried, in a row above its bubble: the same small tiles as in the input box, so that many
// pictures take little room. A picture opens whole on a click, read from this computer; where it cannot be (sent
// from another, or since moved), its preview is shown larger instead.
function SentFile({ item }: { item: Attachment }) {
  const archive = useContext(ArchivedAttachments);
  const kind = attachmentKind(fileName(item.path ?? item.name));
  const { preview, drop } = usePreview(item.path, kind);
  const [open, setOpen] = useState(false);
  const [whole, setWhole] = useState(true);
  const Icon = kind === 'CODE' ? FileCode : FileText;
  const face = (
    <>
      {preview && (
        <img
          className="attachment-preview"
          src={preview}
          alt={item.name}
          decoding="async"
          onError={drop}
        />
      )}
      <span className="attachment-kind">
        <Icon />
        {kind}
      </span>
      <span className="attachment-name">{item.name}</span>
    </>
  );
  return (
    <div className="attachment-slot" role="listitem">
      {preview ? (
        <button
          type="button"
          className="attachment-tile attachment-open"
          title={`${item.path ?? item.name}（点击放大）`}
          onClick={() => setOpen(true)}
        >
          {face}
        </button>
      ) : (
        <div className="attachment-tile" title={item.path ?? item.name}>
          {face}
        </div>
      )}
      {open &&
        preview &&
        createPortal(
          <Modal title={item.name} onClose={() => setOpen(false)}>
            <div className="picture-view" onContextMenu={(event) => event.stopPropagation()}>
              <img
                src={archive === null && whole && item.path ? localPicture(item.path) : preview}
                alt={item.name}
                onError={() => setWhole(false)}
              />
            </div>
          </Modal>,
          document.body,
        )}
    </div>
  );
}

export function MessageAttachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="message-attachments" role="list" aria-label="附件">
      {items.map((item) => (
        <SentFile key={item.id} item={item} />
      ))}
    </div>
  );
}

function Tile({
  item,
  remove,
  disabled,
}: {
  item: Attachment;
  remove?: () => void;
  disabled: boolean;
}) {
  const kind = attachmentKind(fileName(item.path ?? item.name));
  const { preview, loading: previewLoading, drop } = usePreview(item.path, kind);
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
            onError={drop}
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
