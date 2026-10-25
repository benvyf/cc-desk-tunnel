import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { createBrowserProxy } from '../../server/src/browser-proxy.ts';
import { custom, defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
createRequire(import.meta.url)('../electron/browser-view.cjs');

test(
  'real Electron view uses only the authenticated gateway and isolates website privileges',
  { timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(resolve('.local/browser-view-'));
    const requests = [];
    let siteConnections = 0;
    const sockets = new Set();
    const site = createServer(custom, (req, res) => {
      requests.push(req.url);
      if (req.url === '/slow') return; // Owned stalled page for cancellation.
      if (req.url === '/download-slow') {
        res.writeHead(200, {
          'Content-Disposition': 'attachment; filename="incomplete.txt"',
          'Content-Type': 'text/plain',
          'Content-Length': 1024 * 1024,
        });
        res.write(Buffer.alloc(64 * 1024, 'x'));
        return;
      }
      if (req.url === '/download') {
        res.writeHead(200, {
          'Content-Disposition': 'attachment; filename="owned.txt"',
          'Content-Type': 'text/plain',
        });
        res.end('owned-download-content');
      } else if (req.url === '/sw.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Service-Worker-Allowed': '/',
        });
        res.end(
          "self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.waitUntil(fetch('/worker-fetch').then(()=>e.source.postMessage('worker-ok'))));",
        );
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><title>Owned browser test</title><input id="message"><a id="download" href="/download">下载</a><a id="next" href="/next" target="_blank">下一页</a>',
        );
      }
    });
    site.on('connection', (socket) => {
      siteConnections++;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const websiteWs = new WebSocketServer({ server: site });
    websiteWs.on('connection', (ws) =>
      ws.on('message', (data, binary) => ws.send(data, { binary })),
    );
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    const token = 'owned-electron-gateway-token';
    let dials = 0;
    const service = createBrowserProxy({
      token,
      hosts: ['default.example.test'],
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      dial: () => {
        dials++;
        return connect({ host: '127.0.0.1', port: site.address().port });
      },
    });
    const gateway = createServer(defaultCertificate);
    gateway.on('upgrade', (req, socket, head) => service.upgrade(req, socket, head));
    gateway.listen(0, '127.0.0.1');
    await once(gateway, 'listening');
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE',
      ),
    );
    const launch = {
      args: [resolve('apps/desktop/test-electron/fixtures/browser-view.cjs')],
      env: {
        ...env,
        CC_TEST_PROFILE: join(directory, 'profile'),
        CC_TEST_SITE_SHA256: new X509Certificate(custom.cert).fingerprint256,
        CC_TEST_PROXY: JSON.stringify({
          url: `wss://127.0.0.1:${gateway.address().port}/ws`,
          token,
          fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
        }),
      },
    };
    let application = await _electron.launch(launch);
    t.after(async () => {
      await application.close();
      service.close();
      websiteWs.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise((r) => site.close(r)), new Promise((r) => gateway.close(r))]);
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    });
    await application.firstWindow();
    t.signal.addEventListener(
      'abort',
      () => {
        void application.close();
      },
      { once: true },
    );
    await application.evaluate(() => global.testStart());
    const contents = async (script) =>
      application.evaluate(
        (_electron, code) => global.testView.contents.executeJavaScript(code),
        script,
      );
    assert.equal(await contents('document.title'), 'Owned browser test');
    assert.deepEqual(await contents('[typeof require,typeof process,typeof window.desktop]'), [
      'undefined',
      'undefined',
      'undefined',
    ]);
    const preferences = await application.evaluate(() =>
      global.testView.contents.getLastWebPreferences(),
    );
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.ok(!preferences.preload);
    const route = await application.evaluate(() =>
      global.testView.contents.session.resolveProxy('https://default.example.test/'),
    );
    assert.match(route, /^PROXY 127\.0\.0\.1:/);
    assert.ok(!route.includes('DIRECT'));
    assert.ok(dials > 0);
    await contents("document.querySelector('#message').focus()");
    await application.evaluate(() => global.testView.contents.insertText('中文输入验证'));
    assert.equal(await contents("document.querySelector('#message').value"), '中文输入验证');
    await contents(
      "document.cookie='owned_login=reused; Max-Age=3600; Secure; SameSite=Lax';localStorage.setItem('owned','persistent')",
    );
    await application.evaluate(() => global.testClose());
    await application.evaluate(() => global.testStart());
    assert.match(await contents('document.cookie'), /owned_login=reused/);
    assert.equal(await contents("localStorage.getItem('owned')"), 'persistent');
    await application.evaluate(() => global.testClose());
    await application.close();
    application = await _electron.launch(launch);
    await application.firstWindow();
    await application.evaluate(() => global.testStart());
    assert.match(await contents('document.cookie'), /owned_login=reused/);
    assert.equal(await contents("localStorage.getItem('owned')"), 'persistent');
    assert.equal(
      await contents(
        "new Promise((resolve,reject)=>{const ws=new WebSocket('wss://default.example.test/socket');ws.onopen=()=>ws.send('owned-wss');ws.onmessage=e=>{resolve(e.data);ws.close()};ws.onerror=reject})",
      ),
      'owned-wss',
    );
    assert.equal(
      await contents(
        "new Promise(async(resolve,reject)=>{try{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;navigator.serviceWorker.onmessage=e=>resolve(e.data);navigator.serviceWorker.controller?navigator.serviceWorker.controller.postMessage('test'):navigator.serviceWorker.addEventListener('controllerchange',()=>navigator.serviceWorker.controller.postMessage('test'),{once:true})}catch(e){reject(e)}})",
      ),
      'worker-ok',
    );
    assert.ok(requests.includes('/worker-fetch'));
    const before = requests.length;
    const beforeConnections = siteConnections;
    assert.equal(
      await contents(
        `fetch('https://127.0.0.1:${site.address().port}/direct-probe').then(()=>false,()=>true)`,
      ),
      true,
    );
    assert.equal(requests.length, before);
    assert.equal(siteConnections, beforeConnections);
    const udp = createSocket('udp4');
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    let udpPackets = 0,
      tcpConnections = 0;
    udp.on('message', () => udpPackets++);
    const turn = createTcpServer((socket) => {
      tcpConnections++;
      socket.destroy();
    });
    turn.listen(0, '127.0.0.1');
    await once(turn, 'listening');
    const rtcLog = join(directory, 'rtc-netlog.json');
    await application.evaluate(
      (_electron, path) => global.testView.contents.session.netLog.startLogging(path),
      rtcLog,
    );
    try {
      await contents(
        `new Promise(async resolve => { const rtc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'},{urls:'turn:127.0.0.1:${turn.address().port}?transport=tcp',username:'owned',credential:'owned'},{urls:'stun:owned-rtc-stun.invalid:3478'},{urls:'turn:owned-rtc-turn.invalid:443?transport=tcp',username:'owned',credential:'owned'}]});rtc.createDataChannel('owned');await rtc.setLocalDescription(await rtc.createOffer());setTimeout(()=>{rtc.close();resolve(true)},700)})`,
      );
      assert.equal(udpPackets, 0);
      assert.equal(tcpConnections, 0);
      assert.equal(
        await application.evaluate(() => global.testView.contents.getWebRTCIPHandlingPolicy()),
        'disable_non_proxied_udp',
      );
      assert.equal(
        await application.evaluate(({ app }) => app.commandLine.hasSwitch('disable-quic')),
        true,
      );
      assert.equal(
        await application.evaluate(({ app }) => app.commandLine.hasSwitch('dns-prefetch-disable')),
        true,
      );
    } finally {
      await application.evaluate(() => global.testView.contents.session.netLog.stopLogging());
      udp.close();
      await new Promise((r) => turn.close(r));
    }
    const network = JSON.parse(await readFile(rtcLog, 'utf8'));
    const localResolutions = network.events.filter(
      (event) =>
        /HOST_RESOLVER/.test(
          Object.entries(network.constants.logEventTypes).find(
            ([, value]) => value === event.type,
          )?.[0] ?? '',
        ) && /owned-rtc-(?:stun|turn)\.invalid/.test(JSON.stringify(event.params)),
    );
    assert.equal(
      localResolutions.length,
      0,
      'WebRTC hostnames must not enter the local DNS resolver',
    );
    await contents("document.querySelector('#next').click()");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await contents('location.pathname'), '/next');
    assert.equal(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
    );
    const download = join(directory, 'owned.txt');
    await application.evaluate(({ dialog }, path) => {
      global.manualSaveCalls = 0;
      dialog.showSaveDialog = async () => {
        global.manualSaveCalls++;
        return { canceled: true };
      };
      global.downloadResult = new Promise((resolve) =>
        global.testView.contents.session.once('will-download', (_e, item) => {
          global.nativeSaveOptions = item.getSaveDialogOptions();
          // Only the test selects a path synchronously; production leaves native
          // path selection and cancellation to Electron's single save dialog.
          item.setSavePath(path);
          item.once('done', (_e, state) => resolve(state));
        }),
      );
    }, download);
    await contents("document.querySelector('#download').click()");
    const saved = await application.evaluate(async () => ({
      state: await global.downloadResult,
      manual: global.manualSaveCalls,
      options: global.nativeSaveOptions,
    }));
    assert.equal(saved.manual, 0, 'must not open a second manual save dialog');
    assert.equal(saved.options.title, '保存附件');
    assert.equal(saved.state, 'completed');
    assert.equal(await readFile(download, 'utf8'), 'owned-download-content');
    await application.evaluate(
      (_electron, path) => {
        global.incompleteDownload = new Promise((resolve) =>
          global.testView.contents.session.once('will-download', (_e, item) => {
            item.setSavePath(path);
            global.incompleteItem = item;
            item.once('done', (_event, state) => resolve(state));
          }),
        );
      },
      join(directory, 'incomplete.txt'),
    );
    await contents(
      "document.querySelector('#download').href='/download-slow';document.querySelector('#download').click()",
    );
    for (
      let index = 0;
      index < 50 &&
      !(await application.evaluate(() => global.incompleteItem?.getReceivedBytes() > 0));
      index++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(requests.includes('/download-slow'));
    assert.deepEqual(
      await application.evaluate(() => ({
        exists: !!global.incompleteItem,
        state: global.incompleteItem?.getState(),
        bytes: global.incompleteItem?.getReceivedBytes() > 0,
      })),
      { exists: true, state: 'progressing', bytes: true },
    );
    await application.evaluate(() => global.testClose());
    assert.equal(await application.evaluate(() => global.incompleteDownload), 'cancelled');
    const cancelled = application
      .evaluate(() => global.testStart('/slow'))
      .then(
        () => false,
        () => true,
      );
    for (let index = 0; index < 50 && !requests.includes('/slow'); index++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(requests.includes('/slow'));
    await application.evaluate(() => global.testController.abort());
    assert.equal(await cancelled, true);
    await application.evaluate(() => global.testStart());
    service.close();
    await assert.rejects(
      application.evaluate(() =>
        global.testView.contents.loadURL('https://default.example.test/after-disconnect'),
      ),
    );
    assert.ok(!requests.includes('/after-disconnect'));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy());
    const closing = application.evaluate(() => global.testClose());

    await closing;
  },
);
