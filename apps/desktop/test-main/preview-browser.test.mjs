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
  class View {
    constructor() {
      this.visible = true;
      const contents = (this.webContents = new EventEmitter());
      contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      contents.setWindowOpenHandler = () => {};
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
