import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { createBrowserSession } = createRequire(import.meta.url)('../electron/browser-session.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('a delayed display close cannot reopen after a later close or overwrite a later open', async () => {
  for (const action of ['close', 'open']) {
    const stop = deferred();
    let opened = 0,
      closedLatest = 0;
    // Use a stable control identity, as main.cjs does.
    const control = {
      browserStatus: async () => ({ schema: 1, enabled: true }),
      openBrowser: async () => {
        const index = ++opened;
        return {
          url: `display-${index}`,
          close: () => (index === 1 ? stop.promise : ++closedLatest),
        };
      },
    };
    const displays = createBrowserSession(() => control);
    assert.equal((await displays.open()).url, 'display-1');
    const stale = displays.open();
    if (action === 'open') assert.equal((await displays.open()).url, 'display-2');
    else await displays.close();
    stop.resolve();
    assert.equal((await stale).enabled, false);
    assert.equal(opened, action === 'open' ? 2 : 1);
    await displays.close();
    assert.equal(closedLatest, action === 'open' ? 1 : 0);
    assert.equal(displays.busy(), false);
  }
});
test('an opening display is closed if the authenticated control connection changes', async () => {
  const opening = deferred();
  let closes = 0;
  let control = {
    browserStatus: async () => ({ schema: 1, enabled: true }),
    openBrowser: () => opening.promise,
  };
  const session = createBrowserSession(() => control);
  const result = session.open();
  // Let the status and open awaits run before replacing the control connection.
  await new Promise((done) => setImmediate(done));
  control = { ...control };
  opening.resolve({
    url: 'late-display',
    close: async () => {
      closes++;
    },
  });
  assert.equal((await result).enabled, false);
  assert.equal(closes, 1);
  assert.equal(session.busy(), false);
});
