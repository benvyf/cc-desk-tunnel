const { app, session } = require('electron');
const { X509Certificate } = require('node:crypto');
// Reproduce IPC delivery before its sender callback, without changing the
// production helper or making the parent wait before consuming a chunk.
if (process.env.CC_TEST_UPDATE_DELAY_SEND_CALLBACK) {
  const original = process.send;
  process.send = function (message, callback) {
    return original.call(process, message, (error) => {
      if (message?.type === 'chunk') setTimeout(() => callback(error), 20);
      else callback(error);
    });
  };
}
if (process.env.CC_TEST_UPDATE_PACKAGED_ORIGIN) {
  Object.defineProperty(app, 'isPackaged', { value: true });
  const fs = require('node:fs');
  const file = require('node:path').resolve(__dirname, '../../electron/managed-build.json');
  const original = fs.readFileSync;
  fs.readFileSync = (name, ...args) =>
    name === file
      ? JSON.stringify({ origin: process.env.CC_TEST_UPDATE_PACKAGED_ORIGIN })
      : original(name, ...args);
}
app.commandLine.appendSwitch('host-resolver-rules', 'MAP default.example.test 127.0.0.1');
app.whenReady().then(async () => {
  const ses = session.fromPartition('cc-update-network');
  if (process.env.CC_TEST_UPDATE_STALL_PROXY)
    ses.resolveProxy = () => {
      require('node:fs').writeFileSync(
        require('node:path').join(app.getPath('userData'), 'proxy-evaluation-started'),
        '1',
      );
      return new Promise(() => {});
    };
  if (process.env.CC_TEST_UPDATE_SITE_PIN) {
    ses.setCertificateVerifyProc((request, callback) =>
      callback(
        request.hostname === 'default.example.test' &&
          new X509Certificate(request.certificate.data).fingerprint256 ===
            process.env.CC_TEST_UPDATE_SITE_PIN
          ? 0
          : -3,
      ),
    );
  }
  if (process.env.CC_TEST_UPDATE_PROXY)
    await ses.setProxy(JSON.parse(process.env.CC_TEST_UPDATE_PROXY));
  // The real packaged-helper branch must enter before website resolver rules.
  require('../../electron/main.cjs');
});
