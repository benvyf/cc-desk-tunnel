const { createHash } = require('node:crypto');
const { realpath, open } = require('node:fs/promises');
const path = require('node:path');
const { isTrustedRenderer } = require('./renderer-origin.cjs');
function allowHistoryPersistence(contents, permission, details, primary, entry) {
  return (
    permission === 'persistent-storage' &&
    details?.isMainFrame === true &&
    isTrustedRenderer({ sender: contents, senderFrame: contents?.mainFrame }, primary, entry)
  );
}

function historyOwner(origin, email) {
  return typeof email === 'string' && email.trim()
    ? createHash('sha256')
        .update(JSON.stringify([origin, email.trim().toLowerCase()]))
        .digest('hex')
    : null;
}
const privatePath = (value) =>
  /(?:^|[\\/])(?:\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.claude|\.codex|\.cc-switch|gcloud)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|credentials(?:\.json)?|secrets\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[^\\/]+\.(?:pem|key|p12|pfx|ppk))$/i.test(
    value,
  );
async function readHistoryAttachment(file) {
  if (typeof file === 'string' && /^(?:\\\\|\/\/)/.test(file))
    throw new Error('网络共享附件不自动归档。');
  if (typeof file !== 'string' || !path.isAbsolute(file) || privatePath(file))
    throw new Error('敏感配置或凭据文件不自动归档。');
  const resolved = await realpath(file);
  if (/^(?:\\\\|\/\/)/.test(resolved)) throw new Error('网络共享附件不自动归档。');
  if (privatePath(resolved)) throw new Error('敏感配置或凭据文件不自动归档。');
  const handle = await open(resolved, 'r');
  try {
    const info = await handle.stat();
    const limit = 20 * 1024 * 1024;
    if (!info.isFile() || info.size > limit)
      throw new Error('附件不是普通文件或超过 20 MB，未保存副本。');
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('附件正在变化，请稍后重试归档。');
    const text = buffer.subarray(0, used).toString('utf8');
    if (
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|PuTTY-User-Key-File-|"(?:claudeAiOauth|access_token|refresh_token|ANTHROPIC_API_KEY|api_key)"\s*:/i.test(
        text,
      )
    )
      throw new Error('私钥或认证配置内容不自动归档。');
    const types = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const type = types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    return `data:${type};base64,${buffer.subarray(0, used).toString('base64')}`;
  } finally {
    await handle.close();
  }
}
module.exports = { historyOwner, readHistoryAttachment, allowHistoryPersistence };
