// One display per control connection. A delayed close/open may never adopt a newer request's generation.
function createBrowserSession(getControl) {
  let display;
  let generation = 0;
  async function close() {
    const ownGeneration = ++generation;
    const previous = display;
    display = null;
    await previous?.close();
    return ownGeneration;
  }
  async function open() {
    const ownGeneration = await close();
    const control = getControl();
    if (ownGeneration !== generation) return { enabled: false, reason: 'unavailable' };
    if (!control) return { enabled: false, reason: 'disconnected' };
    const current = () => ownGeneration === generation && getControl() === control;
    try {
      const status = await control.browserStatus();
      if (!current()) throw new Error('连接已变化。');
      if (!status || status.schema !== 1 || typeof status.enabled !== 'boolean')
        throw new Error('无效网页状态。');
      if (!status.enabled)
        return {
          enabled: false,
          reason: ['moderation-required', 'maintenance'].includes(status.reason)
            ? status.reason
            : 'not-configured',
        };
      const opened = await control.openBrowser();
      if (!current()) {
        await opened.close();
        throw new Error('连接已变化。');
      }
      display = opened;
      return { enabled: true, url: opened.url };
    } catch (error) {
      return { enabled: false, reason: error?.status === 404 ? 'not-installed' : 'unavailable' };
    }
  }
  return { open, close, busy: () => !!display };
}
module.exports = { createBrowserSession };
