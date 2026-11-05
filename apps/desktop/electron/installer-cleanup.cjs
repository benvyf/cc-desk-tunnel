const fs = require('node:fs/promises');
const path = require('node:path');

function createInstallerCleanup({
  enabled,
  markerPath,
  installDirectory,
  version,
  read,
  write,
  trash,
  lock,
  ready = async () => {},
}) {
  let candidate;
  let removing = false;
  async function record() {
    const info = await fs.lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768)
      throw Error('Invalid install record');
    const bytes = await fs.readFile(markerPath);
    if (bytes.length > 32768 || bytes[0] !== 0xff || bytes[1] !== 0xfe)
      throw Error('Invalid install record');
    const text = bytes.toString('utf16le').replace(/^\ufeff/, '');
    if (!text.startsWith('[CCSpaceInstall]\r\n')) throw Error('Invalid install record');
    const values = Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    if (
      !/^\{[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\}$/i.test(values.Id ?? '') ||
      values.Version !== version ||
      !path.isAbsolute(values.Path ?? '') ||
      /^[/\\]{2}/.test(values.Path) ||
      !/\.exe$/i.test(values.Path)
    )
      throw Error('Invalid install record');
    if (!/^\d{1,10}$/.test(values.Size ?? '') || !/^\d{1,20}$/.test(values.WriteTime ?? ''))
      throw Error('Invalid install record');
    return {
      id: values.Id,
      path: values.Path,
      size: BigInt(values.Size),
      time: BigInt(values.WriteTime),
    };
  }
  async function capture(target) {
    const info = await fs.lstat(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size < 16n || info.size > 1024n ** 3n)
      throw Error('Not an installer');
    const actual = await fs.realpath(target);
    if (/^[/\\]{2}/.test(actual)) throw Error('Not a local installer');
    const within = path.relative(await fs.realpath(installDirectory), actual);
    if (!path.isAbsolute(within) && within !== '..' && !within.startsWith('..' + path.sep))
      throw Error('Installed files cannot be cleaned');
    const file = await fs.open(actual, 'r');
    try {
      const head = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await file.read(head, 0, head.length, 0);
      const signature = head.subarray(0, bytesRead);
      if (
        signature.toString('ascii', 0, 2) !== 'MZ' ||
        !signature.includes(Buffer.from('NullsoftInst'))
      )
        throw Error('Not an NSIS installer');
      const opened = await file.stat({ bigint: true });
      const fingerprint = (value) =>
        ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((key) => String(value[key])).join(':');
      if (fingerprint(info) !== fingerprint(opened)) throw Error('Installer changed');
      return {
        path: actual,
        size: Number(opened.size),
        time: (opened.mtimeNs + 11644473600000000000n) / 100n,
        fingerprint: fingerprint(opened),
      };
    } finally {
      await file.close();
    }
  }
  const acknowledge = (own) => {
    write({ id: own.id });
    if (candidate?.id === own.id) candidate = undefined;
  };
  return {
    async inspect() {
      if (!enabled) return null;
      await ready();
      try {
        const own = await record();
        if (read()?.id === own.id) return null;
        const file = await capture(own.path);
        if (BigInt(file.size) !== own.size || file.time !== own.time) return null;
        if (read()?.id === own.id) return null;
        candidate = { ...own, file };
        return { name: path.basename(file.path), path: file.path, size: file.size };
      } catch {
        return null;
      }
    },
    async keep() {
      if (candidate) acknowledge(candidate);
    },
    async remove() {
      if (!enabled || !candidate || removing) throw Error('没有可清理的安装包。');
      const own = candidate;
      removing = true;
      try {
        return await lock(async () => {
          const current = await record().catch(() => null);
          if (
            !current ||
            current.id !== own.id ||
            current.path !== own.path ||
            current.size !== own.size ||
            current.time !== own.time
          )
            throw Error('安装包信息发生变化，已保留文件。');
          let file;
          try {
            file = await capture(own.path);
          } catch (error) {
            if (error.code === 'ENOENT') {
              acknowledge(own);
              return;
            }
            throw Error('安装包发生变化，已保留文件。');
          }
          if (file.path !== own.file.path || file.fingerprint !== own.file.fingerprint)
            throw Error('安装包发生变化，已保留文件。');
          try {
            await trash(file.path);
          } catch {
            throw Error('暂时无法移至回收站。请关闭安装器后重试，或选择保留安装包。');
          }
          acknowledge(own);
        });
      } finally {
        removing = false;
      }
    },
  };
}

function registerInstallerCleanup(handle, cleanup) {
  for (const action of ['inspect', 'keep', 'remove'])
    handle(`installer-cleanup:${action}`, async (_event, ...args) => {
      if (args.length) throw Error('安装包清理不接受路径参数。');
      return cleanup[action]();
    });
}

module.exports = { createInstallerCleanup, registerInstallerCleanup };
