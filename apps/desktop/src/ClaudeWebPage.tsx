import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ModeSwitch from './ModeSwitch.tsx';
import type { WorkspaceMode } from './ModeSwitch.tsx';

const messages: Record<string, string> = {
  disconnected: '请先连接CC服务',
  'not-installed': '当前服务尚未安装网页代理',
  'not-configured': '管理员尚未启用网页代理',
  'moderation-required': '当前节点要求强制审核，网页入口暂不可用',
  maintenance: '服务正在维护，请稍后重新连接',
  unavailable: '网页连接失败，请检查远端连接后重试',
};
export default function ClaudeWebPage({
  visible,
  connected,
  changeMode,
}: {
  visible: boolean;
  connected: boolean;
  changeMode: (mode: WorkspaceMode) => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const attempt = useRef(0);
  const [message, setMessage] = useState('点击打开Claude网页');
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  function pause() {
    attempt.current++;
    setLoading(false);
    setOnline(false);
    setMaintenance(true);
    setMessage('登录需要管理员处理');
    void window.desktop?.browser.close();
  }
  useLayoutEffect(() => {
    const element = screen.current;
    const browser = window.desktop?.browser;
    if (!element || !browser) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { x, y, width, height } = element.getBoundingClientRect();
        void browser.bounds({ x, y, width, height });
        void browser.mode(visible);
      });
    };
    void browser.mode(visible);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [visible, online]);
  useEffect(
    () =>
      window.desktop?.browser.onState((state) => {
        if (state !== 'unavailable') return;
        attempt.current++;
        setOnline(false);
        setLoading(false);
        setMessage(messages.unavailable);
        void window.desktop?.browser.close();
      }),
    [],
  );
  useEffect(() => {
    if (!connected) {
      attempt.current++;
      setOnline(false);
      setLoading(false);
      setMaintenance(false);
      setMessage(messages.disconnected);
      void window.desktop?.browser.close();
    } else
      setMessage((previous) =>
        previous === messages.disconnected ? '点击打开Claude网页' : previous,
      );
  }, [connected]);
  useEffect(
    () => () => {
      attempt.current++;
      void window.desktop?.browser.mode(false);
      void window.desktop?.browser.close();
    },
    [],
  );
  async function open() {
    if (!window.desktop?.browser || !connected || loading) return;
    const generation = ++attempt.current;
    setOnline(false);
    setMaintenance(false);
    setLoading(true);
    setMessage('正在打开Claude网页…');
    try {
      const result = await window.desktop.browser.open();
      if (generation !== attempt.current) return;
      setOnline(result.enabled);
      setMessage(
        result.enabled
          ? '已打开Claude网页'
          : (messages[result.reason ?? 'unavailable'] ?? messages.unavailable),
      );
    } catch {
      if (generation === attempt.current) setMessage(messages.unavailable);
    } finally {
      if (generation === attempt.current) setLoading(false);
    }
  }
  return (
    <section className="claude-web-page" hidden={!visible} aria-label="Claude网页">
      <header className="claude-web-toolbar">
        <ModeSwitch
          mode="chat"
          change={(mode) => {
            if (mode !== 'chat') void window.desktop?.browser.mode(false);
            changeMode(mode);
          }}
        />
        <span role="status">{window.desktop?.browser ? message : '仅桌面客户端可用'}</span>
        <button
          type="button"
          className="button"
          disabled={!window.desktop?.browser || !connected || loading}
          onClick={() => void open()}
        >
          {loading
            ? '打开中…'
            : online
              ? '重新打开'
              : maintenance
                ? '管理员重新登录'
                : '打开Claude网页'}
        </button>
        <button type="button" className="button" disabled={!online} onClick={pause}>
          登录需要处理
        </button>
      </header>
      <div className="claude-web-body">
        <div className="claude-web-screen" ref={screen} />
        {!online && (
          <div className="claude-web-notice">
            <p>
              {maintenance
                ? '已暂停网页操作，请管理员在此客户端人工重新登录。'
                : window.desktop?.browser
                  ? message
                  : '请在桌面客户端打开Claude网页'}
            </p>
            <p>管理员首次登录后复用此客户端的登录状态；网络连接失败时停止访问。</p>
          </div>
        )}
      </div>
    </section>
  );
}
