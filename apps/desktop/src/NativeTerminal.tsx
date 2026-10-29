import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RequestFailedError, type ProxyClient } from './client.ts';
import { X } from './icons.tsx';
import { Button, IconButton } from './ui.tsx';
import { usePrefs } from './prefs.ts';
import { terminalLinks } from './terminalLinks.ts';
import '@xterm/xterm/css/xterm.css';

export type TerminalPhase =
  'opening' | 'running' | 'closing' | 'ended' | 'failed' | 'unknown' | 'disconnected';
export type TerminalHandle = { close: () => Promise<boolean>; retry: () => void; focus: () => void };
export default function NativeTerminal({
  client,
  sessionId,
  onClose,
  active = true,
  onStatus,
  register,
  onLink,
}: {
  client: ProxyClient;
  sessionId: string;
  onClose: () => void;
  active?: boolean;
  onStatus?: (phase: TerminalPhase, detail: string) => void;
  register?: (handle: TerminalHandle | null) => void;
  onLink?: (target: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onStatus, register, onLink });
  callbacks.current = { onClose, onStatus, register, onLink };
  const visible = useRef(active);
  visible.current = active;
  const activate = useRef((_focus = false) => {});
  const terminalRef = useRef<Terminal | null>(null);
  const readingLine = useRef<number | null>(null);
  const fontSize = usePrefs().fontSizes.code;
  const handle = useRef<TerminalHandle | null>(null);
  const [phase, setPhase] = useState<TerminalPhase>('opening');
  const [detail, setDetail] = useState('正在启动');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (active) activate.current(true);
  }, [active]);
  useEffect(() => {
    if (!terminalRef.current) return;
    const terminal = terminalRef.current;
    readingLine.current = terminal.buffer.active.viewportY < terminal.buffer.active.baseY
      ? terminal.buffer.active.viewportY : null;
    terminal.options.fontSize = fontSize;
    activate.current();
  }, [fontSize]);
  useEffect(() => {
    const view = host.current!.ownerDocument.defaultView ?? window;
    const terminal = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: false,
      linkHandler: { allowNonHttpProtocols: true, activate: (_event, target) => callbacks.current.onLink?.(target) },
      theme: {
        background: '#0b0b0a',
        foreground: '#dedcd6',
        cursor: '#d97757',
        selectionBackground: '#633d2c',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    const links = terminal.registerLinkProvider(terminalLinks(terminal, (target) => callbacks.current.onLink?.(target)));
    terminalRef.current = terminal;
    let id: string | null = null,
      disposed = false,
      opening = false,
      closeRequested = false;
    let current: TerminalPhase = 'opening';
    const phaseNow = (): TerminalPhase => current;
    let closeTask: Promise<boolean> | null = null;
    let openTask: Promise<void> = Promise.resolve();
    let pendingBytes = 0,
      bufferedBytes = 0,
      size = '',
      resizeFrame = 0;
    let outputLost = false;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const early: { terminalId: string; data: string; bytes: number }[] = [];
    const connectionId = client.state?.connectionId;
    function status(next: TerminalPhase, text: string) {
      current = next;
      if (disposed) return;
      setPhase(next);
      setDetail(text);
      callbacks.current.onStatus?.(next, text);
    }
    function acknowledge() {
      clearTimeout(ackTimer);
      ackTimer = undefined;
      if (!id || !pendingBytes || disposed || closeRequested || phaseNow() !== 'running') return;
      client.terminalControl({
        type: 'terminal.ack',
        sessionId,
        terminalId: id,
        bytes: pendingBytes,
      });
      pendingBytes = 0;
    }
    function write(frame: { terminalId: string; data: string; bytes: number }) {
      terminal.write(frame.data, () => {
        if (disposed || id !== frame.terminalId || closeRequested) return;
        pendingBytes += frame.bytes;
        if (pendingBytes >= 16 * 1024) acknowledge();
        else ackTimer ??= setTimeout(acknowledge, 20);
      });
    }
    function resize() {
      if (!visible.current || !host.current?.clientWidth || !host.current.clientHeight || disposed)
        return;
      const line = readingLine.current ?? (terminal.buffer.active.viewportY < terminal.buffer.active.baseY
        ? terminal.buffer.active.viewportY : null);
      fit.fit();
      if (line !== null) terminal.scrollToLine(line);
      readingLine.current = null;
      const cols = Math.max(20, Math.min(400, terminal.cols)),
        rows = Math.max(5, Math.min(160, terminal.rows));
      const next = `${cols}:${rows}`;
      if (!id || closeRequested || phaseNow() !== 'running' || size === next) return;
      size = next;
      client.terminalControl({ type: 'terminal.resize', sessionId, terminalId: id, cols, rows });
    }
    activate.current = (focus = false) => {
      view.cancelAnimationFrame(resizeFrame);
      resizeFrame = view.requestAnimationFrame(() => {
        resize();
        const document = host.current?.ownerDocument;
        if (focus && visible.current && phaseNow() === 'running' && !document?.querySelector('dialog[open]') &&
            !document?.activeElement?.closest('.terminal-list, .terminal-draft'))
          terminal.focus();
      });
    };
    function accept(terminalId: string) {
      id = terminalId;
      if (disposed) return;
      opening = false;
      if (outputLost) {
        status('unknown', '输出未完整接收');
        return;
      }
      status(
        closeRequested ? 'closing' : 'running',
        closeRequested ? '正在关闭' : 'Linux · Claude Code',
      );
      for (const frame of early) if (frame.terminalId === id) write(frame);
      early.length = 0;
      bufferedBytes = 0;
      if (visible.current) activate.current(true);
    }
    async function observe() {
      if (!client.state?.terminalWorkspace) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await client.fetch({
          type: 'terminal.state',
          sessionId,
          ...(id ? { terminalId: id } : {}),
        });
        if (disposed || client.state.connectionId !== connectionId) return null;
        if (result.state !== 'opening' && result.state !== 'closing') return result;
        if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      return null;
    }
    async function start() {
      if (
        opening ||
        id ||
        disposed ||
        closeRequested ||
        (phaseNow() !== 'failed' && phaseNow() !== 'opening')
      )
        return;
      opening = true;
      closeRequested = false;
      setError(null);
      status('opening', '正在启动');
      try {
        resize();
        await client.request({
          type: 'terminal.open',
          sessionId,
          cols: Math.max(20, Math.min(400, terminal.cols)),
          rows: Math.max(5, Math.min(160, terminal.rows)),
        });
        if (opening && !disposed) {
          const result = await observe();
          if (result?.state === 'running' && result.terminalId) accept(result.terminalId);
          else if (phaseNow() !== 'ended') status('unknown', '启动结果尚未确认');
        }
      } catch (failure) {
        if (disposed || phaseNow() === 'ended' || phaseNow() === 'disconnected') return;
        if (id && phaseNow() === 'running') return;
        if (failure instanceof RequestFailedError && !id) {
          opening = false;
          status('failed', '启动失败');
          setError(failure.message);
          return;
        }
        try {
          const result = await observe();
          if (result?.state === 'running' && result.terminalId) {
            accept(result.terminalId);
            return;
          }
          if (result?.state === 'absent') {
            opening = false;
            status('failed', '启动失败');
          } else status('unknown', '启动结果尚未确认');
        } catch {
          status('unknown', '启动结果尚未确认');
        }
        setError(failure instanceof Error ? failure.message : '启动失败');
      }
    }
    async function close(): Promise<boolean> {
      if (closeTask) return closeTask;
      if (phaseNow() === 'ended' || phaseNow() === 'failed' || phaseNow() === 'disconnected')
        return true;
      closeRequested = true;
      clearTimeout(ackTimer);
      view.cancelAnimationFrame(resizeFrame);
      closeTask = (async () => {
        try {
          if (opening) await openTask;
          if (!id) {
            const result = await observe();
            if (result?.state === 'absent' || phaseNow() === 'ended') return true;
            if (result?.terminalId) id = result.terminalId;
            if (!id) throw new Error('终端状态尚未确认，请再次确认后关闭。');
          }
          status('closing', '正在关闭');
          await client.request({ type: 'terminal.close', sessionId, terminalId: id });
          id = null;
          status('ended', '已关闭');
          return true;
        } catch (failure) {
          if (phaseNow() === 'ended' || phaseNow() === 'disconnected') return true;
          try {
            const result = await observe();
            if (result?.state === 'absent') {
              id = null;
              status('ended', '已结束 · 退出原因未知');
              return true;
            }
            if (result?.state === 'running' && result.terminalId) {
              id = result.terminalId;
              if (outputLost) status('unknown', '输出未完整接收，请关闭终端');
              else {
                closeRequested = false;
                status('running', 'Linux · Claude Code');
                acknowledge();
                activate.current(true);
              }
            } else status('unknown', '关闭结果尚未确认');
          } catch {
            status('unknown', '关闭结果尚未确认');
          }
          if (!disposed) setError(failure instanceof Error ? failure.message : '关闭失败');
          return false;
        } finally {
          closeTask = null;
        }
      })();
      return closeTask;
    }
    const unsubscribe = client.onTerminal((message) => {
      if (message.sessionId !== sessionId) return;
      if (disposed && !opening) return;
      if (message.type === 'terminal.opened') accept(message.terminalId);
      else if (message.type === 'terminal.data' && !disposed) {
        if (message.terminalId === id) write(message);
        else if (!id && opening && bufferedBytes + message.bytes <= 128 * 1024) {
          early.push(message);
          bufferedBytes += message.bytes;
        } else if (!id && opening) {
          id = message.terminalId;
          outputLost = true;
          status('unknown', '输出未完整接收');
          setError('输出未完整接收，正在关闭此终端；请新开终端继续。');
          void Promise.resolve().then(() => close());
        }
      } else if (
        message.type === 'terminal.closed' &&
        (message.terminalId === id || (!id && opening))
      ) {
        id = null;
        opening = false;
        pendingBytes = 0;
        clearTimeout(ackTimer);
        view.cancelAnimationFrame(resizeFrame);
        if (!outputLost && message.reason !== 'control_error') setError(null);
        const reason =
          message.reason === 'ack_timeout'
            ? '输出确认超时'
            : message.reason === 'user_close'
              ? '已关闭'
              : message.reason === 'disconnected'
                ? '连接中断'
                : message.reason === 'control_error'
                  ? '终端控制失败'
                  : `退出码 ${message.exitCode ?? '未知'}`;
        status('ended', `已结束 · ${reason}`);
      } else if (message.type === 'connection.error' && message.terminalId === id)
        setError(message.message);
    });
    const disconnected = () => {
      if (client.state.status !== 'connected' || client.state.connectionId !== connectionId) {
        id = null;
        opening = false;
        closeRequested = true;
        clearTimeout(ackTimer);
        if (phaseNow() !== 'ended' && phaseNow() !== 'failed')
          status('disconnected', '连接中断 · 终端不会续接');
      }
    };
    const unwatch = client.subscribe?.(disconnected);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.isComposing) return true;
      const copy = event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c' &&
        (event.shiftKey || terminal.hasSelection());
      const paste = event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v';
      if (!copy && !paste) return true;
      event.preventDefault();
      const targetId = id;
      void (async () => {
        try {
          if (copy) {
            const text = terminal.getSelection();
            if (!text) return;
            if (window.desktop?.copyText) await window.desktop.copyText(text);
            else await view.navigator.clipboard.writeText(text);
            if (!disposed) terminal.clearSelection();
          } else {
            const text = await view.navigator.clipboard.readText();
            if (!disposed && visible.current && id === targetId && id &&
                client.state?.connectionId === connectionId && phaseNow() === 'running' &&
                !host.current?.ownerDocument.querySelector('dialog[open]')) terminal.paste(text);
          }
        } catch {
          if (!disposed) setError('无法访问剪贴板，请使用系统复制/粘贴菜单。');
        }
      })();
      return false;
    });
    const input = terminal.onData((data) => {
      if (!visible.current || !id || closeRequested || phaseNow() !== 'running' ||
          host.current?.ownerDocument.querySelector('dialog[open]')) return;
      for (let offset = 0; offset < data.length;) {
        let end = Math.min(offset + 4096, data.length);
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
        client.terminalControl({
          type: 'terminal.input',
          sessionId,
          terminalId: id,
          data: data.slice(offset, end),
        });
        offset = end;
      }
    });
    const observer = new view.ResizeObserver(() => activate.current());
    observer.observe(host.current!);
    handle.current = {
      close,
      focus: () => activate.current(true),
      retry: () => {
        if (phaseNow() === 'failed') {
          closeRequested = false;
          openTask = start();
          return;
        }
        if (phaseNow() !== 'unknown') return;
        void observe()
          .then((result) => {
            if (result?.state === 'running' && result.terminalId) {
              if (outputLost) {
                id = result.terminalId;
                void close();
              } else {
                closeRequested = false;
                setError(null);
                accept(result.terminalId);
              }
            } else if (result?.state === 'absent') {
              id = null;
              opening = false;
              status(
                closeRequested ? 'ended' : 'failed',
                closeRequested ? '已结束 · 退出原因未知' : '终端不存在，可重试',
              );
            }
          })
          .catch(() => setError('状态确认失败，请稍后重试。'));
      },
    };
    callbacks.current.register?.(handle.current);
    openTask = Promise.resolve().then(() => {
      if (!disposed) return start();
    });
    return () => {
      disposed = true;
      clearTimeout(ackTimer);
      observer.disconnect();
      input.dispose();
      links.dispose();
      unwatch?.();
      view.cancelAnimationFrame(resizeFrame);
      callbacks.current.register?.(null);
      handle.current = null;
      // A late open still needs its listener until its request settles, then close only this instance.
      void openTask.finally(() => {
        if (id)
          void client
            .request({ type: 'terminal.close', sessionId, terminalId: id })
            .catch(() => {});
        unsubscribe();
      });
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [client, sessionId]);
  return (
    <section className="native-terminal" aria-label="原生 Claude Code 终端">
      {!register ? (
        <header>
          <span role="status">{detail}</span>
          <IconButton
            title="关闭原生终端"
            onClick={() => {
              void handle.current?.close().then((done) => {
                if (done) callbacks.current.onClose();
              });
            }}
          >
            <X />
          </IconButton>
        </header>
      ) : (
        <span className="sr-only" role="status">
          {detail}
        </span>
      )}
      {error && <p role="alert">{error}</p>}
      {(phase === 'failed' || phase === 'unknown') && (
        <Button size="sm" onClick={() => handle.current?.retry()}>
          {phase === 'failed' ? '重试启动' : '确认终端状态'}
        </Button>
      )}
      <div className="terminal-host" ref={host} />
    </section>
  );
}
