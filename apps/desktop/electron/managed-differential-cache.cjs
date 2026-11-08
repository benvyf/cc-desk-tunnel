const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const contract = require('./managed-differential-contract.cjs');
const NAME = /^base-\d+-[a-f0-9]{64}-[a-f0-9-]{36}$/;
async function safeDirectory(directory) {
  if (!path.isAbsolute(directory) || directory.startsWith('\\\\'))
    throw new Error('更新缓存必须位于本机目录');
  let current = path.resolve(directory);
  while (true) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('更新缓存目录不安全');
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return directory;
}
async function regular(file, max = 1024 ** 3) {
  await safeDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max)
    throw new Error('更新缓存文件不安全');
  return stat;
}
async function limited(file, max) {
  const stat = await regular(file, max);
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1)
      throw new Error('更新缓存文件变化');
    const bytes = Buffer.alloc(max + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count !== stat.size || count > max) throw new Error('更新元数据大小变化');
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
async function hashFile(file, signal) {
  const handle = await fs.open(file, 'r');
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      size += bytes.length;
      if (size > 1024 ** 3) throw new Error('更新文件过大');
      hash.update(bytes);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}
async function durable(file, bytes) {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function retire(directory, name) {
  if (!NAME.test(name)) return;
  const folder = path.join(directory, name);
  try {
    await safeDirectory(folder);
    const entries = await fs.readdir(folder);
    if (entries.some((e) => !['installer.exe', 'map.blockmap', 'descriptor.json'].includes(e)))
      return;
    for (const entry of entries) await regular(path.join(folder, entry));
    for (const entry of entries) await fs.unlink(path.join(folder, entry));
    await fs.rmdir(folder);
  } catch (error) {
    if (error.code !== 'ENOENT') return;
  }
}
async function pointer(directory) {
  try {
    const value = JSON.parse(await limited(path.join(directory, 'baseline.json'), 4096));
    if (Object.keys(value).length === 1 && NAME.test(value.name)) return value.name;
  } catch {}
  return null;
}
async function load(directory, name, identity, signal) {
  const folder = path.join(directory, name);
  await safeDirectory(folder);
  const raw = await limited(path.join(folder, 'descriptor.json'), contract.MAX_DESCRIPTOR_BYTES);
  const descriptor = contract.verifyBaselineDescriptor(raw, identity.trustedKeys, identity);
  const mapBytes = await limited(path.join(folder, 'map.blockmap'), contract.MAX_BLOCKMAP_BYTES);
  const blockmap = contract.decodeBlockmap(mapBytes, descriptor);
  const installer = path.join(folder, 'installer.exe');
  await regular(installer);
  const actual = await hashFile(installer, signal);
  if (actual.size !== descriptor.release.size || actual.sha256 !== descriptor.release.sha256)
    throw new Error('基线安装包校验失败');
  return {
    name,
    installer,
    blockmap,
    descriptor,
    descriptorBytes: raw,
    blockmapBytes: mapBytes,
    networkBytes: 0,
  };
}
async function ensureBaseline({
  identity,
  directory,
  network,
  signal,
  seedPaths = [],
  reserveBytes = 0,
}) {
  signal.throwIfAborted();
  await safeDirectory(directory);
  const old = await pointer(directory);
  // The caller holds the shared update lock; no other adoption can be in flight.
  for (const entry of await fs.readdir(directory)) {
    if (NAME.test(entry) && entry !== old) await retire(directory, entry);
    if (/^differential-\d+-[a-f0-9-]{36}\.part$/.test(entry)) {
      try {
        const file = path.join(directory, entry);
        await regular(file);
        await fs.unlink(file);
      } catch {}
    }
    if (/^baseline-[a-f0-9-]{36}\.tmp$/.test(entry)) {
      try {
        const file = path.join(directory, entry);
        await regular(file, 4096);
        await fs.unlink(file);
      } catch {}
    }
  }
  if (old) {
    try {
      return await load(directory, old, identity, signal);
    } catch (error) {
      signal.throwIfAborted();
    }
  }
  if (!network.descriptor || !network.blockmap) return null;
  const coords = {
    build: identity.build,
    appVersion: identity.appVersion,
    filename: `CC-Space-Setup-${identity.appVersion}-x64.exe`,
  };
  const raw = await network.descriptor(coords, signal);
  signal.throwIfAborted();
  if (!raw) return null;
  const descriptor = contract.verifyBaselineDescriptor(raw, identity.trustedKeys, identity);
  const mapBytes = await network.blockmap(descriptor.release, signal);
  const blockmap = contract.decodeBlockmap(mapBytes, descriptor);
  for (const source of seedPaths) {
    signal.throwIfAborted();
    try {
      const stat = await regular(source);
      if (stat.size !== descriptor.release.size) continue;
      const actual = await hashFile(source, signal);
      if (actual.sha256 !== descriptor.release.sha256) continue;
    } catch (error) {
      signal.throwIfAborted();
      continue;
    }
    const disk = await fs.statfs(directory);
    if (
      Number(disk.bavail) * Number(disk.bsize) <
      descriptor.release.size + reserveBytes + 64 * 1024 ** 2
    )
      throw new Error('更新缓存空间不足');
    const name = `base-${descriptor.release.build}-${descriptor.release.sha256}-${randomUUID()}`;
    const folder = path.join(directory, name);
    await fs.mkdir(folder);
    let temporary;
    try {
      const installer = path.join(folder, 'installer.exe');
      await fs.copyFile(source, installer, require('node:fs').constants.COPYFILE_EXCL);
      const actual = await hashFile(installer, signal);
      if (actual.size !== descriptor.release.size || actual.sha256 !== descriptor.release.sha256)
        throw new Error('基线副本在复制期间变化');
      const handle = await fs.open(installer, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await durable(path.join(folder, 'descriptor.json'), raw);
      await durable(path.join(folder, 'map.blockmap'), mapBytes);
      signal.throwIfAborted();
      temporary = path.join(directory, `baseline-${randomUUID()}.tmp`);
      await durable(temporary, JSON.stringify({ name }));
      await fs.rename(temporary, path.join(directory, 'baseline.json'));
      temporary = null;
      if (old && old !== name) await retire(directory, old);
      return {
        name,
        installer,
        descriptor,
        blockmap,
        descriptorBytes: raw,
        blockmapBytes: mapBytes,
        networkBytes: raw.length + mapBytes.length,
      };
    } catch (error) {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      await retire(directory, name);
      throw error;
    }
  }
  return null;
}
async function tryDownloadDifferential({
  release,
  identity,
  directory,
  network,
  signal,
  onProgress = () => {},
  createRequest,
  seedPaths = [],
}) {
  if (!createRequest || !network.descriptor || !network.blockmap) return null;
  const baseline = await ensureBaseline({
    identity,
    directory,
    network,
    signal,
    seedPaths,
    reserveBytes: release.size,
  });
  if (!baseline) return null;
  const raw = await network.descriptor(release, signal);
  if (!raw) return null;
  const descriptor = contract.verifyDescriptor(
    raw,
    identity.trustedKeys,
    release,
    identity.channel,
  );
  const mapBytes = await network.blockmap(release, signal);
  const blockmap = contract.decodeBlockmap(mapBytes, descriptor);
  const { estimateDifferential, runDifferential } = require('./managed-differential.cjs');
  const estimate = estimateDifferential(baseline.blockmap, blockmap);
  const metadataBytes = baseline.networkBytes + raw.length + mapBytes.length;
  if (estimate.downloadBytes + metadataBytes >= release.size * 0.9) return null;
  const disk = await fs.statfs(directory);
  if (Number(disk.bavail) * Number(disk.bsize) < release.size + 64 * 1024 ** 2)
    throw new Error('更新缓存空间不足');
  const file = path.join(directory, `differential-${release.build}-${randomUUID()}.part`);
  try {
    await runDifferential({
      oldFile: baseline.installer,
      newFile: file,
      newUrl: new URL(
        identity.origin + `/cc-updates/v1/artifacts/${release.build}/win32-x64/${release.filename}`,
      ),
      oldBlockMap: baseline.blockmap,
      newBlockMap: blockmap,
      size: release.size,
      sha512: descriptor.sha512,
      signal,
      createRequest,
      onProgress: (p) =>
        onProgress({
          ...p,
          downloadedBytes: metadataBytes + p.transferred,
          reusedBytes: estimate.copyBytes,
        }),
    });
    const actual = await hashFile(file, signal);
    if (actual.size !== release.size || actual.sha256 !== release.sha256)
      throw new Error('重构安装包完整性校验失败');
    return {
      file,
      downloadedBytes: metadataBytes + estimate.downloadBytes,
      reusedBytes: estimate.copyBytes,
    };
  } catch (error) {
    await fs.unlink(file).catch(() => {});
    throw error;
  }
}
module.exports = { ensureBaseline, tryDownloadDifferential };
