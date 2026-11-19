import { useCallback, useState } from 'react';
import { linkDoubt } from './links.ts';
import type { Link } from './links.ts';
import { Button, Modal } from './ui.tsx';

// A web link whose text or address may mislead (see `linkDoubt`) is followed only once its whole address has been
// seen. Every way a page follows a link goes through `guard`: a click, the menu's "打开链接" and "在侧栏预览", and
// the links of a previewed document. The address is as the browser will take it, so a look-alike name shows as the
// xn-- it really is.
export function useLinkDoubt() {
  const [asking, setAsking] = useState<{ url: string; doubt: string; go: () => void } | null>(null);
  // Does `go` at once, unless `link` may mislead as `text` shows it: then asks first, and does it on 打开.
  const guard = useCallback((link: Link, text: string, go: () => void) => {
    const doubt = link.kind === 'web' ? linkDoubt(text, link.url) : null;
    if (!doubt || link.kind !== 'web') return go();
    setAsking({ url: link.url, doubt, go });
  }, []);
  const dismiss = useCallback(() => setAsking(null), []);
  const dialog = asking && (
    <Modal title="打开这个链接？" onClose={dismiss} initialFocus=".leave-cancel">
      <p className="leave-doubt">{asking.doubt}</p>
      <p className="leave-lead">将打开：</p>
      <p className="leave-url">{asking.url}</p>
      <div className="dialog-actions">
        <Button className="leave-cancel" onClick={dismiss}>
          取消
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            dismiss();
            asking.go();
          }}
        >
          打开
        </Button>
      </div>
    </Modal>
  );
  return { guard, dialog, dismiss };
}
