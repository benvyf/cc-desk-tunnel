import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateConfig } from './config.ts';
import { UpdateError } from './store.ts';
import { ServerDistribution } from './server-distribution.ts';

type NodeRecord = {
  grantHash: string;
  expiresAt: number;
  index: string;
  monitorHash?: string;
  moderationHash?: string;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function readFreshNodes(root: string): Record<string, NodeRecord> {
  try {
    return JSON.parse(readFileSync(join(root, 'private/fresh-nodes.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

// One process owns the management store. Each synchronous read/change/rename is one transaction.
export class FreshNodes {
  private failures = 0;
  private window = 0;
  constructor(privateConfig: UpdateConfig) {
    this.config = privateConfig;
  }
  private config: UpdateConfig;
  monitorNodes() {
    return Object.fromEntries(
      Object.entries(readFreshNodes(this.config.dataDir))
        .filter(([, node]) => node.monitorHash)
        .map(([id, node]) => [id, node.monitorHash!]),
    );
  }
  private save(nodes: Record<string, NodeRecord>) {
    const directory = join(this.config.dataDir, 'private');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'fresh-nodes.json');
    writeFileSync(path + '.next', JSON.stringify(nodes), { mode: 0o600 });
    renameSync(path + '.next', path);
  }
  issue(input: unknown, distribution: ServerDistribution) {
    const id = (input as { nodeId?: unknown } | null)?.nodeId;
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      typeof id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ||
      ['__proto__', 'constructor', 'prototype'].includes(id)
    )
      throw new UpdateError(400, '节点名称请使用 1–64 位小写字母、数字、短横线或下划线。');
    const nodes = readFreshNodes(this.config.dataDir);
    let moderation: Record<string, string> = {};
    try {
      moderation = JSON.parse(
        readFileSync(join(this.config.dataDir, 'private/moderation-nodes.json'), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      Object.hasOwn(this.config.monitorNodes ?? {}, id) ||
      Object.hasOwn(moderation, id) ||
      nodes[id]?.monitorHash
    )
      throw new UpdateError(409, '此节点已接入，请使用其他名称；已有节点通过客户端升级。');
    if (
      !Object.hasOwn(nodes, id) &&
      new Set([...Object.keys(nodes), ...Object.keys(this.config.monitorNodes ?? {})]).size >= 64
    )
      throw new UpdateError(409, '节点数量已达上限。');
    const status = distribution.status();
    if (!status.published || status.expired)
      throw new UpdateError(409, '请先发布有效的 Linux 服务端。');
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(Date.now() + 600000, Date.parse(status.payload.expiresAt));
    const index = distribution.index()!.toString('utf8');
    nodes[id] = { grantHash: hash(code), expiresAt, index };
    this.save(nodes);
    const installer = readFileSync(new URL('../web/fresh-install.py', import.meta.url));
    const url = this.config.origin + '/cc-updates/admin/fresh-install.py';
    const program = `import urllib.request,hashlib,sys,tempfile,pathlib,runpy; print("Downloading verified Ubuntu installer...",flush=True); u=${JSON.stringify(url)}; r=urllib.request.urlopen(u,timeout=30); b=r.read(262145); (r.url==u and len(b)<=262144 and hashlib.sha256(b).hexdigest()==${JSON.stringify(hash(installer))}) or sys.exit("Installer verification failed"); t=tempfile.TemporaryDirectory(); p=pathlib.Path(t.name)/"fresh-install.py"; p.write_bytes(b); sys.argv=[str(p),"--origin",${JSON.stringify(this.config.origin)},"--node",${JSON.stringify(id)},"--code",${JSON.stringify(code)}]; runpy.run_path(str(p),run_name="__main__")`;
    return {
      nodeId: id,
      expiresAt: new Date(expiresAt).toISOString(),
      build: status.payload.release.build,
      command: "sudo python3 -c '" + program.replaceAll("'", "'\"'\"'") + "'",
    };
  }
  redeem(code: string) {
    if (Date.now() - this.window >= 60000) {
      this.window = Date.now();
      this.failures = 0;
    }
    if (this.failures >= 30) throw new UpdateError(429, '安装码验证次数过多，请稍后重试。');
    const nodes = readFreshNodes(this.config.dataDir);
    const entry =
      /^[A-Za-z0-9_-]{43}$/.test(code) &&
      Object.entries(nodes).find(([, n]) => n.grantHash === hash(code));
    if (!entry || entry[1].monitorHash || entry[1].expiresAt <= Date.now()) {
      this.failures++;
      throw new UpdateError(401, '安装码无效、已领取或已过期，请重新生成命令。');
    }
    const [nodeId, node] = entry;
    const monitorToken = randomBytes(32).toString('base64url');
    const moderationToken = randomBytes(32).toString('base64url');
    node.monitorHash = hash(monitorToken);
    node.moderationHash = hash(moderationToken);
    node.grantHash = '';
    this.save(nodes);
    return { nodeId, origin: this.config.origin, index: node.index, monitorToken, moderationToken };
  }
}
