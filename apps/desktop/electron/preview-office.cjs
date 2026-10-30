const { mkdtemp, open, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { localPath } = require('./file-links.cjs');

const limit = 20 * 1024 * 1024;
const formats = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
]);

// Loading the physical module keeps its Worker URLs and engine resolution outside ASAR too.
function unpackedModulePath(file) {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

async function loadConverter(options) {
  const entry = unpackedModulePath(require.resolve('@deepseek-ai/libreoffice-kit'));
  return (await import(pathToFileURL(entry).href)).createConverter(options);
}

async function boundedBytes(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件。');
    if (stat.size > limit) throw new Error('文件超过预览大小限制（20 MiB）。');
    const data = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < data.length) {
      const next = await handle.read(data, length, data.length - length, length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    if (length > limit || length > stat.size)
      throw new Error('文件超过预览大小限制或在读取时发生变化。');
    return data.subarray(0, length);
  } finally {
    await handle.close();
  }
}

// All conversion stays in the main process and its local, bundled engine helpers.
// The adapter loads documents with EnableMacrosExecution=false in a private profile.
function createPreviewOffice({ createConverter = loadConverter, timeoutMs = 60_000 } = {}) {
  const pending = new Map();
  let tail = Promise.resolve();
  let converter;
  let closed = false;
  let closing;
  async function convert(inputPath, controller) {
    const { signal } = controller;
    signal.throwIfAborted();
    const timer = setTimeout(
      () => controller.abort(new Error('Office 预览转换超时，请在系统应用中打开。')),
      timeoutMs,
    );
    let scratch;
    try {
      if (!localPath(inputPath, path.isAbsolute))
        throw new Error('请选择本机绝对路径，不支持网络共享文件。');
      const file = await realpath(inputPath);
      if (!localPath(file, path.isAbsolute)) throw new Error('不支持网络共享文件。');
      const extension = path.extname(file).toLowerCase();
      if (!formats.has(extension)) throw new Error('此 Office 文件格式暂不支持预览。');
      const bytes = await boundedBytes(file);
      signal.throwIfAborted();
      scratch = await mkdtemp(path.join(tmpdir(), 'cc-office-preview-'));
      const source = path.join(scratch, `source${extension}`);
      const output = path.join(scratch, 'preview.pdf');
      await writeFile(source, bytes, { flag: 'wx', mode: 0o600, signal });
      converter ??= await createConverter({
        timeoutMs,
        maxInputBytes: limit,
        maxOutputBytes: limit,
      });
      signal.throwIfAborted();
      const result = await converter.render({ inputPath: source, outputPath: output }, signal);
      signal.throwIfAborted();
      const pdf = await boundedBytes(output);
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw new Error('转换未生成有效的 PDF 文件。');
      signal.throwIfAborted();
      return { data: pdf.toString('base64'), missingFonts: result.missingFonts ?? [] };
    } finally {
      clearTimeout(timer);
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
  return {
    render(inputPath) {
      if (closed) return Promise.reject(new Error('Office 预览已关闭。'));
      if (pending.size >= 4)
        return Promise.reject(new Error('等待预览的 Office 文件过多，请稍后再试。'));
      const controller = new AbortController();
      const job = tail.then(() => convert(inputPath, controller));
      pending.set(controller, job);
      tail = job.then(
        () => {},
        () => {},
      );
      void tail.then(() => pending.delete(controller));
      return job;
    },
    reset() {
      for (const controller of pending.keys())
        controller.abort(new Error('预览来源已失效，请重新打开文件。'));
    },
    close() {
      if (!closing) {
        closed = true;
        this.reset();
        closing = (async () => {
          await tail;
          await converter?.dispose();
        })();
      }
      return closing;
    },
  };
}

module.exports = { createPreviewOffice, unpackedModulePath };
