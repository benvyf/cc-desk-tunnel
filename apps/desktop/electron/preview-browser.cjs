const { randomUUID } = require('node:crypto');
const { localWebsite } = require('./preview-files.cjs');

function createPreviewBrowser({ owner, recipient, surface, WebContentsView, session, files }) {
  const partition = session.fromPartition(`preview-${randomUUID()}`);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', (event) => event.preventDefault());
  const views = new Map();
  const urls = new Map();
  let current;
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
    show({ key, url, bounds }) {
      if (typeof key !== 'string' || key.length > 200 || !allowed(url))
        throw new Error('无效的本机预览地址。');
      let view = views.get(key);
      for (const [id, other] of views) other.setVisible(id === key);
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
              state(key, view, '', { kind: 'web', target });
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
        void view.webContents.loadURL(url).catch(() => {});
      }
      current = key;
      controller.bounds(bounds);
      state(key, view);
    },
    bounds(bounds) {
      const view = views.get(current);
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
    hide() {
      for (const view of views.values()) view.setVisible(false);
    },
    action({ key, action, url }) {
      const view = views.get(key);
      if (!view) return;
      const contents = view.webContents;
      if (action === 'go') {
        const target = localWebsite(url);
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
  });
  return controller;
}
module.exports = { createPreviewBrowser };
