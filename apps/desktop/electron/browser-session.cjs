// Serialize construction of the persistent session. A late status, proxy or view
// can never adopt the generation of a newer control connection.
function createBrowserSession(getControl, createView, onState = () => {}) {
  let display;
  let generation = 0;
  let queue = Promise.resolve();
  let pending = 0;
  let visible = false;
  let rectangle;
  let opening;
  function enqueue(action) {
    pending++;
    const result = queue.then(action).finally(() => pending--);
    queue = result.catch(() => {});
    return result;
  }
  async function dispose() {
    const previous = display;
    display = null;
    await previous?.close();
  }
  function close() {
    generation++;
    opening?.abort();
    display?.setVisible(false);
    return enqueue(dispose);
  }
  function open() {
    const ownGeneration = ++generation;
    opening?.abort();
    return enqueue(async () => {
      await dispose();
      const control = getControl();
      const current = () => ownGeneration === generation && getControl() === control;
      if (!current()) return { enabled: false, reason: 'unavailable' };
      if (!control) return { enabled: false, reason: 'disconnected' };
      let proxy;
      const controller = new AbortController();
      opening = controller;
      try {
        const status = await control.browserStatus();
        if (!current()) throw new Error('连接已变化。');
        if (!status || status.schema !== 2 || typeof status.enabled !== 'boolean')
          throw new Error('无效网页状态。');
        if (!status.enabled)
          return {
            enabled: false,
            reason: ['moderation-required', 'maintenance'].includes(status.reason)
              ? status.reason
              : 'not-configured',
          };
        proxy = await control.openBrowser();
        if (!current()) throw new Error('连接已变化。');
        const opened = await createView(
          proxy,
          (state) => {
            if (current()) onState(state);
          },
          controller.signal,
        );
        if (!current()) {
          await opened.close();
          throw new Error('连接已变化。');
        }
        display = opened;
        proxy = null; // The view now owns this transport.
        if (rectangle) display.setBounds(rectangle);
        display.setVisible(visible);
        return { enabled: true };
      } catch (error) {
        await proxy?.close();
        return { enabled: false, reason: error?.status === 404 ? 'not-installed' : 'unavailable' };
      } finally {
        if (opening === controller) opening = null;
      }
    });
  }
  return {
    open,
    close,
    mode(active) {
      visible = active === true;
      display?.setVisible(visible);
    },
    bounds(value) {
      rectangle = value;
      if (display) display.setBounds(value);
    },
    busy: () => pending > 0 || !!display,
  };
}
module.exports = { createBrowserSession };
