import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { createBrowserSession } = createRequire(import.meta.url)('../electron/browser-session.cjs');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('close cancels a pending status query before creating a browser transport', async () => {
  const entered = deferred();
  const status = deferred();
  let signal;
  let opened = 0;
  const control = {
    browserStatus: (received) => {
      signal = received;
      entered.resolve();
      return status.promise;
    },
    openBrowser: async () => {
      opened++;
      throw new Error('must not open');
    },
  };
  const manager = createBrowserSession(
    () => control,
    () => {
      throw new Error('must not create');
    },
  );
  const pending = manager.open();
  await entered.promise;
  const closing = manager.close();
  try {
    assert.equal(signal?.aborted, true, 'the status HTTP request must receive cancellation');
  } finally {
    status.resolve({ schema: 2, enabled: true });
    assert.equal((await pending).enabled, false);
    await closing;
  }
  assert.equal(opened, 0);
});

test(
  'close aborts a pending website load instead of waiting for the website timeout',
  { timeout: 1000 },
  async () => {
    const entered = deferred();
    let aborted = false;
    const control = {
      browserStatus: async () => ({ schema: 2, enabled: true }),
      openBrowser: async () => ({ close: async () => {} }),
    };
    const manager = createBrowserSession(
      () => control,
      async (_proxy, _notify, signal) => {
        entered.resolve();
        await new Promise((resolve) =>
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error('cancelled');
      },
    );
    const opened = manager.open();
    await entered.promise;
    const closed = manager.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(aborted, true);
    assert.equal((await opened).enabled, false);
    await closed;
  },
);

test('v2 status gates view creation and never returns main-process credentials', async () => {
  for (const status of [
    { schema: 1, enabled: true },
    { schema: 2, enabled: false, reason: 'moderation-required' },
    { schema: 2, enabled: true },
  ]) {
    let opened = 0;
    const control = {
      browserStatus: async () => status,
      openBrowser: async () => ({ password: 'private', close: async () => {} }),
    };
    const manager = createBrowserSession(
      () => control,
      async (proxy) => {
        opened++;
        assert.equal(proxy.password, 'private');
        return { close: proxy.close, setVisible() {}, setBounds() {} };
      },
    );
    const result = await manager.open();
    assert.equal(result.enabled, status.schema === 2 && status.enabled);
    assert.equal(opened, status.schema === 2 && status.enabled ? 1 : 0);
    assert.equal(result.password, undefined);
    assert.equal(result.url, undefined);
    await manager.close();
  }
});

test('an opening proxy is closed when the control connection changes', async () => {
  const opening = deferred();
  let closes = 0,
    views = 0;
  let control = {
    browserStatus: async () => ({ schema: 2, enabled: true }),
    openBrowser: () => opening.promise,
  };
  const manager = createBrowserSession(
    () => control,
    async () => {
      views++;
    },
  );
  const result = manager.open();
  await tick();
  control = { ...control };
  opening.resolve({
    close: async () => {
      closes++;
    },
  });
  assert.equal((await result).enabled, false);
  assert.equal(closes, 1);
  assert.equal(views, 0);
  assert.equal(manager.busy(), false);
});

test('view construction is serialized and late views cannot overwrite a new generation', async () => {
  const opening = deferred();
  let closes = 0,
    built = 0;
  const control = {
    browserStatus: async () => ({ schema: 2, enabled: true }),
    openBrowser: async () => ({ close: async () => {} }),
  };
  const manager = createBrowserSession(
    () => control,
    async () => {
      const index = ++built;
      if (index === 1) await opening.promise;
      return {
        close: async () => {
          closes++;
        },
        setVisible() {},
        setBounds() {},
      };
    },
  );
  const first = manager.open();
  await tick();
  const second = manager.open();
  await tick();
  assert.equal(built, 1);
  opening.resolve();
  assert.equal((await first).enabled, false);
  assert.equal((await second).enabled, true);
  assert.equal(closes, 1);
  await manager.close();
  assert.equal(closes, 2);
});

test('mode and bounds apply without reopening; close invalidates late status notifications', async () => {
  const notices = [],
    visible = [],
    bounds = [];
  let report;
  const control = {
    browserStatus: async () => ({ schema: 2, enabled: true }),
    openBrowser: async () => ({ close: async () => {} }),
  };
  const manager = createBrowserSession(
    () => control,
    async (_proxy, notify) => {
      report = notify;
      return {
        close: async () => {},
        setVisible: (v) => visible.push(v),
        setBounds: (v) => bounds.push(v),
      };
    },
    (state) => notices.push(state),
  );
  manager.mode(true);
  manager.bounds({ x: 0, y: 80, width: 800, height: 500 });
  assert.deepEqual(await manager.open(), { enabled: true });
  assert.equal(visible.at(-1), true);
  assert.equal(bounds.at(-1).y, 80);
  manager.mode(false);
  assert.equal(visible.at(-1), false);
  report('unavailable');
  assert.deepEqual(notices, ['unavailable']);
  await manager.close();
  report('unavailable');
  assert.deepEqual(notices, ['unavailable']);
});
