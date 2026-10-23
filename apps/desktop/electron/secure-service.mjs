import { request } from 'node:http';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { httpProxy, openSocket } from './system-proxy.mjs';
export function certificateMatches(observed, trusted) {
  if (typeof trusted !== 'string' || typeof observed !== 'string') return false;
  const pin = trusted.replaceAll(':', '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(pin) && observed.replaceAll(':', '').toLowerCase() === pin;
}
export function controlTlsOptions(config) {
  if (!config.fingerprint) return { rejectUnauthorized: true };
  if (!certificateMatches(config.fingerprint, config.fingerprint))
    throw new Error('请输入可信安装信息中的 SHA256 证书指纹，或留空使用 CA 验证。');
  return { rejectUnauthorized: false };
}
// The waits of connecting, in milliseconds. Whatever is not a sensible number of seconds takes the default, and
// the whole is never shorter than the local SSH service is given plus the rest of the way.
export function connectionWaits(values) {
  const wait = (seconds, fallback) =>
    (Number.isInteger(seconds) && seconds >= 5 && seconds <= 600 ? seconds : fallback) * 1000;
  const ssh = wait(values?.ssh, 10);
  return {
    connect: wait(values?.connect, 15),
    ssh,
    ready: Math.max(wait(values?.ready, 45), ssh + 35000),
  };
}
// Bound proxy resolution and socket dialing together; a late socket is closed after cancellation.
export async function connectService(address, config, resolveProxy, route, signal) {
  controlTlsOptions(config);
  const port = Number(address.port || 443),
    timeout = connectionWaits(config.waits).connect;
  let cancelled = false,
    timer,
    abort;
  const interruption = new Promise((_, reject) => {
    abort = () => {
      cancelled = true;
      reject(new Error('服务连接已取消。'));
    };
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error('服务连接超时。'));
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([
      interruption,
      (async () => {
        const proxy = httpProxy(await resolveProxy?.(`https://${address.hostname}:${port}`));
        if (cancelled) throw new Error('服务连接已取消。');
        if (route) route.proxy = proxy;
        const socket = await openSocket(proxy, address.hostname, port, timeout);
        if (cancelled) {
          socket.destroy();
          throw new Error('服务连接已取消。');
        }
        socket.setKeepAlive(true, 30000);
        return connect({
          socket,
          servername: isIP(address.hostname) ? undefined : address.hostname,
          ...controlTlsOptions(config),
        });
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
// TLS is established and verified before the HTTP request exists, so credentials cannot reach an untrusted peer.
export async function authorizedRequest(
  address,
  config,
  method,
  path,
  token,
  resolveProxy,
  { body, timeout = 15000, signal } = {},
) {
  const socket = await connectService(address, config, resolveProxy, undefined, signal);
  let timer;
  const abort = () => socket.destroy(new Error('服务管理请求已取消。'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => socket.destroy(new Error('服务管理请求超时。')), timeout);
      socket.once('secureConnect', () => {
        if (
          config.fingerprint &&
          !certificateMatches(socket.getPeerCertificate().fingerprint256, config.fingerprint)
        ) {
          socket.destroy();
          reject(new Error('服务证书指纹不匹配；未发送服务凭据。'));
        } else resolve();
      });
      socket.once('error', reject);
    });
    return await new Promise((resolve, reject) => {
      const download = request(
        {
          host: address.hostname,
          method,
          path,
          createConnection: () => socket,
          headers: {
            Connection: 'close',
            Host: address.host,
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
          },
        },
        resolve,
      );
      download.on('error', reject);
      download.setTimeout(timeout, () => download.destroy(new Error('服务管理请求超时。')));
      download.end(body);
    });
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export function authorizedGet(address, config, path, token, resolveProxy) {
  return authorizedRequest(address, config, 'GET', path, token, resolveProxy);
}
export async function serviceJson(config, method, path, body, resolveProxy, signal) {
  const response = await authorizedRequest(
    new URL(config.url),
    config,
    method,
    path,
    config.token,
    resolveProxy,
    {
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: method === 'POST' && path.endsWith('/install') ? 135000 : 15000,
      signal,
    },
  );
  const abort = () => response.destroy(new Error('服务管理请求已取消。'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => response.destroy(new Error('服务管理响应超时。')), 15000);
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 256 * 1024) {
        response.destroy();
        throw new Error('服务管理响应过大。');
      }
      chunks.push(chunk);
    }
    if (![200, 202].includes(response.statusCode)) {
      const code = response.statusCode;
      throw Object.assign(
        new Error(
          code === 404
            ? '服务端未启用配套管理，请先安装 Ubuntu 引导镜像。'
            : code === 409
              ? '服务繁忙或目标已变化，请重新检查。'
              : `服务管理请求失败（${code}）。`,
        ),
        { code: code === 404 ? 'unsupported' : code === 409 ? 'conflict' : 'http', status: code },
      );
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    response.destroy();
  }
}
