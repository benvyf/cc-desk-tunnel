const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');

// Only main-process update GETs and system proxy resolution enter this child.
// Website renderers never get this capability. Independent Chromium retains
// system proxy/CA behavior without reopening DNS in the website process.
function createNetworkFetch({
  app,
  origin,
  executable = process.execPath,
  resolveProxyOnly = false,
}) {
  const trusted = new URL(origin);
  if (trusted.protocol !== 'https:' || trusted.username || trusted.password)
    throw new Error('Updates require a trusted HTTPS origin');
  return async (value, { signal, headers = {}, method = 'GET' } = {}) => {
    const url = new URL(value);
    if (url.origin !== trusted.origin || url.username || url.password)
      throw new Error('Update origin or credentials refused');
    if (method !== 'GET') throw new Error('Updates only support GET');
    signal?.throwIfAborted();
    const headerEntries = [...new Headers(headers)];
    const profile = await mkdtemp(join(app.getPath('temp'), 'cc-update-network-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [
      ...(!app.isPackaged ? [app.getAppPath()] : []),
      resolveProxyOnly ? '--cc-system-proxy-network' : '--cc-update-network',
      '--user-data-dir=' + profile,
    ];
    return await new Promise((resolve, reject) => {
      let child,
        controller,
        ended = false,
        settled = false,
        failure;
      const fail = (error) => {
        failure ||= error;
        child?.kill();
      };
      const abort = () => fail(new Error('Update request aborted'));
      const timeout = setTimeout(
        () => fail(new Error('Update network helper timed out')),
        30 * 60 * 1000,
      );
      const send = (message) => {
        if (child.connected)
          child.send(message, (error) => {
            if (error && !ended) fail(error);
          });
      };
      child = spawn(executable, args, {
        env,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      child.once('error', fail);
      child.on('message', (message) => {
        if (failure) return;
        if (message?.type === 'ready') {
          send({ type: 'start', origin: trusted.origin, url: url.href, headers: headerEntries });
        } else if (message?.type === 'headers' && !settled) {
          const body = [204, 205, 304].includes(message.status)
            ? null
            : new ReadableStream(
                {
                  start(value) {
                    controller = value;
                  },
                  pull() {
                    send({ type: 'pull' });
                  },
                  cancel() {
                    abort();
                  },
                },
                { highWaterMark: 0 },
              );
          try {
            settled = true;
            resolve(new Response(body, { status: message.status, headers: message.headers }));
          } catch (error) {
            fail(error);
            reject(error);
          }
        } else if (message?.type === 'chunk' && controller) {
          controller.enqueue(Buffer.from(message.data, 'base64'));
        } else if (message?.type === 'end') {
          ended = true;
        } else if (message?.type === 'error') {
          fail(new Error(message.message || 'Update request failed'));
        }
      });
      child.once('close', async (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (!ended || code !== 0) fail(failure || new Error('Update network helper exited'));
        // Windows may briefly retain Chromium database locks after helper close.
        // Retry only the OS transient removal errors, with a bounded 1.5s backoff.
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
          () => {
            console.warn('Unable to remove temporary update network profile');
          },
        );
        // Failure settles after process close/cleanup, so a proxy-resolution
        // slot cannot be reused while its previous helper is still alive.
        if (failure) {
          if (!settled) {
            settled = true;
            reject(failure);
          } else if (controller) {
            try {
              controller.error(failure);
            } catch {}
          }
        } else if (ended && controller) controller.close();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
}
function createManagedFetch({ app, origin, executable }) {
  return createNetworkFetch({ app, origin, executable });
}

// Only main-process service connections use this resolver. It evaluates the
// system proxy/PAC but makes no request to the configured CC service itself.
function createSystemProxyResolver({ app, executable }) {
  let active = 0;
  const queue = [];
  const acquire = (signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const cancel = () => {
        const index = queue.indexOf(start);
        if (index !== -1) queue.splice(index, 1);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        active++;
        resolve(() => {
          active--;
          queue.shift()?.();
        });
      };
      if (active < 2) start();
      else if (queue.length >= 128) reject(new Error('System proxy resolver busy'));
      else {
        queue.push(start);
        signal.addEventListener('abort', cancel, { once: true });
      }
    });
  return async (value, callerSignal) => {
    const url = new URL(value);
    if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password)
      throw new Error('System proxy resolution requires a credential-free HTTPS/WSS URL');
    url.protocol = 'https:';
    const signal = AbortSignal.any([
      ...(callerSignal ? [callerSignal] : []),
      AbortSignal.timeout(15000),
    ]);
    const release = await acquire(signal);
    try {
      const fetch = createNetworkFetch({
        app,
        executable,
        origin: url.origin,
        resolveProxyOnly: true,
      });
      const response = await fetch(url.href, { signal });
      return await response.text();
    } finally {
      release();
    }
  };
}
module.exports = { createManagedFetch, createSystemProxyResolver };
