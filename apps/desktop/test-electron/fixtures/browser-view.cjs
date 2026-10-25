const { app, BrowserWindow, session, WebContentsView, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { X509Certificate } = require('node:crypto');
app.setPath('userData', process.env.CC_TEST_PROFILE);
// Keep the harness alive while asserting cleanup after its parent window dies.
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.whenReady().then(async () => {
  const { createBrowserView } = require('../../electron/browser-view.cjs');
  const { openBrowserNetworkProxy } = await import(
    pathToFileURL(path.resolve(__dirname, '../../electron/browser-network-proxy.mjs')).href
  );
  const window = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL('about:blank');
  global.testStart = async (pathname = '/') => {
    const proxy = await openBrowserNetworkProxy(JSON.parse(process.env.CC_TEST_PROXY));
    const ses = session.fromPartition('persist:owned-web-test');
    // Only this test fixture trusts the exact owned site's certificate. Production
    // never installs a certificate handler or adds any website certificate trust.
    ses.setCertificateVerifyProc((request, callback) =>
      callback(
        request.hostname === 'default.example.test' &&
          new X509Certificate(request.certificate.data).fingerprint256 ===
            process.env.CC_TEST_SITE_SHA256
          ? 0
          : -3,
      ),
    );
    global.testController = new AbortController();
    global.testView = await createBrowserView({
      electron: { session, WebContentsView, dialog },
      window,
      proxy,
      partition: 'persist:owned-web-test',
      url: 'https://default.example.test' + pathname,
      signal: global.testController.signal,
    });
    global.testView.setBounds({ x: 0, y: 50, width: 900, height: 600 });
    global.testView.setVisible(true);
    return true;
  };
  global.testClose = () => global.testView.close();
});
