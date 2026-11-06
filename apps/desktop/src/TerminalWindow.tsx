import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@cc-desk-tunnel/protocol';
import NativeTerminal, { type TerminalHandle, type TerminalPhase } from './NativeTerminal.tsx';
import { RequestFailedError, type ProxyClient } from './client.ts';
import { SquareTerminal, X, Plus, ChevronDown, ScrollText, Search } from './icons.tsx';
import { Button, IconButton, Modal } from './ui.tsx';
import { folderName, pathKey } from './paths.ts';
import { terminalTarget } from './terminalLinks.ts';
import { followLink } from './linkActions.ts';
import TerminalFile from './TerminalFile.tsx';
import TerminalDraft from './TerminalDraft.tsx';
import TerminalHistory from './TerminalHistory.tsx';
import PreviewSidebar from './PreviewSidebar.tsx';
import { previewWebsite, usePreviewWorkspace } from './preview.ts';
import {
  deviceLabel,
  terminalChoices,
  projectPreferenceKey,
  newTerminalPermission,
} from './developmentProjects.ts';
import OpenProjectDialog from './OpenProjectDialog.tsx';
import { useSshTargets } from './useSshTargets.ts';
import { useShared } from './shared.ts';
import { getPrefs, usePrefs } from './prefs.ts';
import { effortNames, sessionDefaultOptions } from './modelDefaults.ts';

export type TerminalWorkspaceHandle = {
  closeAll: () => Promise<boolean>;
  show: (sessionId?: string) => void;
  create: (project: { deviceId?: string; path: string }) => void;
};
type Tab = {
  tabId: string;
  sessionId?: string;
  source: Session;
  alias: string;
  phase: TerminalPhase | 'creating';
  detail: string;
  error?: string;
  createId?: string;
  projectPath?: string;
  historySessionId?: string;
};
const live = (tab: Tab) => !['ended', 'failed', 'disconnected'].includes(tab.phase);
export default function TerminalWindow({
  client,
  sessionId,
  onClose,
  onActivity,
  onSessions,
  projectScope = '',
  register,
  nodeName = '当前连接节点',
  workspaceRoots = [],
}: {
  client: ProxyClient;
  sessionId: string;
  onClose: () => void;
  onActivity?: (active: boolean) => void;
  onSessions?: (ids: string[]) => void;
  projectScope?: string;
  register?: (handle: TerminalWorkspaceHandle | null) => void;
  nodeName?: string;
  workspaceRoots?: string[];
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const sshTargets = useSshTargets();
  const savedPaths = useShared('projects');
  const localPaths = Array.isArray(savedPaths)
    ? savedPaths.filter((path): path is string => typeof path === 'string')
    : [];
  const source = state.sessions.find((session) => session.id === sessionId)!;
  const [tabs, setTabsState] = useState<Tab[]>(() => [
    {
      tabId: crypto.randomUUID(),
      sessionId,
      source,
      alias: '',
      phase: 'opening',
      detail: '正在启动',
    },
  ]);
  const tabsRef = useRef(tabs);
  const setTabs = useCallback((update: Tab[] | ((previous: Tab[]) => Tab[])) => {
    const next = typeof update === 'function' ? update(tabsRef.current) : update;
    tabsRef.current = next;
    setTabsState(next);
  }, []);
  const [activeId, setActiveId] = useState(() => tabs[0].tabId);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [fallback, setFallback] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [nativeControls, setNativeControls] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [filter, setFilter] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  const [rename, setRename] = useState<string | null>(null);
  const [alias, setAlias] = useState('');
  const prefs = usePrefs();
  const menuButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    if (!menu) composing.current = false;
  }, [menu]);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 40, width: 420 });
  const [openProject, setOpenProject] = useState<{
    deviceId?: string;
    path?: string;
    source?: Session;
  } | null>(null);
  const [confirm, setConfirm] = useState<Tab[] | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [file, setFile] = useState<{ raw: string; source: Session } | null>(null);
  const [linkError, setLinkError] = useState('');
  const [historySource, setHistorySource] = useState<Session | null>(null);
  useEffect(() => {
    (container?.ownerDocument ?? document)
      .getElementById(`tab-${activeId}`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length, container]);
  const confirmResult = useRef<((value: boolean) => void) | null>(null);
  const closePending = useRef<Promise<boolean> | null>(null);
  const handles = useRef(new Map<string, TerminalHandle>());
  const waitingHandles = useRef(new Map<string, (handle: TerminalHandle) => void>());
  const creations = useRef(new Map<string, Promise<void>>());
  const popupRef = useRef<Window | null>(null);
  const callbacks = useRef({ onClose, onActivity, onSessions, register });
  callbacks.current = { onClose, onActivity, onSessions, register };
  const patch = useCallback((tabId: string, values: Partial<Tab>) => {
    setTabs((current) => current.map((tab) => (tab.tabId === tabId ? { ...tab, ...values } : tab)));
  }, []);
  const active = tabs.find((tab) => tab.tabId === activeId) ?? tabs[0];
  const sourceOf = (tab: Tab) =>
    state.sessions.find((session) => session.id === (tab.sessionId ?? tab.source.id)) ?? tab.source;
  const activeSource = active && sourceOf(active);
  const mixedDevices = new Set(tabs.map((tab) => sourceOf(tab).device?.id)).size > 1;
  const occupied = JSON.stringify(
    tabs
      .filter((tab) => tab.sessionId && !['ended', 'failed'].includes(tab.phase))
      .map((tab) => tab.sessionId!)
      .sort(),
  );
  useEffect(() => {
    callbacks.current.onSessions?.(JSON.parse(occupied));
  }, [occupied]);
  const preview = usePreviewWorkspace(
    state.status === 'disconnected' ? null : 'terminal',
    active?.source.id,
    fallback ? 'inline-terminal' : 'terminal',
    tabs
      .map((tab) => tab.source.id)
      .sort()
      .join('\n'),
  );
  const previewAvailable =
    !!window.desktop?.preview && !state.browser && active?.source.device?.id === state.device?.id;
  const previewShown = previewAvailable && preview.expanded;
  const multi = state.terminalWorkspace?.version === 1;
  const connected = state.status === 'connected';
  const anyLive = tabs.some((tab) => !['ended', 'failed'].includes(tab.phase));
  useEffect(() => {
    callbacks.current.onActivity?.(anyLive);
    void window.desktop?.terminalWindow.setActive?.(anyLive);
  }, [anyLive]);
  const show = useCallback(
    (id?: string) => {
      if (id) {
        const existing = tabsRef.current.find((tab) => tab.sessionId === id);
        if (existing) setActiveId(existing.tabId);
        else {
          if (confirmResult.current || closePending.current) return;
          const source = client.state.sessions.find((session) => session.id === id);
          if (!source) return;
          if (source.activeRun && source.activeRun.surface !== 'terminal') {
            setCloseError('此会话正在图形界面运行，请先结束当前任务。');
            return;
          }
          const tabId = crypto.randomUUID();
          setTabs((current) => [
            ...current,
            { tabId, sessionId: id, source, alias: '', phase: 'opening', detail: '正在启动' },
          ]);
          setActiveId(tabId);
        }
      }
      void window.desktop?.terminalWindow.focus();
    },
    [client],
  );
  async function create(tab: Tab) {
    if (creations.current.has(tab.tabId)) return;
    patch(tab.tabId, { phase: 'creating', error: undefined, detail: '正在创建' });
    const generation = client.state.connectionId;
    const task = (async () => {
      try {
        const response = await client.request(
          tab.historySessionId
            ? {
                type: 'terminal.history.continue',
                sessionId: tab.source.id,
                historySessionId: tab.historySessionId,
                confirmed: true,
              }
            : {
                type: 'terminal.session.create',
                title: '新终端',
                ...(tab.projectPath
                  ? { projectPath: tab.projectPath }
                  : { sourceSessionId: tab.source.id }),
                permissionMode: tab.source.permissionMode,
                model: tab.source.model,
                effort: tab.source.effort,
              },
          tab.createId,
        );
        if (client.state.connectionId !== generation) throw new Error('连接已变化，请确认原会话。');
        if (!response.sessionId) throw new Error('服务未返回会话标识');
        const created = client.state.sessions.find((session) => session.id === response.sessionId);
        if (!created) throw new Error('服务未返回新会话配置，请确认创建结果。');
        patch(tab.tabId, {
          sessionId: response.sessionId,
          source: created,
          phase: 'opening',
          detail: '正在启动',
        });
      } catch (error) {
        patch(tab.tabId, {
          phase: error instanceof RequestFailedError ? 'failed' : 'unknown',
          detail: error instanceof RequestFailedError ? '创建失败' : '创建结果尚未确认',
          error: error instanceof Error ? error.message : '创建失败',
        });
      } finally {
        creations.current.delete(tab.tabId);
      }
    })();
    creations.current.set(tab.tabId, task);
    await task;
  }
  function add(source: Session, path?: string, historySessionId?: string) {
    if (!multi || !connected || closing || confirmResult.current || closePending.current) return;
    const target = sshTargets.find((target) => target.id === source.device?.id);
    if (!path && !historySessionId && target && target.status !== 'connected') {
      setOpenProject({ deviceId: target.id, path: source.projectPath, source });
      return;
    }
    const tab: Tab = {
      tabId: crypto.randomUUID(),
      source,
      alias: '',
      phase: 'creating',
      detail: '正在创建',
      createId: crypto.randomUUID(),
      projectPath: path,
      historySessionId,
    };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.tabId);
    setMenu(false);
    void create(tab);
  }
  const choices = terminalChoices({
    sessions: state.sessions,
    targets: sshTargets,
    localPaths,
    localDeviceId: state.device?.id,
    workspaceRoots,
    scope: projectScope,
    active: activeSource,
  }).map((choice) => ({
    ...choice,
    name:
      prefs.projectNames[
        projectPreferenceKey(
          projectScope,
          choice.deviceId === state.device?.id ? undefined : choice.deviceId,
          choice.path,
        )
      ] || choice.name,
  }));
  function chooseProject(project: { deviceId?: string; path: string; source?: Session }) {
    if (!multi || !connected || closing || confirmResult.current || closePending.current) return;
    setMenu(false);
    if (project.source) add(project.source);
    else
      setOpenProject({
        deviceId: project.deviceId === state.device?.id ? undefined : project.deviceId,
        path: project.path,
      });
    void window.desktop?.terminalWindow.focus();
  }
  function createProject(project: { deviceId?: string; path: string }) {
    chooseProject(
      choices.find(
        (choice) =>
          (choice.deviceId || state.device?.id) === (project.deviceId || state.device?.id) &&
          pathKey(choice.path) === pathKey(project.path),
      ) ?? project,
    );
  }
  async function remove(targets: Tab[], all: boolean): Promise<boolean> {
    if (closing || confirmResult.current) return false;
    if (targets.some((tab) => live(tab) || tab.phase === 'disconnected')) {
      const agreed = await new Promise<boolean>((resolve) => {
        confirmResult.current = resolve;
        setConfirm(targets);
      });
      if (!agreed) return false;
    }
    setClosing(true);
    setCloseError(null);
    const failed: string[] = [],
      removed: string[] = [];
    for (const target of targets) {
      await creations.current.get(target.tabId);
      const tab = tabsRef.current.find((tab) => tab.tabId === target.tabId);
      if (!tab) continue;
      let control = handles.current.get(tab.tabId);
      if (live(tab) && tab.sessionId && !control)
        control = await new Promise<TerminalHandle>((resolve) =>
          waitingHandles.current.set(tab.tabId, resolve),
        );
      const done = control ? await control.close() : !live(tab);
      if (done) removed.push(tab.tabId);
      else failed.push(tab.alias || folderName(tab.source.projectPath));
    }
    const remaining = tabsRef.current.filter((tab) => !removed.includes(tab.tabId));
    setTabs(remaining);
    setClosing(false);
    if (failed.length) {
      setCloseError(`未关闭：${failed.join('、')}。请确认各终端状态后重试。`);
      return false;
    }
    if (all || !remaining.length) callbacks.current.onClose();
    return true;
  }
  const actions = useRef({ remove, show, createProject });
  actions.current = { remove, show, createProject };
  const closeAll = useCallback(() => {
    if (closePending.current) return closePending.current;
    closePending.current = actions.current.remove(tabsRef.current, true).finally(() => {
      closePending.current = null;
    });
    return closePending.current;
  }, []);
  useEffect(() => {
    callbacks.current.register?.({
      closeAll,
      show,
      create: (project) => actions.current.createProject(project),
    });
    return () => {
      callbacks.current.register?.(null);
      confirmResult.current?.(false);
    };
  }, [closeAll, show]);
  useEffect(() => {
    const bridge = window.desktop?.terminalWindow;
    if (!bridge) {
      setFallback(true);
      return;
    }
    let disposed = false,
      popup: Window | null = null;
    let unsubscribe = () => {},
      unrequest = () => {},
      unstate = () => {};
    queueMicrotask(() => {
      if (disposed) return;
      popup = window.open('about:blank', 'cc-native-terminal', 'popup,width=1000,height=680');
      if (!popup) {
        setFallback(true);
        return;
      }
      popupRef.current = popup;
      popup.opener = null;
      popup.document.title = 'CC Space · 原生终端';
      popup.document.documentElement.dataset.theme =
        document.documentElement.dataset.theme ?? 'dark';
      popup.document.documentElement.style.cssText = document.documentElement.style.cssText;
      const base = popup.document.createElement('base');
      base.href = document.baseURI;
      popup.document.head.append(base);
      for (const style of document.querySelectorAll('link[rel="stylesheet"], style'))
        popup.document.head.append(style.cloneNode(true));
      const layout = popup.document.createElement('style');
      layout.textContent =
        'html,body,#terminal-window-root{width:100%;height:100%;margin:0;overflow:hidden}#terminal-window-root{display:flex;flex-direction:column}';
      popup.document.head.append(layout);
      const root = popup.document.createElement('div');
      root.id = 'terminal-window-root';
      popup.document.body.append(root);
      unsubscribe = bridge.onClosed(() => {
        if (!disposed) callbacks.current.onClose();
      });
      unrequest =
        bridge.onRequestClose?.(() => {
          void closeAll().then((allowed) => bridge.finishClose?.(allowed));
        }) ?? (() => {});
      unstate = bridge.onState?.((state) => setMaximized(state.maximized)) ?? (() => {});
      setContainer(root);
      void bridge.focus();
    });
    return () => {
      disposed = true;
      unsubscribe();
      unrequest();
      unstate();
      popupRef.current = null;
      if (popup && !popup.closed) {
        if (bridge.control) void bridge.control('destroy');
        else popup.close();
      }
    };
  }, [closeAll]);
  useEffect(() => {
    if (!container) return;
    let disposed = false;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      container.ownerDocument.documentElement.dataset.theme =
        document.documentElement.dataset.theme;
      container.ownerDocument.documentElement.style.cssText =
        document.documentElement.style.cssText;
      const preference = document.documentElement.dataset.theme;
      const theme =
        preference === 'dark' || preference === 'light'
          ? preference
          : media.matches
            ? 'dark'
            : 'light';
      void window.desktop?.terminalWindow.appearance?.(theme).then(
        (result) => {
          if (!disposed) setNativeControls(result.nativeControls);
        },
        () => {
          if (!disposed) setNativeControls(false);
        },
      );
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    sync();
    media.addEventListener('change', sync);
    return () => {
      disposed = true;
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, [container]);
  useEffect(() => {
    if (!tabs.some((tab) => tab.tabId === activeId) && tabs[0]) setActiveId(tabs[0].tabId);
  }, [tabs, activeId]);
  const dismissConfirm = () => {
    confirmResult.current?.(false);
    confirmResult.current = null;
    setConfirm(null);
  };
  const projectName = (session: Session) =>
    prefs.projectNames[
      projectPreferenceKey(
        projectScope,
        session.device?.id === state.device?.id ? undefined : session.device?.id,
        session.projectPath,
      )
    ] || folderName(session.projectPath);
  const matchingTabs = tabs.filter((tab) =>
    [
      tab.alias,
      projectName(sourceOf(tab)),
      folderName(tab.source.projectPath),
      tab.source.projectPath,
      nodeName,
      tab.source.device?.name ?? '',
    ]
      .join('\n')
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()),
  );
  const matchingChoices = choices.filter((choice) =>
    `${choice.name} ${choice.deviceName} ${choice.source?.device?.name ?? (choice.deviceId === state.device?.id ? state.device.name : '')} ${choice.path}`
      .toLocaleLowerCase()
      .includes(filter.trim().toLocaleLowerCase()),
  );
  const menuCount = matchingTabs.length + matchingChoices.length;
  const selectedIndex = Math.min(menuIndex, menuCount - 1);
  const selectedMenuTab = matchingTabs[selectedIndex];
  const selectedChoice = matchingChoices[selectedIndex - matchingTabs.length];
  useEffect(() => {
    if (menu)
      (container?.ownerDocument ?? document)
        .getElementById(
          selectedMenuTab
            ? `terminal-result-${selectedMenuTab.tabId}`
            : `terminal-choice-${encodeURIComponent(selectedChoice?.key ?? '')}`,
        )
        ?.scrollIntoView({ block: 'nearest' });
  }, [menu, selectedMenuTab?.tabId, selectedChoice?.key, container]);
  const finishMenu = (tabId = activeId) => {
    setMenu(false);
    setActiveId(tabId);
    handles.current.get(tabId)?.focus();
  };
  const positionMenu = useCallback(() => {
    const button = menuButton.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const viewport = button.ownerDocument.defaultView?.innerWidth ?? window.innerWidth;
    const width = Math.min(420, viewport - 16);
    setMenuPosition({
      left: Math.max(8, Math.min(rect.left, viewport - width - 8)),
      top: rect.bottom + 4,
      width,
    });
  }, []);
  function toggleMenu() {
    if (menu) {
      setMenu(false);
      menuButton.current?.focus();
      return;
    }
    positionMenu();
    setFilter('');
    setMenuIndex(0);
    setMenu(true);
  }
  useEffect(() => {
    if (!menu) return;
    const view = menuButton.current?.ownerDocument.defaultView;
    view?.addEventListener('resize', positionMenu);
    return () => view?.removeEventListener('resize', positionMenu);
  }, [menu, positionMenu, container, fallback]);
  function shortcut(event: KeyboardEvent) {
    if (
      event.isComposing ||
      composing.current ||
      event.altKey ||
      event.metaKey ||
      !event.ctrlKey ||
      event.type !== 'keydown'
    )
      return false;
    if (event.shiftKey && event.key.toLowerCase() === 't') {
      if (multi && connected && !closing && active && activeSource) add(activeSource);
    } else if (event.shiftKey && (event.key === ' ' || event.code === 'Space')) toggleMenu();
    else if (event.key === 'Tab') {
      const index = tabsRef.current.findIndex((tab) => tab.tabId === activeId);
      const next =
        tabsRef.current[
          (index + (event.shiftKey ? tabsRef.current.length - 1 : 1)) % tabsRef.current.length
        ];
      if (next) finishMenu(next.tabId);
    } else return false;
    return true;
  }
  const shortcutRef = useRef(shortcut);
  shortcutRef.current = shortcut;
  useEffect(() => {
    const doc = container?.ownerDocument ?? (fallback ? document : null);
    if (!doc) return;
    const keydown = (event: KeyboardEvent) => {
      if (fallback && !(event.target as Element)?.closest('.terminal-workspace')) return;
      if ((event.target as Element)?.closest('.xterm')) return;
      if (shortcutRef.current(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    doc.addEventListener('keydown', keydown, true);
    return () => doc.removeEventListener('keydown', keydown, true);
  }, [container, fallback]);
  function renameTab(tab: Tab) {
    setActiveId(tab.tabId);
    setAlias(tab.alias);
    setRename(tab.tabId);
  }
  const content = (
    <div className="terminal-workspace" data-native-controls={nativeControls}>
      <header
        className="terminal-tabs-header"
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget)
            void window.desktop?.terminalWindow.control?.('maximize');
        }}
      >
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {tabs.map((tab) => (
            <div
              className={`terminal-tab ${tab.tabId === activeId ? 'active' : ''}`}
              data-phase={tab.phase}
              key={tab.tabId}
            >
              <button
                role="tab"
                aria-selected={tab.tabId === activeId}
                aria-controls={`terminal-${tab.tabId}`}
                id={`tab-${tab.tabId}`}
                title={`${tab.alias || folderName(sourceOf(tab).projectPath)} · ${sourceOf(tab).device?.name ?? '本机'} · ${sourceOf(tab).projectPath} · ${tab.detail}`}
                onClick={() => setActiveId(tab.tabId)}
                onDoubleClick={() => renameTab(tab)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  renameTab(tab);
                }}
              >
                <span>{tab.alias || folderName(tab.source.projectPath)}</span>
                {mixedDevices && deviceLabel(sourceOf(tab).device, state.device?.id) && (
                  <span className="terminal-tab-device">
                    {deviceLabel(sourceOf(tab).device, state.device?.id)}
                  </span>
                )}
                {!live(tab) && (
                  <span className="terminal-tab-ended">
                    {tab.phase === 'disconnected'
                      ? '连接中断'
                      : tab.phase === 'failed'
                        ? '启动失败'
                        : '已结束'}
                  </span>
                )}
                <small>{tab.detail}</small>
              </button>
              <IconButton
                title={`关闭${tab.alias || folderName(tab.source.projectPath)}`}
                size="sm"
                disabled={closing}
                onClick={() => {
                  void remove([tab], false);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2 2 10 10M10 2 2 10" fill="none" stroke="currentColor" />
                </svg>
              </IconButton>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={multi ? '新建终端' : '服务端升级后可使用多终端'}
          title={
            activeSource
              ? `新建终端 · ${projectName(activeSource)}${deviceLabel(activeSource.device, state.device?.id) ? ` · ${deviceLabel(activeSource.device, state.device?.id)}` : ''}`
              : '新建终端'
          }
          aria-description={
            activeSource
              ? `新建终端 · ${projectName(activeSource)}${deviceLabel(activeSource.device, state.device?.id) ? ` · ${deviceLabel(activeSource.device, state.device?.id)}` : ''}`
              : undefined
          }
          disabled={!multi || !connected || closing || !active}
          onClick={() => activeSource && add(activeSource)}
        >
          <Plus scale="sm" />
        </button>
        {previewAvailable && (
          <Button size="xs" variant="ghost" data-preview-toggle onClick={preview.toggle}>
            预览
          </Button>
        )}
        <button
          ref={menuButton}
          type="button"
          className="icon-button"
          title="切换或新建终端"
          aria-label="切换或新建终端"
          aria-expanded={menu}
          onClick={toggleMenu}
        >
          <ChevronDown scale="sm" />
        </button>
        <div className="terminal-title-actions" ref={setToolbar} />
        {!fallback && !nativeControls && (
          <div className="terminal-window-controls">
            <IconButton
              title="最小化"
              onClick={() => {
                void window.desktop?.terminalWindow.control?.('minimize');
              }}
            >
              −
            </IconButton>
            <IconButton
              title={maximized ? '还原窗口' : '最大化窗口'}
              onClick={() => {
                void window.desktop?.terminalWindow.control?.('maximize');
              }}
            >
              {maximized ? '❐' : '□'}
            </IconButton>
            <IconButton
              title="关闭全部终端"
              onClick={() => {
                void closeAll();
              }}
            >
              <X scale="sm" />
            </IconButton>
          </div>
        )}
      </header>
      {menu && (
        <div
          className="terminal-list"
          aria-label="切换或新建终端"
          style={{
            ...menuPosition,
            position: 'fixed',
            right: 'auto',
            maxHeight: 'calc(100vh - 80px)',
            overflowY: 'auto',
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composing.current) return;
            const listTarget = (event.target as Element).closest(
              '.terminal-list-search, [role="option"]',
            );
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMenu(false);
              menuButton.current?.focus();
            } else if (listTarget && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              if (menuCount)
                setMenuIndex(
                  (index) =>
                    (Math.min(index, menuCount - 1) +
                      (event.key === 'ArrowDown' ? 1 : menuCount - 1)) %
                    menuCount,
                );
            } else if (listTarget && event.key === 'Enter' && (selectedMenuTab || selectedChoice)) {
              event.preventDefault();
              if (selectedMenuTab) finishMenu(selectedMenuTab.tabId);
              else chooseProject(selectedChoice);
            }
          }}
        >
          <label className="terminal-list-search">
            <Search />
            <input
              autoFocus
              aria-label="搜索项目、设备或已打开的终端"
              placeholder="搜索项目、设备或已打开的终端"
              value={filter}
              aria-controls="terminal-results"
              aria-activedescendant={
                selectedMenuTab
                  ? `terminal-result-${selectedMenuTab.tabId}`
                  : selectedChoice
                    ? `terminal-choice-${encodeURIComponent(selectedChoice.key)}`
                    : undefined
              }
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onChange={(event) => {
                setFilter(event.target.value);
                setMenuIndex(0);
              }}
            />
          </label>
          <div id="terminal-results" role="listbox" aria-label="匹配终端和项目">
            <section role="group" aria-label="已打开">
              <h3 className="terminal-list-group">已打开</h3>
              {matchingTabs.map((tab, index) => (
                <button
                  type="button"
                  key={tab.tabId}
                  id={`terminal-result-${tab.tabId}`}
                  className="terminal-list-row"
                  role="option"
                  data-phase={tab.phase}
                  aria-selected={selectedIndex === index}
                  title={`${tab.alias || projectName(sourceOf(tab))} · ${tab.source.projectPath}`}
                  onMouseEnter={() => setMenuIndex(index)}
                  onFocus={() => setMenuIndex(index)}
                  onClick={() => finishMenu(tab.tabId)}
                >
                  <span className="terminal-list-name">
                    {tab.alias || projectName(sourceOf(tab))}
                    {deviceLabel(sourceOf(tab).device, state.device?.id) && (
                      <small> · {deviceLabel(sourceOf(tab).device, state.device?.id)}</small>
                    )}
                  </span>
                  <small className="terminal-list-status">
                    {tab.phase === 'running'
                      ? sourceOf(tab).activeRun?.activity === 'waiting'
                        ? '终端等你确认'
                        : '终端运行中'
                      : ['opening', 'creating'].includes(tab.phase)
                        ? '终端打开中'
                        : tab.detail}
                  </small>
                  <small className="terminal-list-path">{tab.source.projectPath}</small>
                  {selectedIndex === index && <small className="terminal-list-hint">↵ 切换</small>}
                </button>
              ))}
            </section>
            <section role="group" aria-label="新建终端">
              <h3 className="terminal-list-group">新建终端</h3>
              {matchingChoices.map((choice, index) => {
                const target = sshTargets.find((target) => target.id === choice.deviceId);
                const offline = target && target.status !== 'connected';
                const label = deviceLabel(
                  { id: choice.deviceId, name: choice.deviceName },
                  state.device?.id,
                );
                const defaults = choice.source ?? {
                  permissionMode: newTerminalPermission,
                  ...sessionDefaultOptions(prefs.sessionDefaults, state.capabilities?.models),
                };
                const permissions = {
                  auto: '自动审批',
                  default: '手动审批',
                  acceptEdits: '接受编辑',
                  plan: '计划模式',
                  bypassPermissions: '绕过权限',
                };
                return (
                  <button
                    type="button"
                    role="option"
                    className="terminal-project-choice"
                    key={choice.key}
                    id={`terminal-choice-${encodeURIComponent(choice.key)}`}
                    aria-label={`${choice.name}${label ? ` · ${label}` : ''}`}
                    aria-selected={selectedIndex === index + matchingTabs.length}
                    data-offline={offline || undefined}
                    title={`${choice.path} · ${defaults.model ?? '默认模型'} · ${permissions[defaults.permissionMode]} · ${defaults.effort ? effortNames[defaults.effort] : '默认强度'}`}
                    disabled={!multi || !connected || closing}
                    onMouseEnter={() => setMenuIndex(index + matchingTabs.length)}
                    onFocus={() => setMenuIndex(index + matchingTabs.length)}
                    onClick={() => chooseProject(choice)}
                  >
                    <span>
                      {choice.name}
                      {label && <small>{label}</small>}
                    </span>
                    <small className="terminal-project-meta">{choice.path}</small>
                    <small className="terminal-list-hint">
                      {[
                        offline ? '离线' : choice.source?.id === activeSource?.id ? '当前' : '',
                        selectedIndex === index + matchingTabs.length ? '↵ 新建' : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </button>
                );
              })}
            </section>
            {!menuCount && <p role="status">没有匹配的项目或终端</p>}
          </div>
          <hr />
          <button
            type="button"
            className="terminal-list-action"
            disabled={!multi || !connected || closing}
            onClick={() => {
              setMenu(false);
              setOpenProject({});
            }}
          >
            <Plus />
            打开其他目录…
          </button>
          {state.terminalHistory && (
            <button
              type="button"
              className="terminal-list-action"
              disabled={!connected || closing || !active}
              onClick={() => {
                setHistorySource(active.source);
                setMenu(false);
              }}
            >
              <ScrollText />
              继续官方历史…
            </button>
          )}
        </div>
      )}
      {closeError && <p role="alert">{closeError}</p>}
      <div className="terminal-panels">
        {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className="terminal-panel"
            id={`terminal-${tab.tabId}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab.tabId}`}
            hidden={tab.tabId !== activeId}
          >
            {tab.sessionId ? (
              <NativeTerminal
                client={client}
                sessionId={tab.sessionId}
                active={tab.tabId === activeId}
                toolbar={toolbar}
                onShortcut={shortcut}
                onClose={() => {
                  void remove([tab], false);
                }}
                register={(handle) => {
                  if (handle) {
                    handles.current.set(tab.tabId, handle);
                    queueMicrotask(() => {
                      const current = handles.current.get(tab.tabId);
                      if (current) {
                        waitingHandles.current.get(tab.tabId)?.(current);
                        waitingHandles.current.delete(tab.tabId);
                      }
                    });
                  } else handles.current.delete(tab.tabId);
                }}
                onStatus={(phase, detail) => patch(tab.tabId, { phase, detail })}
                onLink={(raw) => {
                  const target = terminalTarget(raw);
                  const here =
                    !!window.desktop?.preview &&
                    !state.browser &&
                    tab.source.device?.id === state.device?.id;
                  if (target.kind === 'web') {
                    if (here && previewWebsite(target.value)) preview.openWebsite(target.value);
                    else if (previewWebsite(target.value))
                      setLinkError('这是远端设备的网址，不能按 Windows 本机网站预览。');
                    else void followLink({ kind: 'web', url: target.value }, setLinkError);
                  } else if (here && /^(?:[a-z]:[\\/])/i.test(target.value)) {
                    const path = /^file:/i.test(raw)
                      ? target.value
                      : target.value.replace(/:\d+(?::\d+)?$/, '');
                    preview.openFile(path, tab.source.projectPath);
                  } else setFile({ raw, source: tab.source });
                }}
              />
            ) : (
              <div className="terminal-create-status">
                <p role="status">{tab.detail}</p>
                {tab.error && <p role="alert">{tab.error}</p>}
                {['unknown', 'failed'].includes(tab.phase) && (
                  <Button
                    onClick={() => {
                      const retry =
                        tab.phase === 'failed' ? { ...tab, createId: crypto.randomUUID() } : tab;
                      patch(tab.tabId, { createId: retry.createId });
                      void create(retry);
                    }}
                  >
                    {tab.phase === 'failed' ? '重试创建' : '确认创建结果'}
                  </Button>
                )}
              </div>
            )}
            {['ended', 'disconnected'].includes(tab.phase) && (
              <Button size="sm" disabled={!multi || !connected} onClick={() => add(sourceOf(tab))}>
                新开同项目终端
              </Button>
            )}
            <TerminalDraft
              session={tab.source}
              phase={tab.phase}
              handle={() => handles.current.get(tab.tabId)}
              attachmentsAllowed={
                !!window.desktop &&
                !state.browser &&
                connected &&
                tab.source.device?.id === state.device?.id
              }
            />
          </div>
        ))}
      </div>
      {/* Where this terminal works, as plainly as a status bar says it: the project's path and its computer (G5). */}
      <footer
        className="terminal-workspace-footer"
        title={`${activeSource?.device?.name ?? '本机'} · ${activeSource?.projectPath ?? ''} · ${nodeName}`}
      >
        <span>{activeSource?.projectPath}</span>
        {deviceLabel(activeSource?.device, state.device?.id) && (
          <span>{deviceLabel(activeSource?.device, state.device?.id)}</span>
        )}
      </footer>
      {linkError && <p role="alert">{linkError}</p>}
      {historySource && (
        <TerminalHistory
          client={client}
          source={historySource}
          onClose={() => {
            setHistorySource(null);
            handles.current.get(activeId)?.focus();
          }}
          onContinue={(historySessionId) => {
            add(historySource, undefined, historySessionId);
            setHistorySource(null);
          }}
        />
      )}
      {file && (
        <TerminalFile
          key={`${file.source.id}:${file.raw}`}
          client={client}
          session={file.source}
          raw={file.raw}
          nodeName={nodeName}
          onClose={() => {
            setFile(null);
            handles.current.get(activeId)?.focus();
          }}
        />
      )}
      {confirm && (
        <Modal
          initialFocus="[data-terminal-cancel]"
          title={confirm.length === 1 ? '关闭终端？' : '关闭全部终端？'}
          onClose={() => {
            if (!closing) dismissConfirm();
          }}
        >
          <p>
            {confirm.some((tab) => tab.phase === 'disconnected')
              ? '连接中断的终端只关闭本地显示，尚未确认远端进程是否结束，恢复连接后请检查。其他所选终端将结束进程；已执行的文件修改保留。'
              : `将结束所选 ${confirm.length} 个终端进程，已执行的文件修改不会撤销。`}
          </p>
          <div className="dialog-actions">
            <Button autoFocus data-terminal-cancel onClick={dismissConfirm}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                confirmResult.current?.(true);
                confirmResult.current = null;
                setConfirm(null);
              }}
            >
              {confirm.some((tab) => tab.phase === 'disconnected') ? '关闭所选终端' : '结束终端'}
            </Button>
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="标签别名" onClose={() => setRename(null)}>
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (rename) patch(rename, { alias: alias.trim() });
              setRename(null);
            }}
          >
            <label>
              仅在当前窗口生效
              <input
                autoFocus
                value={alias}
                maxLength={120}
                onChange={(event) => setAlias(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <Button onClick={() => setRename(null)}>取消</Button>
              <Button type="submit" variant="primary">
                保存
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {openProject && (
        <OpenProjectDialog
          client={client}
          initial={openProject}
          forceNew
          onClose={() => setOpenProject(null)}
          onLocal={async (path) => {
            if (!activeSource) throw new Error('当前终端项目不可用，请重新打开终端。');
            add(
              {
                ...activeSource,
                device: state.device ?? undefined,
                permissionMode: newTerminalPermission,
                ...sessionDefaultOptions(getPrefs().sessionDefaults, state.capabilities?.models),
              },
              path,
            );
          }}
          onRemote={async (id, created) => {
            const selected = client.state.sessions.find((session) => session.id === id);
            if (!selected) throw new Error('项目会话正在同步，请稍后重试。');
            const source = openProject.source;
            const inherited =
              source &&
              source.device?.id === selected.device?.id &&
              pathKey(source.projectPath) === pathKey(selected.projectPath)
                ? source
                : undefined;
            const defaults = inherited
              ? { model: inherited.model, effort: inherited.effort }
              : sessionDefaultOptions(getPrefs().sessionDefaults, state.capabilities?.models);
            if (created)
              await client.request({
                type: 'session.configure',
                sessionId: id,
                permissionMode: inherited?.permissionMode ?? newTerminalPermission,
                ...defaults,
              });
            show(id);
          }}
        />
      )}
    </div>
  );
  return (
    <>
      {!fallback && (
        <div className="terminal-window-notice" role="status">
          <span>原生终端已在独立窗口打开 · {tabs.length} 个标签</span>
          <div className="terminal-window-actions">
            <Button size="sm" onClick={() => show()}>
              <SquareTerminal scale="sm" />
              显示终端
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void closeAll();
              }}
            >
              <X scale="sm" />
              关闭全部终端
            </Button>
          </div>
        </div>
      )}
      {fallback ? (
        <div className="terminal-preview-layout">
          {content}
          {previewShown && (
            <PreviewSidebar
              workspace={preview}
              surface="inline-terminal"
              root={active?.source.projectPath}
            />
          )}
        </div>
      ) : (
        container &&
        createPortal(
          <div className="terminal-preview-layout">
            {content}
            {previewShown && (
              <PreviewSidebar
                workspace={preview}
                surface="terminal"
                root={active?.source.projectPath}
              />
            )}
          </div>,
          container,
        )
      )}
    </>
  );
}
