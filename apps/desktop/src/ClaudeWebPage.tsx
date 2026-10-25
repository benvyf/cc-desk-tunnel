import { useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import ModeSwitch from './ModeSwitch.tsx';
import type { WorkspaceMode } from './ModeSwitch.tsx';

const messages: Record<string, string> = {
  disconnected: '请先连接CC服务',
  'not-installed': '当前服务尚未安装远端网页功能',
  'not-configured': '管理员尚未启用远端网页',
  'moderation-required': '当前节点要求强制审核，网页入口暂不可用',
  maintenance: '服务正在维护，请稍后重新连接',
  unavailable: '远端网页暂不可用，请稍后重试',
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
  const rfb = useRef<RFB | null>(null);
  const latestVisible = useRef(visible);
  latestVisible.current = visible;
  const heldKeys = useRef(new Map<string, number>());
  const attempt = useRef(0);
  const [message, setMessage] = useState('点击连接远端网页');
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  useEffect(() => {
    void window.desktop?.browser?.mode(visible);
    if (rfb.current) {
      // noVNC's viewOnly setter suppresses its own held-key releases. Send them before changing it.
      if (!visible) {
        for (const [code, symbol] of heldKeys.current) rfb.current.sendKey(symbol, code, false);
        rfb.current.blur();
      }
      rfb.current.viewOnly = !visible;
    }
  }, [visible, connected]);
  useEffect(() => {
    if (!connected) {
      attempt.current++;
      rfb.current?.disconnect();
      rfb.current = null;
      setOnline(false);
      setLoading(false);
      setMessage(messages.disconnected);
      void window.desktop?.browser?.close();
    }
  }, [connected]);
  useEffect(
    () => () => {
      attempt.current++;
      rfb.current?.disconnect();
      void window.desktop?.browser?.close();
      void window.desktop?.browser?.mode(false);
    },
    [],
  );
  async function connect() {
    if (!window.desktop?.browser || !connected || loading) return;
    const generation = ++attempt.current;
    rfb.current?.disconnect();
    rfb.current = null;
    setOnline(false);
    setMaintenance(false);
    setLoading(true);
    setMessage('正在连接远端网页…');
    try {
      const result = await window.desktop.browser.open();
      if (generation !== attempt.current) return;
      if (!result.enabled || !result.url) {
        setMessage(messages[result.reason ?? 'unavailable'] ?? messages.unavailable);
        return;
      }
      const url = new URL(result.url);
      if (
        url.protocol !== 'ws:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/browser\/[a-f0-9]{64}$/.test(url.pathname)
      )
        throw new Error('Invalid local bridge');
      const { default: RemoteFramebuffer } = await import('@novnc/novnc');
      if (generation !== attempt.current) return;
      const remote = new RemoteFramebuffer(screen.current!, url.href);
      rfb.current = remote;
      remote.scaleViewport = true;
      remote.resizeSession = false;
      remote.viewOnly = !latestVisible.current;
      const held = new Map<string, number>();
      heldKeys.current = held;
      const sendKey = remote.sendKey.bind(remote);
      remote.sendKey = (symbol, code, down) => {
        if (!remote.viewOnly && code && down !== undefined) {
          if (down) held.set(code, symbol);
          else held.delete(code);
        }
        sendKey(symbol, code, down);
      };
      remote.addEventListener('connect', () => {
        if (generation === attempt.current) {
          setOnline(true);
          setMessage('已连接远端网页');
        }
      });
      remote.addEventListener('disconnect', () => {
        if (generation === attempt.current) {
          setOnline(false);
          setMessage('远端网页连接中断，请重新连接');
        }
      });
      remote.addEventListener('credentialsrequired', () => {
        if (generation === attempt.current) {
          remote.disconnect();
          setMessage('远端浏览器需要管理员检查');
        }
      });
    } catch {
      if (generation === attempt.current) setMessage(messages.unavailable);
    } finally {
      if (generation === attempt.current) setLoading(false);
    }
  }
  return (
    <section className="claude-web-page" hidden={!visible} aria-label="Claude网页">
      <header className="claude-web-toolbar">
        <ModeSwitch mode="chat" change={changeMode} />
        <span role="status">{window.desktop?.browser ? message : '仅桌面客户端可用'}</span>
        <button
          type="button"
          className="button"
          disabled={!window.desktop?.browser || !connected || loading}
          onClick={() => void connect()}
        >
          {loading ? '连接中…' : online ? '重新连接' : '连接远端网页'}
        </button>
        <button
          type="button"
          className="button"
          disabled={!online}
          onClick={() => {
            attempt.current++;
            rfb.current?.disconnect();
            rfb.current = null;
            setOnline(false);
            setMaintenance(true);
            setMessage('登录需要管理员处理');
            void window.desktop?.browser?.close();
          }}
        >
          登录需要处理
        </button>
      </header>
      <div className="claude-web-screen" ref={screen} hidden={maintenance} />
      {(!online || maintenance) && (
        <div className="claude-web-notice">
          <p>
            {maintenance
              ? '已暂停网页操作，请联系管理员处理登录，再手动重新连接。'
              : window.desktop?.browser
                ? message
                : '请在桌面客户端连接远端网页'}
          </p>
          <p>
            网页和附件访问由远端浏览器完成。当前为远端交互试验版；中文输入及本地附件传输尚未接入。
          </p>
        </div>
      )}
    </section>
  );
}
