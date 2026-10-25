const { app, session, net } = require('electron');
const { Readable } = require('node:stream');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// No window, preload, website profile or listening socket. Exactly one trusted
// GET or proxy evaluation per inherited IPC channel; update redirects remain
// controlled by managed-network. Proxy-only mode never requests the service.
if (!process.connected || !process.send) app.exit(1);
else {
  const resolveProxyOnly = process.argv.includes('--cc-system-proxy-network');
  let started = false,
    reader,
    reading = false,
    pending;
  const abort = new AbortController();
  const send = (message) =>
    new Promise((done, reject) => {
      process.send(message, (error) => (error ? reject(error) : done()));
    });
  const finish = async (code, error) => {
    if (error) await send({ type: 'error', message: error.message }).catch(() => {});
    abort.abort();
    app.exit(code);
  };
  process.once('disconnect', () => {
    abort.abort();
    app.exit(1);
  });
  process.on('message', async (message) => {
    try {
      if (message?.type === 'start' && !started) {
        started = true;
        await app.whenReady();
        const origin =
          app.isPackaged && !resolveProxyOnly
            ? JSON.parse(readFileSync(join(__dirname, 'managed-build.json'), 'utf8')).origin
            : message.origin;
        const url = new URL(message.url);
        if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password)
          throw new Error('Update origin refused');
        const headers = new Headers(message.headers);
        for (const [name] of headers)
          if (!['accept-encoding', 'range'].includes(name))
            throw new Error('Update header refused');
        headers.set('Accept-Encoding', 'identity');
        if (resolveProxyOnly) {
          const answer = await session.fromPartition('cc-update-network').resolveProxy(url.href);
          reader = Readable.toWeb(Readable.from([Buffer.from(answer)])).getReader();
          await send({ type: 'headers', status: 200, headers: [] });
          return;
        }
        const response = await new Promise((done, reject) => {
          const request = net.request({
            url: url.href,
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            useSessionCookies: false,
            session: session.fromPartition('cc-update-network'),
          });
          const entries = (values) =>
            Object.entries(values).flatMap(([name, value]) =>
              (Array.isArray(value) ? value : [value]).map((item) => [name, item]),
            );
          for (const [name, value] of headers) request.setHeader(name, value);
          request.setHeader('Cache-Control', 'no-store');
          request.once('error', reject);
          request.once('response', (incoming) =>
            done({
              status: incoming.statusCode,
              headers: entries(incoming.headers),
              reader: Readable.toWeb(incoming).getReader(),
            }),
          );
          request.once('redirect', (status, _method, _target, values) => {
            done({ status, headers: entries(values), reader: null });
            request.abort(); // Caller decides whether a same-origin redirect is permitted.
          });
          abort.signal.addEventListener('abort', () => request.abort(), { once: true });
          request.end();
        });
        reader = response.reader;
        await send({ type: 'headers', status: response.status, headers: response.headers });
        if (!reader || [204, 205, 304].includes(response.status)) {
          await send({ type: 'end' });
          return void (await finish(0));
        }
      } else if (message?.type === 'pull' && started && !reading) {
        reading = true;
        if (!pending?.length) {
          const result = reader ? await reader.read() : { done: true };
          if (result.done) {
            await send({ type: 'end' });
            return void (await finish(0));
          }
          pending = result.value;
        }
        const chunk = pending.subarray(0, 65536);
        pending = pending.subarray(chunk.length);
        // JSON IPC works across the Node/Electron V8 versions in local tests;
        // at most one bounded chunk is outstanding.
        // The parent may receive this chunk and send its next pull before our
        // send callback runs. Release the read guard before publishing it.
        reading = false;
        await send({ type: 'chunk', data: Buffer.from(chunk).toString('base64') });
      } else {
        throw new Error('Update helper protocol refused');
      }
    } catch (error) {
      await finish(1, error);
    }
  });
  app
    .whenReady()
    .then(() => send({ type: 'ready' }))
    .catch((error) => finish(1, error));
}
