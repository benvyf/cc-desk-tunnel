// Website content gets its own persistent session, never CC's preload or IPC.
const sessionCleanup = new WeakMap();

async function stopSessionWorkers(WebContentsView, ses) {
  // A separate blank target also works after the website renderer/window dies.
  // Stop execution without deleting registrations, cookies or other login data.
  const cleanup = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  }).webContents;
  try {
    cleanup.debugger.attach('1.3');
    await cleanup.debugger.sendCommand('ServiceWorker.enable');
    await cleanup.debugger.sendCommand('ServiceWorker.stopAllWorkers');
  } finally {
    if (!cleanup.isDestroyed()) {
      if (cleanup.debugger.isAttached()) cleanup.debugger.detach();
      await new Promise((resolve) => {
        cleanup.once('destroyed', resolve);
        cleanup.close();
      });
    }
  }
}

function secureWebsite(value) {
  try {
    const url = new URL(value);
    return (
      ['https:', 'wss:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443')
    );
  } catch {
    return false;
  }
}

async function createBrowserView({
  electron,
  window,
  proxy,
  partition,
  url = 'https://claude.ai/',
  onState = () => {},
  signal,
}) {
  if (!secureWebsite(url) || !url.startsWith('https:')) throw new Error('Invalid website entry');
  const { session, WebContentsView } = electron;
  const ses = session.fromPartition(partition);
  // Failed cleanup must leave this session closed, including on the next open.
  await sessionCleanup.get(ses);
  let closed = false;
  let closing;
  let view;
  let visible = false;
  const downloads = new Set();
  // Keep this gate installed after closing: background workers must not regain
  // network access when the visible website has gone away.
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel: closed || !(secureWebsite(details.url) || /^(data|blob):/.test(details.url)),
    }),
  );
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  const close = () => {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', abort);
    for (const item of downloads) item.cancel();
    let destroyed = Promise.resolve();
    if (view && !view.webContents.isDestroyed()) {
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      destroyed = new Promise((resolve) => view.webContents.once('destroyed', resolve));
      view.webContents.close();
    }
    ses.removeListener('will-download', download);
    closing = Promise.all([
      Promise.allSettled([ses.closeAllConnections(), proxy.close()]),
      destroyed.then(() => stopSessionWorkers(WebContentsView, ses)),
    ]).then(() => ses.flushStorageData());
    sessionCleanup.set(ses, closing);
    return closing;
  };
  const download = (event, item, contents) => {
    if (closed || contents !== view?.webContents) {
      event.preventDefault();
      return;
    }
    downloads.add(item);
    item.once('done', () => downloads.delete(item));
    // Electron owns the save path decision. A second async showSaveDialog here
    // races its native download dialog while getSavePath() is still empty.
    item.setSaveDialogOptions({ title: '保存附件' });
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Browser cancelled');
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: proxy.proxyRules,
      proxyBypassRules: '<-loopback>',
    });
    await ses.closeAllConnections();
    if (closed) throw new Error('Browser cancelled');
    view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });
    const contents = view.webContents;
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.on('login', (event, _details, info, callback) => {
      event.preventDefault();
      if (
        !closed &&
        info.isProxy &&
        info.host === '127.0.0.1' &&
        info.port === proxy.port &&
        info.scheme === 'basic' &&
        info.realm === 'cc-browser'
      )
        callback(proxy.username, proxy.password);
      else callback();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => {
      if (!secureWebsite(event.url) || !event.url.startsWith('https:')) event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => {
      // Keep ordinary links in the exact same controlled session. Do not replay
      // POST popups or hand custom protocols to the operating system.
      if (
        !closed &&
        !details.postBody &&
        secureWebsite(details.url) &&
        details.url.startsWith('https:')
      )
        void contents.loadURL(details.url).catch(() => onState('unavailable'));
      return { action: 'deny' };
    });
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!closed && mainFrame && code !== -3) onState('unavailable');
    });
    contents.on('render-process-gone', () => {
      if (!closed) {
        onState('unavailable');
        void close().catch(() => {});
      }
    });
    ses.on('will-download', download);
    view.setVisible(false);
    window.contentView.addChildView(view);
    await contents.loadURL(url);
    if (closed) throw new Error('Browser closed');
    return {
      contents,
      close,
      setVisible(active) {
        visible = active === true;
        if (!closed) view.setVisible(visible);
      },
      setBounds(bounds) {
        if (
          closed ||
          !bounds ||
          !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))
        )
          return;
        const area = window.getContentBounds();
        const x = Math.min(area.width, Math.max(0, Math.round(bounds.x)));
        const y = Math.min(area.height, Math.max(0, Math.round(bounds.y)));
        const width = Math.min(area.width - x, Math.max(0, Math.round(bounds.width)));
        const height = Math.min(area.height - y, Math.max(0, Math.round(bounds.height)));
        view.setBounds({ x, y, width, height });
        view.setVisible(visible && width > 0 && height > 0);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { createBrowserView };
