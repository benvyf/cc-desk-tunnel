import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from './icons.tsx';

export async function copyText(text: string) {
  if (window.desktop) await window.desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}

export function CopyButton({
  text,
  label = '复制消息',
  variant = 'default',
}: {
  text: string | (() => string);
  label?: string;
  variant?: 'default' | 'code';
}) {
  const [feedback, setFeedback] = useState({ status: '', revision: 0 });
  const { status } = feedback;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      attempt.current++;
    },
    [],
  );
  return (
    <button
      type="button"
      className={`copy-button${variant === 'code' ? ' code-copy' : ''}`}
      data-status={status === '已复制' ? 'copied' : status ? 'error' : undefined}
      aria-label={status || label}
      aria-live="polite"
      title={status || label}
      data-search-ignore
      onClick={async () => {
        const request = ++attempt.current;
        let next: string;
        try {
          await copyText(typeof text === 'function' ? text() : text);
          next = '已复制';
        } catch {
          next = '复制失败，请重试';
        }
        // Late clipboard replies must not replace a newer attempt or update an unmounted control.
        if (request !== attempt.current) return;
        clearTimeout(timer.current);
        setFeedback((current) => ({ status: next, revision: current.revision + 1 }));
        timer.current = setTimeout(
          () => setFeedback((current) => ({ ...current, status: '' })),
          variant === 'code' ? 2500 : 2000,
        );
      }}
    >
      {variant === 'code' ? (
        <span className="copy-content" key={feedback.revision} aria-hidden="true">
          <span className="copy-label">
            <Copy />
            <span>{label}</span>
          </span>
          {status && (
            <span className="copy-feedback">
              {status === '已复制' ? <Check /> : <Copy />}
              <span>{status === '已复制' ? status : '复制失败'}</span>
            </span>
          )}
        </span>
      ) : (
        <>
          {status === '已复制' ? <Check /> : <Copy />}
          <span>{status || label}</span>
        </>
      )}
    </button>
  );
}
