// Diagnostic wrapper: run the actual main.cjs without Playwright launch flags.
// Only the owned offline URL/certificate are substituted; production is unchanged.
const { app, BrowserWindow, session, netLog } = require('electron');
const { resolve, join } = require('node:path');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { X509Certificate } = require('node:crypto');
const assert = require('node:assert/strict');
const settings = JSON.parse(readFileSync(process.env.CC_NETWORK_CHECK_SETTINGS, 'utf8'));
const directory = process.env.CC_NETWORK_CHECK_OUTPUT;
app.setPath('userData', join(directory, 'profile'));
const checks = [];
const say = (marker, value = {}) =>
  process.stdout.write(JSON.stringify({ marker, ...value }) + '\n');
let website;
const moduleView = require('../../apps/desktop/electron/browser-view.cjs');
const original = moduleView.createBrowserView;
moduleView.createBrowserView = async (options) => {
  session
    .fromPartition(options.partition)
    .setCertificateVerifyProc((request, callback) =>
      callback(
        request.hostname === settings.host &&
          new X509Certificate(request.certificate.data).fingerprint256 === settings.siteFingerprint
          ? 0
          : -3,
      ),
    );
  website = await original({ ...options, url: 'https://' + settings.host + '/' });
  return website;
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const bounded = (promise, ms = 12000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Native diagnostic timeout')), ms);
      timer.unref();
    }),
  ]);
const observe = (name, value = true) => {
  checks.push({ name, value });
  say('CHECK', { name, value });
};
const metrics = () =>
  app.getAppMetrics().map(({ pid, type, name, serviceName }) => ({ pid, type, name, serviceName }));
let ui;
app.whenReady().then(async () => {
  const result = { startedAt: new Date().toISOString(), checks, pid: process.pid };
  let failed;
  try {
    await netLog.startLogging(join(directory, 'netlog.json'), { captureMode: 'default' });
    for (let index = 0; index < 200; index++) {
      ui = BrowserWindow.getAllWindows()[0]?.webContents;
      if (
        ui &&
        !ui.isLoadingMainFrame() &&
        ui.getURL().startsWith('file:') &&
        (await ui.executeJavaScript('!!window.desktop'))
      )
        break;
      await delay(100);
    }
    assert.ok(ui && (await ui.executeJavaScript('!!window.desktop')));
    assert.equal(app.getPath('userData'), join(directory, 'profile'));
    result.arguments = process.argv;
    result.flags = {
      quicDisabled: app.commandLine.hasSwitch('disable-quic'),
      dnsPrefetchDisabled: app.commandLine.hasSwitch('dns-prefetch-disable'),
      rtcPolicy: app.commandLine.getSwitchValue('force-webrtc-ip-handling-policy'),
      playwrightBackgroundFlag: app.commandLine.hasSwitch('disable-background-networking'),
    };
    assert.equal(result.flags.quicDisabled, true);
    assert.equal(result.flags.dnsPrefetchDisabled, true);
    assert.equal(result.flags.rtcPolicy, 'disable_non_proxied_udp');
    assert.equal(result.flags.playwrightBackgroundFlag, false);
    observe('NATIVE_MAIN_FLAGS');
    // Authenticate the real control bridge through the real preload IPC. The
    // owned service is a simulation backend; no native agent is started.
    const endpoint = await ui.executeJavaScript(
      `window.desktop.connectProxy(${JSON.stringify(settings.control)})`,
    );
    await bounded(
      ui.executeJavaScript(`new Promise((resolve,reject)=>{
      const ws=window.networkCheckSocket=new WebSocket(${JSON.stringify(endpoint.url)});
      ws.onopen=()=>{ws.send(JSON.stringify({type:'auth',protocolVersion:${settings.protocol},token:${JSON.stringify(settings.token)},deviceName:'owned-network-check'}));ws.send(JSON.stringify({type:'device',id:${JSON.stringify(settings.deviceId)}}))};
      ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='ready')resolve(true);if(m.type==='error')reject(new Error(m.code))};ws.onerror=()=>reject(new Error('Owned control failed'));
    })`),
    );
    const opened = await bounded(ui.executeJavaScript('window.desktop.browser.open()'));
    assert.equal(opened.enabled, true);
    await ui.executeJavaScript(
      'window.desktop.browser.bounds({x:0,y:80,width:900,height:550});window.desktop.browser.mode(true)',
    );
    const js = (code) => website.contents.executeJavaScript(code);
    assert.equal(await js('document.title'), 'Owned integrated Chat');
    assert.deepEqual(await js('[typeof require,typeof process,typeof window.desktop]'), [
      'undefined',
      'undefined',
      'undefined',
    ]);
    result.metrics = metrics();
    observe('MAIN_IPC_VIEW_OPENED');
    const route = await website.contents.session.resolveProxy('https://' + settings.host + '/');
    assert.match(route, /^PROXY 127\.0\.0\.1:/);
    assert.ok(!route.includes('DIRECT'));
    observe('FIXED_PROXY');
    assert.equal(
      await js("fetch('/native-dummy',{method:'POST',body:'owned-dummy'}).then(r=>r.status)"),
      200,
    );
    observe('OWNED_HTTPS_REQUEST');
    result.probesStartedAt = new Date().toISOString();
    result.rtc = await bounded(
      js(`new Promise(async(resolve,reject)=>{
      const rtc=new RTCPeerConnection({iceServers:[
        {urls:'stun:74.82.201.214:3478'},
        {urls:'turn:74.82.201.214:443?transport=tcp',username:'owned',credential:'dummy'},
        {urls:'stun:${settings.rtcHost}:3478'},
        {urls:'turn:${settings.rtcHost}:443?transport=tcp',username:'owned',credential:'dummy'},
        {urls:'stun:127.0.0.1:${settings.udp4Port}'},
        {urls:'stun:[::1]:${settings.udp6Port}'}]});
      const candidates=[];rtc.onicecandidate=e=>{if(e.candidate)candidates.push(e.candidate.candidate)};
      try {rtc.createDataChannel('owned');await rtc.setLocalDescription(await rtc.createOffer());
        setTimeout(()=>{rtc.close();resolve({candidates})},8000)}catch(e){rtc.close();reject(e)}
    })`),
    );
    assert.deepEqual(result.rtc.candidates, []);
    observe('RTC_NO_DIRECT_CANDIDATES');
    result.webTransport = await bounded(
      js(`new Promise(resolve=>{
      if(typeof WebTransport==='undefined')return resolve('unavailable');
      let transport;let done=false;const finish=x=>{if(done)return;done=true;transport?.close();resolve(x)};
      try {transport=new WebTransport('https://api.ghostapi.org/_cc-egress-test/${settings.nonce}/webtransport');
        transport.closed.catch(()=>{});transport.ready.then(()=>finish('unexpected-ready'),()=>finish('rejected'));
        setTimeout(()=>finish('bounded-close'),4000)}catch(e){finish('rejected')}
    })`),
    );
    assert.notEqual(result.webTransport, 'unexpected-ready');
    observe('WEBTRANSPORT_OBSERVED', result.webTransport);
    assert.equal(
      await js(`Promise.all([
      fetch('https://${settings.rtcHost}/dummy').then(()=>false,()=>true),
      fetch('http://${settings.rtcHost}/dummy').then(()=>false,()=>true)
    ]).then(results=>results.every(Boolean))`),
      true,
    );
    await js(
      `(()=>{const prefetch=document.createElement('link');prefetch.rel='dns-prefetch';prefetch.href='https://${settings.prefetchHost}';document.head.append(prefetch);return true})()`,
    );
    await delay(1000);
    observe('REJECTED_TARGET_AND_PREFETCH');
    // Windows GUI Electron does not reliably expose the inherited stdin pipe.
    // A nonce-bound file in this private run replaces only the test handshake.
    say('STOP_PROXY');
    await bounded(
      (async () => {
        const confirmation = join(directory, 'proxy-stopped.json');
        while (!existsSync(confirmation)) await delay(50);
        assert.equal(JSON.parse(readFileSync(confirmation, 'utf8')).nonce, settings.nonce);
      })(),
    );
    assert.equal(
      await bounded(js("fetch('/after-proxy-loss',{cache:'no-store'}).then(()=>false,()=>true)")),
      true,
    );
    observe('PROXY_LOSS_BLOCKED');
    await ui.executeJavaScript('window.desktop.browser.close()');
    observe('BROWSER_CLOSED');
    result.metricsAfter = metrics();
  } catch (error) {
    failed = error;
    result.error = String(error?.stack || error);
  } finally {
    result.endedAt = new Date().toISOString();
    try {
      if (ui && !ui.isDestroyed())
        await bounded(ui.executeJavaScript('window.desktop.disconnectProxy()'));
    } catch (error) {
      failed ||= error;
      result.cleanupError = String(error);
    }
    await netLog.stopLogging().catch((error) => {
      failed ||= error;
    });
    result.ok = !failed;
    writeFileSync(join(directory, 'native-result.json'), JSON.stringify(result, null, 2));
    say('NATIVE_FINISHED', { ok: result.ok });
    app.exit(failed ? 1 : 0);
  }
});
// This is the normal main process and its normal flags, profile and IPC guards.
require('../../apps/desktop/electron/main.cjs');
