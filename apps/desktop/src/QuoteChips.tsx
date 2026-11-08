import { useId, useState } from 'react';
import { MessageSquare, X, ChevronDown } from './icons.tsx';
import { Button, IconButton } from './ui.tsx';
import type { QuoteReference } from './quotes.ts';

export default function QuoteChips({
  quotes,
  remove,
}: {
  quotes: QuoteReference[];
  remove?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const contents = useId(),
    count = useId();
  if (!quotes.length) return null;
  return (
    <div className="quote-references">
      <div className="quote-reference-header">
        <Button
          size="sm"
          className="quote-reference-chip"
          aria-label="查看引用内容"
          aria-describedby={count}
          aria-expanded={open}
          aria-controls={contents}
          onClick={() => setOpen((value) => !value)}
        >
          <MessageSquare scale="xs" />
          <span id={count}>{quotes.length} 条引用</span>
          <ChevronDown scale="xs" />
        </Button>
        {remove && quotes.length === 1 && (
          <IconButton title="移除引用" size="xs" onClick={() => remove(quotes[0].id)}>
            <X />
          </IconButton>
        )}
      </div>
      {open && (
        <div className="quote-reference-list" id={contents}>
          {quotes.map((quote, index) => (
            <div className="quote-reference-item" key={quote.id}>
              <header>
                <span>引用 {index + 1}</span>
                {remove && (
                  <IconButton
                    title={`移除引用 ${index + 1}`}
                    size="xs"
                    onClick={() => remove(quote.id)}
                  >
                    <X />
                  </IconButton>
                )}
              </header>
              <blockquote>{quote.text}</blockquote>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
