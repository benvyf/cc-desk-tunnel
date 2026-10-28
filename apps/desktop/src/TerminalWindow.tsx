import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import NativeTerminal from './NativeTerminal.tsx';
import type { ProxyClient } from './client.ts';

export default function TerminalWindow({
  client,
  sessionId,
  onClose,
}: {
  client: ProxyClient;
  sessionId: string;
  onClose: () => void;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const bridge = window.desktop?.terminalWindow;
    if (!bridge) {
      setFallback(true);
      return;
    }
    let disposed = false;
    let popup: Window | null = null;
    let unsubscribe = () => {};
    // React StrictMode's throwaway effect must not open a native window or a remote process.
    queueMicrotask(() => {
      if (disposed) return;
      popup = window.open('about:blank', 'cc-native-terminal', 'popup,width=1000,height=680');
      if (!popup) {
        setFallback(true);
        return;
      }
      // The portal keeps its own Window reference; the child needs no reverse bridge access.
      popup.opener = null;
      popup.document.title = 'CC SPACE · 原生终端';
      popup.document.documentElement.dataset.theme = 'dark';
      const base = popup.document.createElement('base');
      base.href = document.baseURI;
      popup.document.head.append(base);
      for (const style of document.querySelectorAll('link[rel="stylesheet"], style'))
        popup.document.head.append(style.cloneNode(true));
      const layout = popup.document.createElement('style');
      layout.textContent =
        'html,body,#terminal-window-root{width:100%;height:100%;margin:0;overflow:hidden;background:#0b0b0a}#terminal-window-root{display:flex;flex-direction:column}.native-terminal{flex:1;min-height:0;border:0}';
      popup.document.head.append(layout);
      const root = popup.document.createElement('div');
      root.id = 'terminal-window-root';
      popup.document.body.append(root);
      unsubscribe = bridge.onClosed(() => {
        if (!disposed) onClose();
      });
      setContainer(root);
      void bridge.focus();
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (popup && !popup.closed) popup.close();
    };
  }, [onClose]);
  if (fallback) return <NativeTerminal client={client} sessionId={sessionId} onClose={onClose} />;
  return (
    <>
      <div className="terminal-window-notice" role="status">
        <span>{container ? '原生终端已在独立窗口打开' : '正在打开终端窗口…'}</span>
        <button
          type="button"
          onClick={() => {
            void window.desktop?.terminalWindow.focus();
          }}
        >
          显示终端
        </button>
        <button type="button" onClick={onClose}>
          关闭终端
        </button>
      </div>
      {container &&
        createPortal(
          <NativeTerminal client={client} sessionId={sessionId} onClose={onClose} />,
          container,
        )}
    </>
  );
}
