import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { installTerminalWindow, isTerminalWindow } = require('../electron/terminal-window.cjs');
function fixture() {
  const owner = new EventEmitter();
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (handler) => {
    contents.open = handler;
  };
  contents.isDestroyed = () => false;
  contents.messages = [];
  contents.send = (...args) => contents.messages.push(args);
  owner.webContents = contents;
  const controller = installTerminalWindow(owner);
  const child = new EventEmitter();
  child.webContents = new EventEmitter();
  child.webContents.setWindowOpenHandler = (handler) => {
    child.open = handler;
  };
  child.isDestroyed = () => false;
  child.isMinimized = () => true;
  child.restore = () => {
    child.restored = true;
  };
  child.show = () => {
    child.shown = true;
  };
  child.focus = () => {
    child.focused = true;
  };
  child.destroy = () => {
    child.destroyed = true;
    child.emit('closed');
  };
  return { owner, child, contents, controller };
}
test('only the terminal blank popup is allowed with an unprivileged sandbox', () => {
  const f = fixture();
  for (const details of [
    { url: 'https://example.invalid', frameName: 'cc-native-terminal' },
    { url: 'about:blank', frameName: 'other' },
    { url: 'file:///etc/passwd', frameName: 'cc-native-terminal' },
  ])
    assert.equal(f.contents.open(details).action, 'deny');
  const result = f.contents.open({ url: 'about:blank', frameName: 'cc-native-terminal' });
  assert.equal(result.action, 'allow');
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.match(result.overrideBrowserWindowOptions.webPreferences.preload, /terminal-preload.cjs$/);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.backgroundThrottling, false);
});
test('terminal restores on focus, refuses navigation, and closes with its owner', () => {
  const f = fixture();
  f.contents.emit('did-create-window', f.child, { frameName: 'cc-native-terminal' });
  assert.equal(isTerminalWindow(f.child), true);
  assert.equal(f.controller.focus(), true);
  assert.ok(f.child.restored && f.child.shown && f.child.focused);
  assert.equal(f.child.open({ url: 'https://example.invalid' }).action, 'deny');
  let prevented = false;
  f.child.webContents.emit('will-navigate', {
    preventDefault() {
      prevented = true;
    },
  });
  assert.ok(prevented);
  assert.equal(
    f.contents.open({ url: 'about:blank', frameName: 'cc-native-terminal' }).action,
    'deny',
  );
  f.owner.emit('closed');
  assert.ok(f.child.destroyed);
});
test('native close notifies the primary renderer and allows reopening', () => {
  const f = fixture();
  f.contents.emit('did-create-window', f.child, { frameName: 'cc-native-terminal' });
  f.child.emit('closed');
  assert.deepEqual(f.contents.messages, [['terminal-window:closed']]);
  assert.equal(f.controller.focus(), false);
  assert.equal(
    f.contents.open({ url: 'about:blank', frameName: 'cc-native-terminal' }).action,
    'allow',
  );
});

test('the detached window keeps the native edit menu for copy and paste', () => {
  const f = fixture();
  const { installEditMenu } = require('../electron/edit-menu.cjs');
  let menu, target;
  installEditMenu(f.child, {
    buildFromTemplate(items) {
      menu = items;
      return {
        popup(options) {
          target = options.window;
        },
      };
    },
  });
  f.child.webContents.emit(
    'context-menu',
    {},
    { isEditable: true, editFlags: { canCopy: true, canPaste: true } },
  );
  assert.equal(target, f.child);
  assert.equal(menu.find((item) => item.role === 'copy').enabled, true);
  assert.equal(menu.find((item) => item.role === 'paste').enabled, true);
});

test('active terminal close is coordinated and quit cancellation preserves the window', async () => {
  const f = fixture();
  f.contents.emit('did-create-window', f.child, { frameName: 'cc-native-terminal' });
  f.controller.setActive(true);
  let prevented = false;
  f.child.emit('close', {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(f.child.destroyed, undefined);
  assert.deepEqual(f.contents.messages.at(-1), ['terminal-window:request-close']);
  const canceled = f.controller.requestClose();
  f.controller.finishClose(false);
  assert.equal(await canceled, false);
  assert.equal(f.child.destroyed, undefined);
  const accepted = f.controller.requestClose();
  assert.equal(f.controller.control('destroy'), true);
  assert.equal(await accepted, true);
  assert.equal(f.child.destroyed, true);
});

test('window controls are restricted to the owning controller', () => {
  const f = fixture();
  assert.equal(f.controller.control('destroy'), false);
  f.contents.emit('did-create-window', f.child, { frameName: 'cc-native-terminal' });
  assert.equal(f.controller.control('execute'), false);
  f.child.minimize = () => {
    f.child.minimized = true;
  };
  f.controller.control('minimize');
  assert.equal(f.child.minimized, true);
});

test('maximize state is sent only to the owning renderer', () => {
  const f = fixture();
  f.child.isMaximized = () => true;
  f.contents.emit('did-create-window', f.child, { frameName: 'cc-native-terminal' });
  f.child.emit('maximize');
  assert.deepEqual(f.contents.messages, [['terminal-window:state', { maximized: true }]]);
});
