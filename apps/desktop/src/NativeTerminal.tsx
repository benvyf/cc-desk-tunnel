import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import type { TerminalActivity } from '@cc-desk-tunnel/protocol';
import { RequestFailedError, type ProxyClient } from './client.ts';
import { Bot, CircleAlert, Hand, LoaderCircle, Search, Server, Square, X } from './icons.tsx';
import { Button, IconButton } from './ui.tsx';
import { usePrefs } from './prefs.ts';
import { terminalLinks } from './terminalLinks.ts';
import { createTerminalPrediction, type TerminalPrediction } from './terminalPrediction.ts';
import '@xterm/xterm/css/xterm.css';

export type TerminalPhase =
  'opening' | 'running' | 'closing' | 'ended' | 'failed' | 'unknown' | 'disconnected';
export type TerminalHandle = {
  close: () => Promise<boolean>;
  retry: () => void;
  focus: () => void;
  paste: (text: string) => void;
};
// The canvas takes its colours from the stylesheet's `--terminal-*` tokens (top of style.css): the same warm
// night in either app theme. Each ANSI colour has a token of its name, its bright one `--terminal-bright-…`.
const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
function terminalTheme(element: Element): ITheme {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(`--terminal-${name}`).trim() || undefined;
  return {
    background: token('bg'),
    foreground: token('fg'),
    cursor: token('cursor'),
    cursorAccent: token('bg'),
    selectionBackground: token('selection'),
    ...Object.fromEntries(
      ansi.flatMap((name) => [
        [name, token(name)],
        [`bright${name[0].toUpperCase()}${name.slice(1)}`, token(`bright-${name}`)],
      ]),
    ),
  };
}

export default function NativeTerminal({
  client,
  sessionId,
  onClose,
  active = true,
  onStatus,
  register,
  onLink,
  toolbar,
}: {
  client: ProxyClient;
  sessionId: string;
  onClose: () => void;
  active?: boolean;
  onStatus?: (phase: TerminalPhase, detail: string) => void;
  register?: (handle: TerminalHandle | null) => void;
  onLink?: (target: string) => void;
  toolbar?: HTMLElement | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onStatus, register, onLink });
  callbacks.current = { onClose, onStatus, register, onLink };
  const visible = useRef(active);
  visible.current = active;
  const activate = useRef((_focus = false) => {});
  const terminalRef = useRef<Terminal | null>(null);
  const predictionRef = useRef<TerminalPrediction | null>(null);
  const readingLine = useRef<number | null>(null);
  const prefs = usePrefs();
  const executionReady = () => {
    const deviceId = client.state?.sessions.find((session) => session.id === sessionId)?.device?.id;
    return (
      !deviceId ||
      !client.state?.devices ||
      client.state.devices.some((device) => device.id === deviceId && device.ready)
    );
  };
  const fontSize = prefs.fontSizes.code;
  const handle = useRef<TerminalHandle | null>(null);
  const [phase, setPhase] = useState<TerminalPhase>('opening');
  const [detail, setDetail] = useState('正在启动');
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState({
    status: client.state?.status ?? 'connected',
    ready: executionReady(),
    activity: null as TerminalActivity | null,
  });
  const [recovery, setRecovery] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<boolean | null>(null);
  const [reading, setReading] = useState(false);
  const [unseenOutput, setUnseenOutput] = useState(false);
  const toBottom = useRef(() => {});
  const findInput = useRef<HTMLInputElement>(null);
  const composingFind = useRef(false);
  const find = useRef((_text: string, _previous = false, _incremental = false) => {});
  useEffect(() => {
    if (active && findOpen) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [active, findOpen]);
  useEffect(() => {
    if (active) activate.current(true);
    else predictionRef.current?.clear();
  }, [active]);
  useEffect(() => {
    predictionRef.current?.setEnabled(prefs.terminalPredictiveEcho);
  }, [prefs.terminalPredictiveEcho]);
  useEffect(() => {
    if (terminalRef.current && host.current) {
      terminalRef.current.options.theme = terminalTheme(host.current);
      predictionRef.current?.refresh();
    }
  }, [prefs.theme]);
  useEffect(() => {
    if (!terminalRef.current) return;
    const terminal = terminalRef.current;
    readingLine.current =
      terminal.buffer.active.viewportY < terminal.buffer.active.baseY
        ? terminal.buffer.active.viewportY
        : null;
    terminal.options.fontSize = fontSize;
    predictionRef.current?.refresh();
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
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_event, target) => followLink(target),
      },
      theme: terminalTheme(host.current!),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current!);
    const links = terminal.registerLinkProvider(terminalLinks(terminal, followLink));
    terminalRef.current = terminal;
    const updateReading = () => {
      const aboveBottom = terminal.buffer.active.viewportY < terminal.buffer.active.baseY;
      setReading(aboveBottom);
      if (!aboveBottom) setUnseenOutput(false);
    };
    const scroll = terminal.onScroll(updateReading);
    toBottom.current = () => {
      terminal.scrollToBottom();
      setReading(false);
      setUnseenOutput(false);
      terminal.focus();
    };
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
    let focusRequested = false;
    let outputLost = false;
    let reconnecting = false;
    let reconnectTerminalId: string | null = null;
    let renderGeneration = 0;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const early: { terminalId: string; data: string; bytes: number }[] = [];
    let connectionId = client.state?.connectionId;
    let prediction: TerminalPrediction | null = null;
    let search: SearchAddon | null = null;
    find.current = (text, previous = false, incremental = false) => {
      if (disposed) return;
      if (!text) {
        search?.clearDecorations();
        terminal.clearSelection();
        setFound(null);
        return;
      }
      if (!search) {
        search = new SearchAddon();
        terminal.loadAddon(search);
      }
      // Selection only: no proposed decoration API or regex; search stays in this xterm buffer.
      setFound(previous ? search.findPrevious(text) : search.findNext(text, { incremental }));
    };
    const minimumRows = client.state?.terminalWorkspace?.minRows ?? 5;
    // A window opened for the terminal is handed the page's stylesheets as it opens; one that is still loading
    // has no tokens yet, so the colours are taken again once it has.
    const repaint = () => {
      if (!disposed) {
        terminal.options.theme = terminalTheme(host.current!);
        prediction?.refresh();
      }
    };
    const loading = [
      ...host.current!.ownerDocument.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    ].filter((link) => !link.sheet);
    for (const link of loading) link.addEventListener('load', repaint);
    function followLink(target: string) {
      if (disposed) return;
      if (client.state?.connectionId !== connectionId || phaseNow() === 'disconnected') {
        setError('连接已变化，请在当前连接新开终端后访问链接。');
        return;
      }
      callbacks.current.onLink?.(target);
    }
    function status(next: TerminalPhase, text: string) {
      if (next !== 'running') prediction?.clear();
      current = next;
      if (disposed) return;
      if (next === 'ended' || next === 'failed') setRecovery(null);
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
      const generation = renderGeneration;
      terminal.write(frame.data, () => {
        if (disposed || generation !== renderGeneration) return;
        const aboveBottom = terminal.buffer.active.viewportY < terminal.buffer.active.baseY;
        setReading(aboveBottom);
        setUnseenOutput(aboveBottom);
        if (id !== frame.terminalId || closeRequested) return;
        pendingBytes += frame.bytes;
        if (pendingBytes >= 16 * 1024) acknowledge();
        else ackTimer ??= setTimeout(acknowledge, 20);
      });
    }
    function resize() {
      if (!visible.current || !host.current?.clientWidth || !host.current.clientHeight || disposed)
        return;
      const dimensions = fit.proposeDimensions();
      // Character metrics can be unavailable while a window becomes visible or changes DPI.
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows))
        return false;
      const cols = Math.max(20, Math.min(400, dimensions.cols)),
        rows = Math.max(minimumRows, Math.min(160, dimensions.rows));
      const line =
        readingLine.current ??
        (terminal.buffer.active.viewportY < terminal.buffer.active.baseY
          ? terminal.buffer.active.viewportY
          : null);
      terminal.resize(cols, rows);
      if (line !== null) terminal.scrollToLine(line);
      readingLine.current = null;
      const next = `${cols}:${rows}`;
      if (!id || closeRequested || phaseNow() !== 'running' || size === next) return;
      size = next;
      client.terminalControl({ type: 'terminal.resize', sessionId, terminalId: id, cols, rows });
    }
    activate.current = (focus = false) => {
      focusRequested ||= focus;
      view.cancelAnimationFrame(resizeFrame);
      resizeFrame = view.requestAnimationFrame(() => {
        const focus = focusRequested;
        focusRequested = false;
        if (resize() === false) resizeFrame = view.requestAnimationFrame(() => resize());
        const document = host.current?.ownerDocument;
        if (
          focus &&
          visible.current &&
          phaseNow() === 'running' &&
          !document?.querySelector('dialog[open]') &&
          !document?.activeElement?.closest('.terminal-list, .terminal-draft, .terminal-find')
        )
          terminal.focus();
      });
    };
    function accept(terminalId: string) {
      prediction?.clear();
      id = terminalId;
      if (disposed) return;
      setRecovery(reconnectTerminalId === terminalId ? '已接回原终端，未重发输入。' : null);
      refreshConnection();
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
      if ((client.state && client.state.status !== 'connected') || !executionReady()) return;
      opening = true;
      const openingConnection = connectionId;
      closeRequested = false;
      setError(null);
      status('opening', reconnectTerminalId ? '正在接回原终端' : '正在启动');
      try {
        resize();
        await client.request({
          type: 'terminal.open',
          sessionId,
          ...(reconnectTerminalId ? { terminalId: reconnectTerminalId } : {}),
          cols: Math.max(20, Math.min(400, terminal.cols)),
          rows: Math.max(minimumRows, Math.min(160, terminal.rows)),
        });
        if (openingConnection !== connectionId) return;
        if (opening && !disposed) {
          const result = await observe();
          if (result?.state === 'running' && result.terminalId) accept(result.terminalId);
          else if (phaseNow() !== 'ended') status('unknown', '启动结果尚未确认');
        }
      } catch (failure) {
        if (openingConnection !== connectionId) return;
        if (disposed || phaseNow() === 'ended' || phaseNow() === 'disconnected') return;
        if (id && phaseNow() === 'running') return;
        if (failure instanceof RequestFailedError && !id) {
          opening = false;
          if (failure.code === 'terminal_inactive' && reconnectTerminalId) {
            status('ended', '原终端已结束');
            setError(failure.message);
            return;
          }
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
      if (phaseNow() === 'ended' || phaseNow() === 'failed') return true;
      if (phaseNow() === 'disconnected') {
        if (client.state.status !== 'connected' || !reconnectTerminalId) return true;
        closeRequested = true;
        closeTask = client
          .request({ type: 'terminal.close', sessionId, terminalId: reconnectTerminalId })
          .then(
            () => {
              status('ended', '已关闭');
              return true;
            },
            (failure) => {
              if (failure instanceof RequestFailedError && failure.code === 'terminal_inactive') {
                status('ended', '原终端已结束');
                return true;
              }
              setError(failure instanceof Error ? failure.message : '关闭失败');
              return false;
            },
          )
          .finally(() => {
            closeTask = null;
          });
        return closeTask;
      }
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
      if (client.state?.connectionId !== connectionId || phaseNow() === 'disconnected') return;
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
      } else if (message.type === 'terminal.detached' && message.terminalId === id) {
        prediction?.clear();
        reconnectTerminalId = id;
        renderGeneration++;
        id = null;
        opening = false;
        closeRequested = false;
        setRecovery('终端暂时停止显示，重新连接会尝试接回原进程，不会重发输入。');
        status('disconnected', '终端暂时停止显示，可重新连接');
      } else if (message.type === 'connection.error' && message.terminalId === id)
        setError(message.message);
    });
    function refreshConnection() {
      const run = client.state?.sessions.find((session) => session.id === sessionId)?.activeRun;
      const next = {
        status: client.state?.status ?? 'connected',
        ready: executionReady(),
        activity: run?.surface === 'terminal' && run.id === id ? (run.activity ?? null) : null,
      };
      setConnection((previous) =>
        previous.status === next.status &&
        previous.ready === next.ready &&
        previous.activity === next.activity
          ? previous
          : next,
      );
    }
    const disconnected = () => {
      refreshConnection();
      if (phaseNow() === 'opening' && !id && !opening && !reconnectTerminalId && !closeRequested) {
        if (client.state.status === 'connected' && executionReady()) {
          connectionId = client.state.connectionId;
          openTask = start();
        }
        return;
      }
      if (
        reconnecting &&
        executionReady() &&
        client.state.status === 'connected' &&
        client.state.terminalWorkspace?.resumable &&
        client.state.connectionId !== connectionId &&
        phaseNow() === 'disconnected' &&
        !disposed
      ) {
        reconnecting = false;
        connectionId = client.state.connectionId;
        renderGeneration++;
        terminal.reset();
        search?.clearDecorations();
        setFound(null);
        pendingBytes = 0;
        bufferedBytes = 0;
        early.length = 0;
        size = '';
        closeRequested = false;
        outputLost = false;
        status('opening', '正在恢复终端');
        openTask = start();
        return;
      }
      if (client.state.status !== 'connected' || client.state.connectionId !== connectionId) {
        if (client.state.status === 'reconnecting') reconnecting = true;
        prediction?.clear();
        reconnectTerminalId ??= id;
        renderGeneration++;
        id = null;
        opening = false;
        closeRequested = true;
        clearTimeout(ackTimer);
        if (phaseNow() !== 'ended' && phaseNow() !== 'failed') {
          status('disconnected', '连接中断 · 正在等待恢复终端');
          setRecovery('原终端状态尚未确认；恢复时不会重发输入。');
        }
      } else if (phaseNow() === 'opening' && !opening && !id && !closeRequested) {
        openTask = start();
      }
    };
    const unwatch = client.subscribe?.(disconnected);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || event.isComposing) return true;
      const copy =
        event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'c' &&
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
            if (
              !disposed &&
              visible.current &&
              id === targetId &&
              id &&
              client.state?.connectionId === connectionId &&
              phaseNow() === 'running' &&
              !host.current?.ownerDocument.activeElement?.closest(
                '.terminal-draft, .terminal-list, .terminal-find',
              ) &&
              !host.current?.ownerDocument.querySelector('dialog[open]')
            )
              (prediction ?? terminal).paste(text);
          }
        } catch {
          if (!disposed) setError('无法访问剪贴板，请使用系统复制/粘贴菜单。');
        }
      })();
      return false;
    });
    try {
      prediction = createTerminalPrediction(terminal, host.current!, () => ({
        running: phaseNow() === 'running',
        visible: visible.current,
        connected:
          client.state?.connectionId === connectionId &&
          (!client.state || client.state.status === 'connected'),
        closing: closeRequested || disposed,
      }));
      predictionRef.current = prediction;
      prediction.setEnabled(prefs.terminalPredictiveEcho);
    } catch {
      // Prediction is optional; the existing input path remains available.
      try {
        prediction?.dispose();
      } catch {}
      predictionRef.current = null;
      prediction = null;
    }
    const input = terminal.onData((data) => {
      if (
        !visible.current ||
        !id ||
        closeRequested ||
        phaseNow() !== 'running' ||
        host.current?.ownerDocument.querySelector('dialog[open]')
      )
        return;
      try {
        prediction?.beforeInput(data);
      } catch {
        try {
          prediction?.dispose();
        } catch {}
      }
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
    // xterm can finish measuring characters after the host has already stopped resizing.
    const screen = terminal.element?.querySelector('.xterm-screen');
    if (screen) observer.observe(screen);
    const onWindowResize = () => {
      prediction?.refresh();
      activate.current();
    };
    view.addEventListener('resize', onWindowResize);
    handle.current = {
      close,
      focus: () => activate.current(true),
      paste: (text) => {
        if (
          disposed ||
          !visible.current ||
          !id ||
          closeRequested ||
          phaseNow() !== 'running' ||
          client.state?.connectionId !== connectionId ||
          host.current?.ownerDocument.querySelector('dialog[open]')
        )
          throw new Error('目标终端不可输入，草稿已保留。');
        if (/[\r\n]/.test(text) && !terminal.modes.bracketedPasteMode)
          throw new Error('终端未启用多行粘贴模式，请复制后手动粘贴并检查。');
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
          throw new Error('草稿含有终端控制字符，请移除后再粘贴。');
        (prediction ?? terminal).paste(text);
        terminal.focus();
      },
      retry: () => {
        if (phaseNow() === 'failed' || phaseNow() === 'disconnected') {
          if (client.state.status !== 'connected' || !executionReady()) return;
          connectionId = client.state.connectionId;
          renderGeneration++;
          terminal.reset();
          search?.clearDecorations();
          setFound(null);
          pendingBytes = 0;
          size = '';
          closeRequested = false;
          status('opening', '正在恢复终端');
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
      view.removeEventListener('resize', onWindowResize);
      input.dispose();
      prediction?.dispose();
      if (predictionRef.current === prediction) predictionRef.current = null;
      links.dispose();
      scroll.dispose();
      toBottom.current = () => {};
      for (const link of loading) link.removeEventListener('load', repaint);
      unwatch?.();
      view.cancelAnimationFrame(resizeFrame);
      callbacks.current.register?.(null);
      handle.current = null;
      find.current = () => {};
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
  const connectionText =
    connection.status === 'reconnecting'
      ? '正在重连服务端'
      : connection.status === 'connecting'
        ? '正在连接服务端'
        : connection.status === 'disconnected'
          ? '服务端连接已断开'
          : !connection.ready
            ? '服务端已连接 · 等待执行通道就绪'
            : '服务端已连接';
  const activityText =
    phase === 'running'
      ? connection.activity === 'working'
        ? 'Claude 正在运行'
        : connection.activity === 'waiting'
          ? 'Claude 等待确认或回答'
          : connection.activity === 'idle'
            ? 'Claude 等待输入'
            : 'Claude 状态待同步'
      : detail;
  const closeFind = () => {
    composingFind.current = false;
    setFindOpen(false);
    find.current('');
    terminalRef.current?.focus();
  };
  const connectionState =
    connection.status === 'connected'
      ? connection.ready
        ? 'ready'
        : 'waiting'
      : connection.status === 'disconnected'
        ? 'disconnected'
        : 'connecting';
  const activityState = phase === 'running' ? (connection.activity ?? 'unknown') : phase;
  const ActivityIcon =
    activityState === 'working' || activityState === 'opening' || activityState === 'closing'
      ? LoaderCircle
      : activityState === 'waiting'
        ? Hand
        : activityState === 'failed'
          ? CircleAlert
          : activityState === 'ended'
            ? Square
            : Bot;
  const indicators = (
    <div className="terminal-runtime-status" aria-label="终端状态">
      <span
        className="terminal-state-icon"
        data-state={connectionState}
        role="status"
        title={connectionText}
        aria-label={connectionText}
      >
        <Server scale="sm" />
        <span className="sr-only">{connectionText}</span>
      </span>
      <span
        className="terminal-state-icon"
        data-state={activityState}
        role="status"
        title={activityText}
        aria-label={activityText}
      >
        <ActivityIcon
          scale="sm"
          className={ActivityIcon === LoaderCircle ? 'spinning' : undefined}
        />
        <span className="sr-only">{activityText}</span>
      </span>
      <IconButton
        title="查找终端输出"
        aria-expanded={findOpen}
        onClick={() => {
          setFindOpen(true);
          findInput.current?.focus();
          findInput.current?.select();
          find.current(query, false, true);
        }}
      >
        <Search scale="sm" />
      </IconButton>
    </div>
  );
  return (
    <section className="native-terminal" aria-label="原生 Claude Code 终端">
      {!register ? (
        <header>
          <span>Linux · Claude Code</span>
          {indicators}
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
        <span className="sr-only">Linux · Claude Code</span>
      )}
      {register && active && toolbar && createPortal(indicators, toolbar)}
      {error && <p role="alert">{error}</p>}
      {recovery && <div className="terminal-recovery-note">{recovery}</div>}
      {(phase === 'failed' || phase === 'unknown' || phase === 'disconnected') && (
        <div className="terminal-recovery">
          <Button
            size="sm"
            disabled={
              phase === 'disconnected' && (client.state.status !== 'connected' || !executionReady())
            }
            onClick={() => handle.current?.retry()}
          >
            {phase === 'disconnected'
              ? '重新连接终端'
              : phase === 'failed'
                ? '重试启动'
                : '确认终端状态'}
          </Button>
        </div>
      )}
      <div className="terminal-display">
        <div className="terminal-host" ref={host} />
        {reading && (
          <Button className="terminal-to-bottom" size="sm" onClick={() => toBottom.current()}>
            {unseenOutput ? '有新输出 · 回到底部' : '回到底部'}
          </Button>
        )}
        {findOpen && (
          <div
            className="terminal-find"
            role="search"
            aria-label="查找终端输出"
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing || composingFind.current) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              } else if (event.key === 'Enter' && event.target === findInput.current) {
                event.preventDefault();
                find.current(query, event.shiftKey);
              }
            }}
          >
            <input
              ref={findInput}
              aria-label="终端查找文字"
              placeholder="查找当前保留的输出"
              value={query}
              onCompositionStart={() => {
                composingFind.current = true;
              }}
              onCompositionEnd={(event) => {
                composingFind.current = false;
                find.current(event.currentTarget.value, false, true);
              }}
              onChange={(event) => {
                setQuery(event.target.value);
                if (!composingFind.current) find.current(event.target.value, false, true);
              }}
            />
            <span role="status">{found === false ? '未找到' : found ? '已定位' : ''}</span>
            <Button size="xs" disabled={!query} onClick={() => find.current(query, true)}>
              上一个
            </Button>
            <Button size="xs" disabled={!query} onClick={() => find.current(query)}>
              下一个
            </Button>
            <IconButton title="关闭终端查找" size="xs" onClick={closeFind}>
              <X scale="sm" />
            </IconButton>
          </div>
        )}
      </div>
    </section>
  );
}
