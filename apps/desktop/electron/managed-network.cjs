const { open, stat, rm } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');

// net.fetch is supplied by Electron's main process: Chromium honours the system proxy.
function createNetwork(fetch, origin) {
  async function request(url, { signal, headers = {}, metadata = false } = {}) {
    for (let hops = 0; hops <= 4; hops++) {
      const response = await fetch(url, {
        signal,
        headers,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      if (metadata) throw new Error('更新索引不允许重定向');
      const next = new URL(response.headers.get('location'), url);
      if (
        next.origin !== origin ||
        next.protocol !== 'https:' ||
        next.username ||
        next.password ||
        next.search ||
        next.hash ||
        !next.pathname.startsWith('/cc-updates/v1/artifacts/')
      )
        throw Object.assign(new Error('拒绝安装包重定向'), { code: 'UPDATE_POLICY' });
      url = next.href;
    }
    throw Object.assign(new Error('安装包重定向过多'), { code: 'UPDATE_POLICY' });
  }

  async function index(channel, signal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    const response = await request(`${origin}/cc-updates/v1/channels/${channel}/win32-x64.json`, {
      signal: combined,
      metadata: true,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`更新索引 HTTP ${response.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 65536) {
        combined.throwIfAborted();
        throw new Error('更新索引过大');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function download(url, file, release, signal, progress) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
    let stalled = 0;
    while (true) {
      deadline.throwIfAborted();
      const before = await stat(file).then(
        (s) => s.size,
        (error) => {
          if (error.code === 'ENOENT') return 0;
          throw error;
        },
      );
      if (before === release.size) return;
      if (before > release.size) {
        await rm(file);
        throw new Error('安装包超过签名大小');
      }
      const idle = new AbortController();
      const combined = AbortSignal.any([deadline, idle.signal, AbortSignal.timeout(20000)]);
      let timer;
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), 15000);
      };
      let fatal = false;
      let received = before;
      let handle;
      try {
        touch();
        const response = await request(url, {
          signal: combined,
          headers: {
            'Accept-Encoding': 'identity',
            ...(before ? { Range: `bytes=${before}-` } : {}),
          },
        });
        const reject = async (message) => {
          fatal = true;
          await response.body?.cancel();
          throw new Error(message);
        };
        if (
          response.headers.get('content-encoding') &&
          response.headers.get('content-encoding') !== 'identity'
        )
          await reject('安装包不可压缩传输');
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            response.headers.get('content-range') ?? '',
          );
          if (
            !range ||
            Number(range[1]) !== before ||
            Number(range[2]) !== release.size - 1 ||
            Number(range[3]) !== release.size
          )
            await reject('安装包 Content-Range 不匹配');
        } else if (response.status === 200) received = 0;
        else await reject(`安装包 HTTP ${response.status}`);
        const length = response.headers.get('content-length');
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) !== release.size - received)
        )
          await reject('安装包 Content-Length 不匹配');
        handle = await open(file, received ? 'a' : 'w');
        for await (const chunk of response.body) {
          touch();
          if (received + chunk.length > release.size) {
            fatal = true;
            throw new Error('安装包超过签名大小');
          }
          let offset = 0;
          while (offset < chunk.length) {
            const result = await handle.write(chunk, offset, chunk.length - offset);
            offset += result.bytesWritten;
          }
          received += chunk.length;
          progress(received);
        }
        await handle.sync();
        if (received === release.size) return;
      } catch (error) {
        if (
          fatal ||
          deadline.aborted ||
          ['UPDATE_POLICY', 'ENOSPC', 'EACCES', 'EPERM', 'EIO'].includes(error.code)
        )
          throw error;
      } finally {
        clearTimeout(timer);
        await handle?.close();
      }
      stalled = received > before ? 0 : stalled + 1;
      if (stalled >= 5) throw new Error('安装包连续五次下载无进展');
      await delay(250, undefined, { signal: deadline });
    }
  }
  return { index, download };
}
module.exports = { createNetwork };
