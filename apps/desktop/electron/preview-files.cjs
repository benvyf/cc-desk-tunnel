const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { realpath, open, stat } = require('node:fs/promises');
const path = require('node:path');
const { localPath } = require('./file-links.cjs');
const { decodeText, textLimit } = require('./text-decode.cjs');

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
const megabytes = (size) => `${Math.round((size / 1024 / 1024) * 10) / 10} MB`;
const tooLarge = (limit) => new Error(`文件超过预览大小限制（${megabytes(limit)}）。`);
// Reads the start of a file, at most `limit` bytes and one more to tell whether there is more;
// `whole` refuses a file over the limit instead.
async function head(file, limit, whole = false) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('请选择普通文件。');
    if (whole && info.size > limit) throw tooLarge(limit);
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    return { data: buffer.subarray(0, bytesRead), size: Math.max(info.size, bytesRead) };
  } finally {
    await handle.close();
  }
}
async function bytes(file, limit) {
  const { data } = await head(file, limit, true);
  if (data.length > limit) throw tooLarge(limit);
  return data;
}

// This server serves only explicitly opened project roots, with an unguessable URL per file tab.
// It is independent of the Ubuntu connection and never handles model or authentication requests.
function createPreviewFiles() {
  const mounts = new Map();
  let server, starting;
  let generation = 0;
  let office;
  // Recent Office conversions by path, reused while the file's size and modification time are
  // unchanged (a refresh, a repeated change notification, reopening the tab).
  const conversions = new Map();
  // Conversions under way by path and version, so overlapping reads of one file convert it once.
  const converting = new Map();
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
          // The opened page itself is labelled with the encoding its preview was read in, or not at
          // all when that was a guess and the page names its own; other files of the site stay UTF-8.
          const charset = file === mount.file ? mount.charset : 'utf-8';
          const contentType =
            (mime.startsWith('text/') || mime === 'application/json') && charset
              ? `${mime}; charset=${charset}`
              : mime;
          response.writeHead(200, {
            'content-type': contentType,
            'content-length': data.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'same-origin',
            'x-dns-prefetch-control': 'off',
            'content-security-policy':
              "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
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
      if (['.xls', '.xlsx', '.csv', '.tsv'].includes(extension)) {
        const data = await bytes(file, 20 * 1024 * 1024);
        return {
          path: file,
          kind: 'spreadsheet',
          format: extension.slice(1),
          data: data.toString('base64'),
        };
      }
      if (['.doc', '.docx', '.ppt', '.pptx', '.odt', '.ods', '.odp'].includes(extension)) {
        const authorize = (candidate) => {
          if (
            !inside(root, candidate) ||
            (input.restricted && privateResource(path.relative(root, candidate).split(path.sep)))
          )
            throw new Error('文件不在原预览工作区内或位于私有目录。');
        };
        const version = (info) => info.isFile() && `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const before = version(await stat(file));
        const known = conversions.get(file);
        // The refresh button asks for a new conversion (fonts may have been installed meanwhile).
        if (before && known?.version === before && !input.fresh) {
          authorize(file);
          return { path: file, kind: 'pdf', ...known.result };
        }
        const pending = before && `${before}:${file}`;
        let job = pending && converting.get(pending);
        if (job) authorize(file);
        else {
          office ??= require('./preview-office.cjs').createPreviewOffice();
          job = office.render(file, authorize);
          if (pending) {
            converting.set(pending, job);
            const done = () => {
              if (converting.get(pending) === job) converting.delete(pending);
            };
            void job.then(done, done);
          }
        }
        const result = await job;
        if (openedAt !== generation) throw new Error('预览来源已失效，请重新打开文件。');
        // A file that changed while it was converted is not remembered under either version.
        if (before && version(await stat(file).catch(() => null)) === before) {
          conversions.delete(file);
          conversions.set(file, { version: before, result });
          for (const key of conversions.keys()) {
            if (conversions.size <= 2) break;
            conversions.delete(key);
          }
        }
        return { path: file, kind: 'pdf', ...result };
      }
      if (extension === '.pdf') {
        const data = await bytes(file, 20 * 1024 * 1024);
        if (!data.subarray(0, 5).equals(Buffer.from('%PDF-')))
          throw new Error('不是有效的 PDF 文件。');
        return { path: file, kind: 'pdf', data: data.toString('base64') };
      }
      if (mime?.startsWith('image/')) {
        const data = await bytes(file, 20 * 1024 * 1024);
        return {
          path: file,
          kind: 'image',
          image: `data:${mime};base64,${data.toString('base64')}`,
        };
      }
      // A text file larger than the limit shows its beginning, cut at a character boundary.
      const read = await head(file, textLimit);
      const cut = read.data.length > textLimit;
      const { text, encoding, guessed } = decodeText(
        cut ? read.data.subarray(0, textLimit) : read.data,
        {
          cut,
        },
      );
      const result = {
        path: file,
        // The beginning of a document is shown as source: half a page is not rendered.
        kind: !cut && (extension === '.md' || extension === '.markdown') ? 'markdown' : 'text',
        text,
      };
      if (encoding !== 'utf-8') result.encoding = encoding;
      if (cut) Object.assign(result, { truncated: true, size: read.size });
      if (!cut && (extension === '.html' || extension === '.htm')) {
        await start();
        if (openedAt !== generation) throw new Error('预览来源已失效，请重新打开文件。');
        const token = randomBytes(24).toString('hex');
        // A guessed GB18030 gives way to the page's own declaration; a guessed UTF-16 does not, since a page's meta
        // cannot be read by the browser from UTF-16 bytes.
        const declared = /<meta\s[^>]*(?:charset\s*=|http-equiv\s*=\s*["']?content-type)/i.test(
          text.slice(0, 1024),
        );
        mounts.set(token, {
          root,
          file,
          charset: encoding === 'gb18030' && guessed && declared ? '' : encoding,
        });
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
      office?.reset();
      mounts.clear();
      conversions.clear();
      converting.clear();
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
      conversions.clear();
      await office?.close();
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
