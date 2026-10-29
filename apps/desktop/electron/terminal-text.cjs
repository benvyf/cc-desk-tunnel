const { constants } = require('node:fs');
const { open, realpath } = require('node:fs/promises');
const { isAbsolute } = require('node:path');
const { localPath } = require('./file-links.cjs');

// Explicit terminal preview only; no shell, clipboard writes or file execution.
async function readTerminalText(written) {
  const path = localPath(written, isAbsolute);
  if (!path) throw new Error('只支持本机绝对路径。');
  const actual = localPath(await realpath(path), isAbsolute);
  if (!actual) throw new Error('文件实际位于其他设备，不能读取。');
  const file = await open(
    actual,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('请选择普通文件。');
    const limit = 256 * 1024;
    if (stat.size > limit) throw new Error('文本超过 256 KiB。');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('文本超过 256 KiB。');
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0)) throw new Error('不支持预览二进制文件。');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } finally {
    await file.close();
  }
}
module.exports = { readTerminalText };
