import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateConfig } from './config.ts';
import { UpdateError } from './store.ts';

type Package = { sha256: string; tokenSha256: string; version: string };
type Grant = { hash: string; expiresAt: number; sha256: string };
const digest = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const nodePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Private, bounded, synchronous transactions: no await between checking and consuming a grant.
// One service process owns the existing management store and this registry.
export class EnrollmentStore {
  private dir: string;
  private config: UpdateConfig;
  private failures = 0;
  private window = 0;
  constructor(config: UpdateConfig) {
    this.config = config;
    this.dir = join(config.dataDir, 'private', 'enrollment');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }
  private packages(): Record<string, Package> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'packages.json'), 'utf8'));
    } catch {
      return {};
    }
  }
  private package(node: string): { info: Package; bytes: Buffer } {
    const info = this.packages()[node];
    if (
      !Object.hasOwn(this.config.monitorNodes ?? {}, node) ||
      !info ||
      info.tokenSha256 !== this.config.monitorNodes![node] ||
      !/^[a-f0-9]{64}$/.test(info.sha256) ||
      info.version !== '0.3.6'
    )
      throw new UpdateError(409, '此节点尚未准备经过核验的安装包。');
    const path = join(this.dir, node + '.tar.gz');
    let bytes: Buffer;
    try {
      if (statSync(path).size > 1024 * 1024) throw new Error();
      bytes = readFileSync(path);
      if (digest(bytes) !== info.sha256) throw new Error();
    } catch {
      throw new UpdateError(409, '安装包校验失败，请联系管理员重新准备。');
    }
    return { info, bytes };
  }
  status() {
    return {
      nodes: Object.keys(this.config.monitorNodes ?? {}).map((nodeId) => {
        try {
          return { nodeId, ready: true, version: this.package(nodeId).info.version };
        } catch {
          return { nodeId, ready: false, version: null };
        }
      }),
    };
  }
  private grants(): Record<string, Grant> {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'grants.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new UpdateError(503, '接入记录不可用，请稍后重试。');
    }
  }
  private save(grants: Record<string, Grant>) {
    const temporary = join(this.dir, 'grants.next');
    writeFileSync(temporary, JSON.stringify(grants), { mode: 0o600 });
    renameSync(temporary, join(this.dir, 'grants.json'));
  }
  issue(input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !Object.hasOwn(input, 'nodeId') ||
      typeof (input as { nodeId?: unknown }).nodeId !== 'string' ||
      !nodePattern.test((input as { nodeId: string }).nodeId)
    )
      throw new UpdateError(400, '请选择有效的节点。');
    const nodeId = (input as { nodeId: string }).nodeId;
    const { info } = this.package(nodeId);
    const code = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 600000;
    const grants = this.grants();
    for (const [node, grant] of Object.entries(grants))
      if (grant.expiresAt <= Date.now()) delete grants[node];
    grants[nodeId] = { hash: digest(code), expiresAt, sha256: info.sha256 };
    this.save(grants);
    const installer = readFileSync(new URL('../web/monitor-install.py', import.meta.url));
    const url = this.config.origin + '/cc-updates/admin/monitor-install.py';
    // JSON string literals are Python-compatible here (validated HTTPS origin and ASCII code).
    // POSIX quote the whole program; no shell interpolation of downloaded bytes or secrets.
    const program = `import urllib.request,hashlib,sys,tempfile,pathlib,runpy; b=urllib.request.urlopen(${JSON.stringify(url)},timeout=30).read(131073); hashlib.sha256(b).hexdigest()==${JSON.stringify(digest(installer))} or sys.exit("Installer verification failed"); t=tempfile.TemporaryDirectory(); p=pathlib.Path(t.name)/"monitor-install.py"; p.write_bytes(b); sys.argv=[str(p),"--origin",${JSON.stringify(this.config.origin)},"--code",${JSON.stringify(code)},"--sha256",${JSON.stringify(info.sha256)}]; runpy.run_path(str(p),run_name="__main__")`;
    const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
    return {
      nodeId,
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      command: 'sudo python3 -c ' + quote(program),
    };
  }
  async redeem(code: string): Promise<Buffer> {
    if (Date.now() - this.window >= 60000) {
      this.window = Date.now();
      this.failures = 0;
    }
    const grants = this.grants();
    const hash = digest(code);
    const found =
      /^[A-Za-z0-9_-]{43}$/.test(code) &&
      Object.entries(grants).find(
        ([, g]) =>
          /^[a-f0-9]{64}$/.test(g.hash) &&
          timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(g.hash, 'hex')),
      );
    if (!found || found[1].expiresAt <= Date.now()) {
      if (this.failures >= 30) throw new UpdateError(429, '安装码验证次数过多，请一分钟后重试。');
      this.failures++;
      throw new UpdateError(401, '安装码无效、已使用或已过期，请在管理中心重新生成。');
    }
    const [node, grant] = found;
    const { info, bytes } = this.package(node);
    if (info.sha256 !== grant.sha256) throw new UpdateError(409, '安装包已变更，请重新生成命令。');
    delete grants[node];
    this.save(grants);
    return bytes;
  }
}
