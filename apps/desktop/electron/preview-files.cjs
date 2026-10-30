const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { realpath, open } = require('node:fs/promises');
const path = require('node:path');
const { localPath } = require('./file-links.cjs');

const types = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.map': 'application/json',
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const privateDirectories = new Set(['.git', '.ssh', '.claude', '.codex']);
const privateResource = (parts) =>
  parts.some((part) => privateDirectories.has(part.toLowerCase())) || parts.at(-1)?.startsWith('.');
function localWebsite(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('请输入本机网站地址，例如 http://localhost:5173。');
  return url.href;
}
async function bytes(file, limit) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件。');
    if (stat.size > limit) throw new Error('文件超过预览大小限制。');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > limit) throw new Error('文件超过预览大小限制。');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// This server serves only explicitly opened project roots, with an unguessable URL per file tab.
// It is independent of the Ubuntu connection and never handles model or authentication requests.
function createPreviewFiles() {
  const mounts = new Map();
  let server, starting;
  let generation = 0;
  async function start() {
    if (starting) return starting;
    starting = (async () => {
      server = createServer((request, response) => {
        void (async () => {
          if (!['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(403).end();
            return;
          }
          const url = new URL(request.url, `http://${request.headers.host}`);
          const token = url.hostname.split('.')[0];
          const mount = mounts.get(token);
          if (!mount || url.host !== `${token}.localhost:${server.address().port}`) {
            response.writeHead(404).end();
            return;
          }
          const segments = (url.pathname === '/' ? '/index.html' : url.pathname)
            .slice(1)
            .split('/')
            .map(decodeURIComponent);
          if (
            segments.some(
              (segment) =>
                !segment || segment === '.' || segment === '..' || /[\\/:\0]/.test(segment),
            )
          ) {
            response.writeHead(403).end();
            return;
          }
          const file = await realpath(path.join(mount.root, ...segments));
          const mime = types[path.extname(file).toLowerCase()];
          if (
            !inside(mount.root, file) ||
            !mime ||
            ((privateResource(segments) ||
              privateResource(path.relative(mount.root, file).split(path.sep))) &&
              file !== mount.file)
          ) {
            response.writeHead(403).end();
            return;
          }
          const data = await bytes(file, 20 * 1024 * 1024);
          const contentType =
            mime.startsWith('text/') || mime === 'application/json'
              ? `${mime}; charset=utf-8`
              : mime;
          response.writeHead(200, {
            'content-type': contentType,
            'content-length': data.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'same-origin',
          });
          response.end(request.method === 'HEAD' ? undefined : data);
        })().catch(() => {
          if (!response.headersSent) response.writeHead(404);
          response.end();
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    })();
    return starting;
  }
  return {
    async read(input) {
      const openedAt = generation;
      if (!input || !localPath(input.path, path.isAbsolute))
        throw new Error('请选择本机绝对路径。');
      const file = await realpath(input.path);
      if (!localPath(file, path.isAbsolute)) throw new Error('不支持网络共享文件。');
      let root = path.dirname(file);
      const requested =
        input.root && localPath(input.root, path.isAbsolute)
          ? await realpath(input.root).catch(() => null)
          : null;
      if (requested && localPath(requested, path.isAbsolute) && inside(requested, file))
        root = requested;
      else if (input.restricted) throw new Error('文件不在原预览工作区内。');
      if (input.restricted && privateResource(path.relative(root, file).split(path.sep)))
        throw new Error('文件位于预览工作区的私有目录。');
      const extension = path.extname(file).toLowerCase();
      const mime = types[extension];
      const data = await bytes(
        file,
        mime?.startsWith('image/') ? 20 * 1024 * 1024 : 4 * 1024 * 1024,
      );
      if (mime?.startsWith('image/'))
        return {
          path: file,
          kind: 'image',
          image: `data:${mime};base64,${data.toString('base64')}`,
        };
      if (data.includes(0)) throw new Error('此文件暂不支持预览，请在系统应用中打开。');
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw new Error('此文件不是 UTF-8 文本，请在系统应用中打开。');
      }
      const result = {
        path: file,
        kind: extension === '.md' || extension === '.markdown' ? 'markdown' : 'text',
        text,
      };
      if (extension === '.html' || extension === '.htm') {
        await start();
        if (openedAt !== generation) throw new Error('预览来源已失效，请重新打开文件。');
        const token = randomBytes(24).toString('hex');
        mounts.set(token, { root, file });
        const relative = path
          .relative(root, file)
          .split(path.sep)
          .map(encodeURIComponent)
          .join('/');
        Object.assign(result, {
          kind: 'html',
          url: `http://${token}.localhost:${server.address().port}/${relative}`,
          token,
        });
      }
      return result;
    },
    release(token) {
      mounts.delete(token);
    },
    reset() {
      generation++;
      mounts.clear();
    },
    owns(url) {
      try {
        const value = new URL(url);
        const token = value.hostname.split('.')[0];
        return (
          value.protocol === 'http:' &&
          value.host === `${token}.localhost:${server?.address()?.port}` &&
          mounts.has(token)
        );
      } catch {
        return false;
      }
    },
    async target(url) {
      if (!this.owns(url)) return null;
      const address = new URL(url);
      const mount = mounts.get(address.hostname.split('.')[0]);
      try {
        const parts = (address.pathname === '/' ? '/index.html' : address.pathname)
          .slice(1)
          .split('/')
          .map(decodeURIComponent);
        if (parts.some((part) => !part || part === '.' || part === '..' || /[\\/:\0]/.test(part)))
          return null;
        const file = await realpath(path.join(mount.root, ...parts));
        if (
          !inside(mount.root, file) ||
          ((privateResource(parts) ||
            privateResource(path.relative(mount.root, file).split(path.sep))) &&
            file !== mount.file)
        )
          return null;
        return { path: file, root: mount.root };
      } catch {
        return null;
      }
    },
    async close() {
      generation++;
      mounts.clear();
      if (starting) await starting;
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
module.exports = { createPreviewFiles, localWebsite };
