import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { createPreviewBrowser } = createRequire(import.meta.url)('../electron/preview-browser.cjs');

function fixture() {
  const views = [],
    messages = [];
  const recipient = new EventEmitter();
  recipient.isDestroyed = () => false;
  recipient.send = (_channel, value) => messages.push(value);
  const owner = new EventEmitter();
  owner.contentView = { addChildView() {}, removeChildView() {} };
  owner.getContentBounds = () => ({ width: 1000, height: 700 });
  owner.webContents = { getZoomFactor: () => 1 };
  const partition = new EventEmitter();
  partition.setPermissionRequestHandler = partition.setPermissionCheckHandler = () => {};
  let requestFilter;
  partition.webRequest = {
    onBeforeRequest: (_filter, callback) => {
      requestFilter = callback;
    },
  };
  class View {
    constructor() {
      this.visible = true;
      const contents = (this.webContents = new EventEmitter());
      contents.id = views.length + 1;
      contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      contents.setWindowOpenHandler = () => {};
      contents.setWebRTCIPHandlingPolicy = (policy) => {
        this.rtcPolicy = policy;
      };
      contents.getTitle = () => '';
      contents.isLoading = () => false;
      contents.isDestroyed = () => this.closed;
      contents.getURL = () => this.url ?? '';
      contents.loadURL = async (url) => {
        this.url = url;
      };
      contents.close = () => {
        this.closed = true;
      };
      views.push(this);
    }
    setVisible(value) {
      this.visible = value;
    }
    getVisible() {
      return this.visible;
    }
    setBounds() {}
  }
  let finish;
  const files = {
    owns: (url) => typeof url === 'string' && url.startsWith('http://file.localhost/'),
    target: (url) =>
      url.endsWith('index.html')
        ? Promise.resolve({ path: 'C:/project/index.html', root: 'C:/project' })
        : new Promise((resolve) => {
            finish = resolve;
          }),
  };
  const browser = createPreviewBrowser({
    owner,
    recipient,
    surface: 'main',
    WebContentsView: View,
    session: { fromPartition: () => partition },
    files,
  });
  browser.show({
    key: 'file',
    url: 'http://file.localhost/index.html',
    bounds: { x: 400, y: 0, width: 400, height: 500 },
  });
  const navigate = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    views[0].webContents.emit('will-navigate', event, 'http://file.localhost/next.html');
    assert(event.prevented);
  };
  return {
    browser,
    request: (url, id = 1) =>
      new Promise((resolve) => requestFilter({ url, webContentsId: id }, resolve)),
    views,
    messages,
    navigate,
    finish: () => finish({ path: 'C:/project/next.html', root: 'C:/project' }),
  };
}
test('a delayed file navigation cannot open a tab after its page is hidden', async () => {
  const f = fixture();
  f.navigate();
  f.browser.hide();
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert(!f.messages.some((message) => message.open));
  f.navigate();
  assert(!f.messages.some((message) => message.open));
});
test('a delayed file navigation cannot affect a closed or reopened page', async () => {
  const f = fixture();
  f.navigate();
  f.browser.release('file');
  f.browser.show({
    key: 'file',
    url: 'http://file.localhost/index.html',
    bounds: { x: 400, y: 0, width: 400, height: 500 },
  });
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert(f.views[0].closed);
  assert(!f.messages.some((message) => message.open));
});
test('current validated file navigation opens a file with the original restricted root', async () => {
  const f = fixture();
  f.navigate();
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.messages.find((message) => message.open).open, {
    kind: 'file',
    target: 'C:/project/next.html',
    root: 'C:/project',
    restricted: true,
  });
});

test('static HTML can load its own assets but cannot proxy requests to localhost, LAN, public hosts or workers', async () => {
  const f = fixture();
  assert.equal(f.views[0].rtcPolicy, 'disable_non_proxied_udp');
  assert.deepEqual(await f.request('http://file.localhost/assets/app.js'), { cancel: false });
  for (const url of [
    'http://127.0.0.1:3000/secret',
    'http://192.168.1.1/',
    'https://example.com/',
    'ws://localhost:8000/',
  ])
    assert.deepEqual(await f.request(url), { cancel: true });
  assert.deepEqual(await f.request('http://127.0.0.1:3000/', -1), { cancel: true });
});

test('two panes keep native views visible and moving a tab preserves its live view', () => {
  const f = fixture();
  f.browser.show({
    key: 'second',
    pane: 'second-pane',
    url: 'http://localhost:3000/',
    bounds: { x: 0, y: 0, width: 300, height: 300 },
  });
  assert(f.views[0].visible);
  assert(f.views[1].visible);
  f.browser.hide('primary');
  assert(!f.views[0].visible);
  assert(f.views[1].visible);
  f.browser.show({
    key: 'second',
    pane: 'primary',
    url: 'http://localhost:3000/',
    bounds: { x: 0, y: 0, width: 300, height: 300 },
  });
  f.browser.hide('second-pane');
  assert.equal(f.views.length, 2);
  assert(f.views[1].visible);
});

test('explicit address navigation survives hiding and revealing the same website tab', async () => {
  const f = fixture();
  const original = 'http://localhost:3000/';
  f.browser.show({ key: 'site', url: original, bounds: { x: 0, y: 0, width: 300, height: 300 } });
  f.browser.action({ key: 'site', action: 'go', url: original + 'typed' });
  f.browser.hide();
  f.browser.show({ key: 'site', url: original, bounds: { x: 0, y: 0, width: 300, height: 300 } });
  assert.equal(f.views[1].url, original + 'typed');
  assert.deepEqual(await f.request(original + 'api', 2), { cancel: false });
});

test('static file navigation and redirects cannot open another loopback service', () => {
  const f = fixture();
  for (const event of ['will-navigate', 'will-redirect']) {
    let prevented = false;
    f.views[0].webContents.emit(
      event,
      {
        preventDefault() {
          prevented = true;
        },
      },
      'http://localhost:3000/private',
    );
    assert(prevented);
  }
  assert(!f.messages.some((m) => m.open?.kind === 'web'));
  assert(f.messages.some((m) => m.error.includes('手动打开')));
});

test('hiding then revealing a tab cancels its earlier asynchronous file navigation', async () => {
  const f = fixture();
  f.navigate();
  f.browser.hide();
  f.browser.show({
    key: 'file',
    url: 'http://file.localhost/index.html',
    bounds: { x: 0, y: 0, width: 400, height: 500 },
  });
  f.finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert(!f.messages.some((m) => m.open));
});
