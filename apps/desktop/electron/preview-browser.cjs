const { randomUUID } = require('node:crypto');
const { localWebsite } = require('./preview-files.cjs');

function createPreviewBrowser({ owner, recipient, surface, WebContentsView, session, files }) {
  const partition = session.fromPartition(`preview-${randomUUID()}`);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', (event) => event.preventDefault());
  const views = new Map();
  const urls = new Map();
  const origins = new Map();
  const current = new Map();
  const panes = new Map();
  // Static files cannot act as a network proxy. Unknown worker requests have no
  // associated trusted view and are denied as well. Preview sessions are isolated from sign-in.
  partition.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const entry = [...views].find(([, view]) => view.webContents.id === details.webContentsId);
    const initial = entry && urls.get(entry[0]);
    let allowed = false;
    try {
      if (initial) {
        const requested = new URL(details.url),
          origin = new URL(initial);
        allowed = files.owns(initial)
          ? requested.origin === origin.origin
          : (origins.get(entry[0])?.has(requested.origin) ?? false);
        if (!files.owns(initial) && ['ws:', 'wss:'].includes(requested.protocol))
          allowed = [...(origins.get(entry[0]) ?? [])].some(
            (value) => new URL(value).host === requested.host,
          );
      }
    } catch {}
    callback({ cancel: !allowed });
  });
  function state(key, view, error = '', open) {
    const contents = view.webContents;
    if (recipient.isDestroyed() || contents.isDestroyed()) return;
    recipient.send('preview:state', {
      surface,
      key,
      url: files.owns(contents.getURL()) ? '' : contents.getURL(),
      title: contents.getTitle(),
      back: contents.navigationHistory.canGoBack(),
      forward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      error,
      ...(open ? { open } : {}),
    });
  }
  const allowed = (url) => {
    if (files.owns(url)) return true;
    try {
      localWebsite(url);
      return true;
    } catch {
      return false;
    }
  };
  const controller = {
    show({ key, url, bounds, pane = 'primary' }) {
      if (typeof key !== 'string' || key.length > 200 || !allowed(url))
        throw new Error('无效的本机预览地址。');
      let view = views.get(key);
      for (const [id, other] of views) if (panes.get(id) === pane) other.setVisible(id === key);
      panes.set(key, pane);
      if (!view) {
        view = new WebContentsView({
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            session: partition,
            backgroundThrottling: true,
          },
        });
        view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        views.set(key, view);
        owner.contentView.addChildView(view);
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const prevent = (event, target) => {
          const initial = urls.get(key);
          if (files.owns(initial)) {
            if (!view.getVisible()) {
              event.preventDefault();
              return;
            }
            if (files.owns(target)) {
              event.preventDefault();
              void Promise.all([files.target(initial), files.target(target)]).then(
                ([original, next]) => {
                  if (
                    views.get(key) !== view ||
                    urls.get(key) !== initial ||
                    !files.owns(initial) ||
                    !view.getVisible() ||
                    view.webContents.isDestroyed()
                  )
                    return;
                  if (!original || !next) state(key, view, '文件不在当前预览工作区内或无法读取。');
                  else if (next.path !== original.path)
                    state(key, view, '', {
                      kind: 'file',
                      target: next.path,
                      root: next.root,
                      restricted: true,
                    });
                  else void view.webContents.loadURL(target).catch(() => {});
                },
              );
              return;
            }
            if (allowed(target)) {
              event.preventDefault();
              state(key, view, '请使用工具栏手动打开本机网站。');
              return;
            }
          }
          if (!allowed(target)) {
            event.preventDefault();
            state(key, view, '此地址请在外部浏览器打开。');
          }
        };
        view.webContents.on('will-navigate', prevent);
        view.webContents.on('will-redirect', prevent);
        view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
          if (mainFrame && code !== -3)
            state(key, view, '页面无法加载，请确认本机开发服务已启动。');
        });
        for (const event of [
          'did-navigate',
          'did-navigate-in-page',
          'page-title-updated',
          'did-start-loading',
          'did-stop-loading',
        ])
          view.webContents.on(event, () => state(key, view));
      }
      if (urls.get(key) !== url) {
        urls.set(key, url);
        origins.set(key, new Set([new URL(url).origin]));
        void view.webContents.loadURL(url).catch(() => {});
      }
      current.set(pane, key);
      controller.bounds(bounds, pane);
      state(key, view);
    },
    bounds(bounds, pane = 'primary') {
      const key = current.get(pane);
      if (panes.get(key) !== pane) return;
      const view = views.get(key);
      if (!view) return;
      if (!bounds) {
        view.setVisible(false);
        return;
      }
      const scale = owner.webContents.getZoomFactor();
      const values = ['x', 'y', 'width', 'height'].map((name) => bounds[name]);
      if (!values.every((value) => typeof value === 'number' && Number.isFinite(value)))
        throw new Error('预览区域无效。');
      const area = owner.getContentBounds();
      const x = Math.max(0, Math.round(bounds.x * scale)),
        y = Math.max(0, Math.round(bounds.y * scale));
      const width = Math.max(0, Math.min(Math.round(bounds.width * scale), area.width - x));
      const height = Math.max(0, Math.min(Math.round(bounds.height * scale), area.height - y));
      view.setBounds({ x, y, width, height });
      view.setVisible(width > 0 && height > 0);
    },
    hide(pane) {
      for (const [key, view] of views) if (!pane || panes.get(key) === pane) view.setVisible(false);
    },
    action({ key, action, url }) {
      const view = views.get(key);
      if (!view) return;
      const contents = view.webContents;
      if (action === 'go') {
        const target = localWebsite(url);
        origins.get(key)?.add(new URL(target).origin);
        void contents.loadURL(target).catch(() => {});
      } else if (action === 'reload') contents.reload();
      else if (action === 'back' && contents.navigationHistory.canGoBack())
        contents.navigationHistory.goBack();
      else if (action === 'forward' && contents.navigationHistory.canGoForward())
        contents.navigationHistory.goForward();
      state(key, view);
    },
    release(key) {
      const view = views.get(key);
      if (!view) return;
      views.delete(key);
      urls.delete(key);
      origins.delete(key);
      panes.delete(key);
      owner.contentView.removeChildView(view);
      view.webContents.close();
    },
  };
  const clear = () => {
    for (const key of [...views.keys()]) controller.release(key);
  };
  const navigation = (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) clear();
  };
  recipient.on('did-start-navigation', navigation);
  recipient.on('render-process-gone', clear);
  owner.once('closed', () => {
    recipient.removeListener('did-start-navigation', navigation);
    recipient.removeListener('render-process-gone', clear);
    for (const view of views.values())
      if (!view.webContents.isDestroyed()) view.webContents.close();
    views.clear();
    urls.clear();
    origins.clear();
    panes.clear();
    current.clear();
  });
  return controller;
}
module.exports = { createPreviewBrowser };
