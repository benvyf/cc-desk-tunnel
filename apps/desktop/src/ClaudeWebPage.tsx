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
  const heldPointer = useRef<{ x: number; y: number } | null>(null);
  const heldGesture = useRef<{
    target: HTMLCanvasElement;
    type: string;
    clientX: number;
    clientY: number;
  } | null>(null);
  const handshake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  const [message, setMessage] = useState('点击连接远端网页');
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [adminNotice, setAdminNotice] = useState('');
  function clearHandshake() {
    clearTimeout(handshake.current);
    handshake.current = undefined;
  }
  function releaseInput() {
    const remote = rfb.current;
    if (!remote) return;
    const pointer = heldPointer.current;
    heldPointer.current = null;
    const gesture = heldGesture.current;
    heldGesture.current = null;
    if (gesture && !remote.viewOnly) {
      gesture.target.dispatchEvent(
        new CustomEvent('gestureend', {
          bubbles: true,
          detail: { type: gesture.type, clientX: gesture.clientX, clientY: gesture.clientY },
        }),
      );
    }
    if (pointer && !remote.viewOnly) {
      // Use noVNC's ordinary DOM input path; no private RFB fields or website scripts.
      // Window dispatch also lets noVNC release its pointer-capture overlay.
      window.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          buttons: 0,
          clientX: pointer.x,
          clientY: pointer.y,
        }),
      );
    }
    for (const [code, symbol] of heldKeys.current) remote.sendKey(symbol, code, false);
    heldKeys.current.clear();
    remote.blur();
  }
  function pause(message: string, notice: string) {
    attempt.current++;
    clearHandshake();
    releaseInput();
    rfb.current?.disconnect();
    rfb.current = null;
    setOnline(false);
    setLoading(false);
    setMaintenance(true);
    setMessage(message);
    setAdminNotice(notice);
    void window.desktop?.browser?.close();
  }
  useEffect(() => {
    const element = screen.current!;
    const remember = (event: MouseEvent) => {
      if (event.target instanceof HTMLCanvasElement) {
        heldPointer.current = event.buttons ? { x: event.clientX, y: event.clientY } : null;
      }
    };
    const hidden = () => {
      if (document.hidden) releaseInput();
    };
    const unfocused = (event: FocusEvent) => {
      if (event.target instanceof HTMLCanvasElement) releaseInput();
    };
    const rememberGesture = (event: Event) => {
      const { type, clientX, clientY } = (event as CustomEvent).detail;
      if (event.target instanceof HTMLCanvasElement && ['drag', 'longpress'].includes(type))
        heldGesture.current =
          event.type === 'gestureend' ? null : { target: event.target, type, clientX, clientY };
    };
    for (const type of ['mousedown', 'mousemove', 'mouseup'])
      element.addEventListener(type, remember as EventListener, true);
    for (const type of ['gesturestart', 'gesturemove', 'gestureend'])
      element.addEventListener(type, rememberGesture, true);
    window.addEventListener('blur', releaseInput);
    element.addEventListener('focusout', unfocused);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      for (const type of ['mousedown', 'mousemove', 'mouseup'])
        element.removeEventListener(type, remember as EventListener, true);
      for (const type of ['gesturestart', 'gesturemove', 'gestureend'])
        element.removeEventListener(type, rememberGesture, true);
      window.removeEventListener('blur', releaseInput);
      element.removeEventListener('focusout', unfocused);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  useEffect(() => {
    void window.desktop?.browser?.mode(visible);
    if (rfb.current) {
      // noVNC's viewOnly setter suppresses its own held-key releases. Send them before changing it.
      if (!visible) releaseInput();
      rfb.current.viewOnly = !visible;
    }
  }, [visible, connected]);
  useEffect(() => {
    if (!connected) {
      attempt.current++;
      clearHandshake();
      releaseInput();
      rfb.current?.disconnect();
      rfb.current = null;
      setOnline(false);
      setLoading(false);
      setMaintenance(false);
      setMessage(messages.disconnected);
      void window.desktop?.browser?.close();
    } else
      setMessage((previous) =>
        previous === messages.disconnected ? '点击连接远端网页' : previous,
      );
  }, [connected]);
  useEffect(
    () => () => {
      attempt.current++;
      clearHandshake();
      releaseInput();
      rfb.current?.disconnect();
      void window.desktop?.browser?.close();
      void window.desktop?.browser?.mode(false);
    },
    [],
  );
  async function connect() {
    if (!window.desktop?.browser || !connected || loading) return;
    const generation = ++attempt.current;
    clearHandshake();
    releaseInput();
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
      handshake.current = setTimeout(() => {
        if (generation === attempt.current)
          pause(
            '远端画面连接超时，请联系管理员检查',
            '已暂停网页操作，请联系管理员检查远端浏览器，再手动重新连接。',
          );
      }, 15000);
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
          clearHandshake();
          setOnline(true);
          setMessage('已连接远端网页');
        }
      });
      remote.addEventListener('disconnect', () => {
        if (generation === attempt.current) {
          clearHandshake();
          releaseInput();
          setOnline(false);
          setMessage('远端网页连接中断，请重新连接');
        }
      });
      remote.addEventListener('credentialsrequired', () => {
        if (generation === attempt.current) {
          pause(
            '远端浏览器需要管理员检查',
            '已暂停网页操作，请联系管理员检查远端浏览器，再手动重新连接。',
          );
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
        <ModeSwitch
          mode="chat"
          change={(mode) => {
            // Release while the canvas still has its visible bounds.
            if (mode !== 'chat') releaseInput();
            changeMode(mode);
          }}
        />
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
            pause('登录需要管理员处理', '已暂停网页操作，请联系管理员处理登录，再手动重新连接。');
          }}
        >
          登录需要处理
        </button>
      </header>
      <div className="claude-web-body">
        <div className="claude-web-screen" ref={screen} hidden={maintenance} />
        {(!online || maintenance) && (
          <div className="claude-web-notice">
            <p>
              {maintenance
                ? adminNotice
                : window.desktop?.browser
                  ? message
                  : '请在桌面客户端连接远端网页'}
            </p>
            <p>
              网页和附件访问由远端浏览器完成。当前为远端交互试验版；中文输入及本地附件传输尚未接入。
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
