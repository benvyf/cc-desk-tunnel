import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Session } from '@cc-desk-tunnel/protocol';
import NativeTerminal, { type TerminalHandle, type TerminalPhase } from './NativeTerminal.tsx';
import { RequestFailedError, type ProxyClient } from './client.ts';
import { SquareTerminal, X, Plus, ChevronDown } from './icons.tsx';
import { Button, IconButton, Modal } from './ui.tsx';
import { folderName } from './paths.ts';
import { terminalTarget } from './terminalLinks.ts';
import { followLink } from './linkActions.ts';
import TerminalFile from './TerminalFile.tsx';
import TerminalDraft from './TerminalDraft.tsx';
import TerminalHistory from './TerminalHistory.tsx';

export type TerminalWorkspaceHandle = {
  closeAll: () => Promise<boolean>;
  show: (sessionId?: string) => void;
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
  register,
  nodeName = '当前连接节点',
}: {
  client: ProxyClient;
  sessionId: string;
  onClose: () => void;
  onActivity?: (active: boolean) => void;
  register?: (handle: TerminalWorkspaceHandle | null) => void;
  nodeName?: string;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
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
  const [menu, setMenu] = useState(false);
  const [filter, setFilter] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  const [rename, setRename] = useState(false);
  const [alias, setAlias] = useState('');
  const [project, setProject] = useState(false);
  const [projectSource, setProjectSource] = useState(sessionId);
  const [projectPath, setProjectPath] = useState('');
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
  const callbacks = useRef({ onClose, onActivity, register });
  callbacks.current = { onClose, onActivity, register };
  const patch = useCallback((tabId: string, values: Partial<Tab>) => {
    setTabs((current) => current.map((tab) => (tab.tabId === tabId ? { ...tab, ...values } : tab)));
  }, []);
  const active = tabs.find((tab) => tab.tabId === activeId) ?? tabs[0];
  const multi = state.terminalWorkspace?.version === 1;
  const connected = state.status === 'connected';
  const anyLive = tabs.some(live);
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
          const source = client.state.sessions.find((session) => session.id === id);
          if (!source) return;
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
          tab.historySessionId ? {
            type: 'terminal.history.continue', sessionId: tab.source.id,
            historySessionId: tab.historySessionId, confirmed: true,
          } : {
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
    if (!multi || !connected || closing) return;
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
  async function remove(targets: Tab[], all: boolean): Promise<boolean> {
    if (closing || confirmResult.current) return false;
    if (targets.some(live)) {
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
      const done = !live(tab) || (control ? await control.close() : false);
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
  const actions = useRef({ remove, show });
  actions.current = { remove, show };
  const closeAll = useCallback(() => {
    if (closePending.current) return closePending.current;
    closePending.current = actions.current.remove(tabsRef.current, true).finally(() => {
      closePending.current = null;
    });
    return closePending.current;
  }, []);
  useEffect(() => {
    callbacks.current.register?.({ closeAll, show });
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
      popup.document.title = 'CC SPACE · 原生终端';
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
    const observer = new MutationObserver(() => {
      container.ownerDocument.documentElement.dataset.theme =
        document.documentElement.dataset.theme;
      container.ownerDocument.documentElement.style.cssText =
        document.documentElement.style.cssText;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, [container]);
  useEffect(() => {
    if (!tabs.some((tab) => tab.tabId === activeId) && tabs[0]) setActiveId(tabs[0].tabId);
  }, [tabs, activeId]);
  const dismissConfirm = () => {
    confirmResult.current?.(false);
    confirmResult.current = null;
    setConfirm(null);
  };
  const matchingTabs = tabs.filter((tab) =>
    [tab.alias, folderName(tab.source.projectPath), tab.source.projectPath, nodeName,
      tab.source.device?.name ?? ''].join('\n').toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  const selectedMenuTab = matchingTabs[Math.min(menuIndex, matchingTabs.length - 1)];
  useEffect(() => {
    if (menu && selectedMenuTab)
      (container?.ownerDocument ?? document).getElementById(`terminal-result-${selectedMenuTab.tabId}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [menu, selectedMenuTab?.tabId, container]);
  const finishMenu = (tabId = activeId) => {
    setMenu(false);
    setActiveId(tabId);
    handles.current.get(tabId)?.focus();
  };
  const content = (
    <div className="terminal-workspace">
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
                title={`${tab.alias || folderName(tab.source.projectPath)} · ${tab.detail}`}
                onClick={() => setActiveId(tab.tabId)}
              >
                <span>{tab.alias || folderName(tab.source.projectPath)}</span>
                {!live(tab) && <span className="terminal-tab-ended">已结束</span>}
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
        <IconButton
          title={multi ? '新建终端' : '服务端升级后可使用多终端'}
          disabled={!multi || !connected || closing || !active}
          onClick={() => active && add(active.source)}
        >
          <Plus scale="sm" />
        </IconButton>
        <IconButton
          title="全部终端"
          aria-expanded={menu}
          onClick={() => {
            if (menu) finishMenu();
            else { setFilter(''); setMenuIndex(0); setMenu(true); }
          }}
        >
          <ChevronDown scale="sm" />
        </IconButton>
        {!fallback && (
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
        <div className="terminal-list" aria-label="全部终端列表" onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            finishMenu();
          }
        }}>
          <input autoFocus aria-label="筛选终端" placeholder="搜索别名、项目或节点"
            value={filter} aria-controls="terminal-results"
            aria-activedescendant={selectedMenuTab ? `terminal-result-${selectedMenuTab.tabId}` : undefined}
            onChange={(event) => { setFilter(event.target.value); setMenuIndex(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (matchingTabs.length) setMenuIndex((index) =>
                  (Math.min(index, matchingTabs.length - 1) + (event.key === 'ArrowDown' ? 1 : matchingTabs.length - 1)) % matchingTabs.length);
              } else if (event.key === 'Enter' && selectedMenuTab) {
                event.preventDefault(); finishMenu(selectedMenuTab.tabId);
              }
            }} />
          <div id="terminal-results" role="listbox" aria-label="匹配终端">
          {!matchingTabs.length && <p role="status">没有匹配的终端</p>}
          {matchingTabs.map((tab) => (
            <Button
              key={tab.tabId}
              id={`terminal-result-${tab.tabId}`}
              role="option"
              aria-selected={selectedMenuTab?.tabId === tab.tabId}
              title={`${tab.alias || folderName(tab.source.projectPath)} · ${tab.source.projectPath} · ${nodeName} · ${tab.source.device?.name ?? ''}`}
              size="sm"
              onClick={() => finishMenu(tab.tabId)}
            >
              {tab.alias || folderName(tab.source.projectPath)} · {tab.detail}
              <small>{tab.source.projectPath} · {nodeName} · {tab.source.device?.name}</small>
            </Button>
          ))}
          </div>
          <Button
            size="sm"
            disabled={!multi || !connected || closing}
            onClick={() => {
              setProject(true);
              setMenu(false);
            }}
          >
            选项目新建
          </Button>
          <Button
            size="sm"
            disabled={!active}
            onClick={() => {
              setAlias(active?.alias ?? '');
              setRename(true);
              setMenu(false);
            }}
          >
            标签别名
          </Button>
          {state.terminalHistory && <Button size="sm" disabled={!connected || closing || !active}
            onClick={() => { setHistorySource(active.source); setMenu(false); }}>继续官方历史</Button>}
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
                  if (target.kind === 'web') void followLink({ kind: 'web', url: target.value }, setLinkError);
                  else setFile({ raw, source: tab.source });
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
              <Button size="sm" disabled={!multi || !connected} onClick={() => add(tab.source)}>
                新开同项目终端
              </Button>
            )}
            <TerminalDraft session={tab.source} phase={tab.phase}
              handle={() => handles.current.get(tab.tabId)}
              attachmentsAllowed={!!window.desktop && !state.browser && connected &&
                tab.source.device?.id === state.device?.id} />
          </div>
        ))}
      </div>
      <footer className="terminal-workspace-footer" title={active?.source.projectPath}>
        <span>项目：{active?.source.projectPath}</span>
        <span>节点：{nodeName}</span>
        <span>项目设备：{active?.source.device?.name ?? '未知'}</span>
        <span>CLI 工作区以终端实际显示为准</span>
      </footer>
      {linkError && <p role="alert">{linkError}</p>}
      {historySource && <TerminalHistory client={client} source={historySource}
        onClose={() => { setHistorySource(null); handles.current.get(activeId)?.focus(); }}
        onContinue={(historySessionId) => { add(historySource, undefined, historySessionId); setHistorySource(null); }} />}
      {file && <TerminalFile key={`${file.source.id}:${file.raw}`} client={client} session={file.source}
        raw={file.raw} nodeName={nodeName} onClose={() => { setFile(null); handles.current.get(activeId)?.focus(); }} />}
      {confirm && (
        <Modal
          initialFocus="[data-terminal-cancel]"
          title={confirm.length === 1 ? '关闭终端？' : '关闭全部终端？'}
          onClose={() => {
            if (!closing) dismissConfirm();
          }}
        >
          <p>将结束所选 {confirm.length} 个终端进程，已执行的文件修改不会撤销。</p>
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
              结束终端
            </Button>
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="标签别名" onClose={() => setRename(false)}>
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (active) patch(active.tabId, { alias: alias.trim() });
              setRename(false);
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
              <Button onClick={() => setRename(false)}>取消</Button>
              <Button type="submit" variant="primary">
                保存
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {project && (
        <Modal title="选项目新建终端" onClose={() => setProject(false)}>
          <form
            className="dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              const chosen = state.sessions.find((session) => session.id === projectSource);
              if (chosen) {
                add(chosen, projectPath.trim() || undefined);
                setProject(false);
              }
            }}
          >
            <label>
              已有项目
              <select
                value={projectSource}
                onChange={(event) => setProjectSource(event.target.value)}
              >
                {state.sessions
                  .filter((session) => !!session.device)
                  .map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.device?.name} · {session.projectPath}
                    </option>
                  ))}
              </select>
            </label>
            {!state.browser && (
              <label>
                或使用本机项目目录
                <input
                  value={projectPath}
                  maxLength={2048}
                  onChange={(event) => setProjectPath(event.target.value)}
                />
              </label>
            )}
            <p>同目录并行修改可能冲突；需要隔离时选择已有 worktree。</p>
            <div className="dialog-actions">
              <Button onClick={() => setProject(false)}>取消</Button>
              <Button type="submit" variant="primary">
                新建
              </Button>
            </div>
          </form>
        </Modal>
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
      {fallback ? content : container && createPortal(content, container)}
    </>
  );
}
