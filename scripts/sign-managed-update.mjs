import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { open, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ARTIFACT_BYTES,
  MAX_INDEX_BYTES,
  signIndex,
  verifyIndex,
} from '../packages/managed-updates/src/index.ts';

const toolRoot = fileURLToPath(new URL('..', import.meta.url));
const usage =
  'node scripts/sign-managed-update.mjs --input payload.json --key-id KEY_ID --private-key EXTERNAL_KEY --out NEW_INDEX [--source CLEAN_CHECKOUT --artifact SETUP_EXE]';
class InputError extends Error {}
function check(value, message) {
  if (!value) throw new InputError(message);
}

function argumentsFor(argv) {
  const names = new Set(['input', 'key-id', 'private-key', 'out', 'source', 'artifact']);
  const result = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    check(
      names.has(name) &&
        !Object.hasOwn(result, name) &&
        argv[i + 1] &&
        !argv[i + 1].startsWith('--'),
      '参数未知、重复或缺少值。',
    );
    result[name] = argv[i + 1];
  }
  for (const name of ['input', 'key-id', 'private-key', 'out'])
    check(result[name], '缺少必填参数。');
  return result;
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function readLimited(path, limit) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    check(info.isFile() && info.size <= limit, '输入必须是大小合规的普通文件。');
    // Read one extra byte to detect growth without an unbounded readFile allocation.
    const bytes = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    check(total <= limit, '输入文件超过大小限制。');
    return bytes.subarray(0, total);
  } finally {
    await file.close();
  }
}

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

async function checkSource(root, release) {
  const top = await realpath(git(root, 'rev-parse', '--show-toplevel'));
  check(relative(root, top) === '', '--source 必须指向 Git 源码根目录。');
  check(
    git(root, 'status', '--porcelain', '--untracked-files=normal') === '',
    '源码工作树必须清洁。',
  );
  check(
    git(root, 'rev-parse', 'HEAD') === release.sourceCommit,
    'sourceCommit 与源码 HEAD 不一致。',
  );
  const manifest = JSON.parse(git(root, 'show', 'HEAD:apps/desktop/package.json'));
  check(manifest.version === release.appVersion, 'appVersion 与源码不一致。');
  const protocolSource = git(root, 'show', 'HEAD:packages/protocol/src/index.ts');
  const match = /^export const PROTOCOL_VERSION = (\d+);$/m.exec(protocolSource.replace(/\r/g, ''));
  check(match && Number(match[1]) === release.protocol, 'protocol 与源码不一致。');
}

async function hashArtifact(path) {
  const file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    check(
      before.isFile() && before.size > 0n && before.size <= BigInt(MAX_ARTIFACT_BYTES),
      '安装包必须是 1 GiB 以内的非空普通文件。',
    );
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      check(
        size <= MAX_ARTIFACT_BYTES && size <= Number(before.size),
        '读取期间安装包大小发生变化。',
      );
      hash.update(chunk);
    }
    const after = await file.stat({ bigint: true });
    check(
      BigInt(size) === before.size &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      '读取期间安装包发生变化。',
    );
    return { size, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(usage);
    return;
  }
  const args = argumentsFor(argv);
  const outputDir = await realpath(dirname(resolve(args.out)));
  const output = resolve(outputDir, basename(args.out));
  const keyPath = await realpath(args['private-key']);
  check(
    !inside(await realpath(toolRoot), keyPath) && !inside(outputDir, keyPath),
    '私钥必须位于源码树及输出目录之外。',
  );
  const inputBytes = await readLimited(args.input, MAX_INDEX_BYTES);
  const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inputBytes));
  check(payload && typeof payload === 'object' && !Array.isArray(payload), '输入必须是载荷对象。');
  let source = null;
  if (payload.state === 'published') {
    check(args.source && args.artifact, '发布需要 --source 和 --artifact。');
    source = await realpath(args.source);
    check(!inside(source, keyPath), '私钥必须位于源码树之外。');
    check(
      payload.release && typeof payload.release === 'object' && !Array.isArray(payload.release),
      '缺少发布身份。',
    );
    check(
      !Object.hasOwn(payload.release, 'size') && !Object.hasOwn(payload.release, 'sha256'),
      'size 与 sha256 由工具计算，请勿填写。',
    );
    check(basename(args.artifact) === payload.release.filename, '安装包实际文件名与载荷不一致。');
    await checkSource(source, payload.release);
    Object.assign(payload.release, await hashArtifact(args.artifact));
  } else {
    check(
      payload.state === 'empty' && !args.source && !args.artifact,
      '撤回使用 empty 状态，不接受源码或安装包。',
    );
  }
  const privateKey = createPrivateKey(await readLimited(keyPath, 16 * 1024));
  check(privateKey.asymmetricKeyType === 'ed25519', '私钥必须是 Ed25519。');
  const signed = signIndex(payload, args['key-id'], privateKey);
  // Self-verify before writing; the verifier does not trust a network-provided key.
  verifyIndex(signed, { [args['key-id']]: createPublicKey(privateKey) });
  if (source) await checkSource(source, payload.release);
  // Exclusive creation protects existing indexes and refuses output symlinks.
  await writeFile(output, signed, { flag: 'wx', mode: 0o644 });
  console.log(
    `已生成签名索引：${payload.channel} / revision ${payload.revision} / ${payload.state}。未上传或部署。`,
  );
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  // Never echo input JSON, PEM data, Git output or untrusted exception details.
  console.error(
    '签名失败：' +
      (error instanceof InputError
        ? error.message
        : '参数、载荷、Git、文件或密钥校验未通过；请核对输入。'),
  );
  process.exitCode = 1;
}
