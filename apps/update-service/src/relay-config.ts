import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopAccess } from './desktop-access.ts';
import { UpdateError } from './store.ts';

export function publicIPv4(value: unknown): string {
  if (typeof value !== 'string' || isIP(value) !== 4)
    throw new UpdateError(400, '需要公网 IPv4 地址。');
  const [a, b, c] = value.split('.').map(Number) as [number, number, number, number];
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
    throw new UpdateError(400, '需要公网 IPv4 地址。');
  return value;
}
export type Inventory = {
  host: string;
  port: 22;
  hostKey: string;
  localPin: string;
  reversePort: number;
};
type Target = {
  id: string;
  url: string;
  fingerprint: string;
  inventory: Inventory;
  desiredRevision: number;
};
type Preview = { id: string; host: string; targets: Target[]; expires: number };
type Desired = { revision: number; host: string; port: 22; hostKey: string };
type Report = {
  revision: number;
  state: 'waiting' | 'applying' | 'applied' | 'failed';
  message: string;
};
type Row = {
  id: string;
  inventory: string;
  seen: number;
  desired: string;
  target: string;
  report: string;
  verified: number;
};
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UpdateError(400, '无效中转配置。');
}
function inventory(value: unknown): Inventory {
  record(value);
  if (
    Object.keys(value).sort().join(',') !== 'host,hostKey,localPin,port,reversePort' ||
    value.port !== 22 ||
    typeof value.hostKey !== 'string' ||
    !/^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}=?$/.test(value.hostKey) ||
    typeof value.localPin !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.localPin) ||
    !Number.isInteger(value.reversePort) ||
    Number(value.reversePort) < 1024 ||
    Number(value.reversePort) > 65535
  )
    throw new UpdateError(400, '中转接入信息不正确。');
  return { ...value, host: publicIPv4(value.host) } as Inventory;
}
const parse = <T>(value: string): T | null => (value ? (JSON.parse(value) as T) : null);
const pin = (value: string) => value.replaceAll(':', '').toLowerCase();

// Independent desired state: unlike install jobs it survives offline periods and has no dispatch expiry.
export class RelayConfig {
  private db: DatabaseSync;
  private access: DesktopAccess;
  private nodeIds: () => string[];
  constructor(root: string, access: DesktopAccess, nodeIds: () => string[]) {
    this.access = access;
    this.nodeIds = nodeIds;
    const path = join(root, 'private/relay-config.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,inventory TEXT NOT NULL,seen INTEGER NOT NULL,desired TEXT NOT NULL,target TEXT NOT NULL,report TEXT NOT NULL,verified INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publications(revision INTEGER PRIMARY KEY AUTOINCREMENT,administrator TEXT NOT NULL,created INTEGER NOT NULL,value TEXT NOT NULL);`);
  }
  private row(id: string) {
    if (!this.nodeIds().includes(id)) throw new UpdateError(404, '设备不存在。');
    return this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as Row | undefined;
  }
  poll(id: string, input: unknown, now = Date.now()) {
    this.row(id);
    record(input);
    if (Object.keys(input).sort().join(',') !== 'inventory,report')
      throw new UpdateError(400, '无效中转上报。');
    const local = inventory(input.inventory);
    const old = this.row(id);
    let report: Report | null = null;
    if (input.report !== null) {
      record(input.report);
      const r = input.report;
      if (
        Object.keys(r).sort().join(',') !== 'message,revision,state' ||
        !Number.isSafeInteger(r.revision) ||
        Number(r.revision) < 1 ||
        !['waiting', 'applying', 'applied', 'failed'].includes(String(r.state)) ||
        typeof r.message !== 'string' ||
        r.message.length > 1000
      )
        throw new UpdateError(400, '无效中转进度。');
      report = r as Report;
    }
    const desired = parse<Desired>(old?.desired ?? '');
    const previous = parse<Report>(old?.report ?? '');
    // Late reports cannot overwrite the latest desired state or a confirmed successful result.
    const accepted =
      report && desired?.revision === report.revision && old?.verified !== report.revision
        ? report
        : previous;
    this.db
      .prepare(
        `INSERT INTO nodes VALUES(?,?,?,'','','',0) ON CONFLICT(id) DO UPDATE SET inventory=excluded.inventory,seen=excluded.seen`,
      )
      .run(id, JSON.stringify(local), now);
    if (accepted)
      this.db.prepare('UPDATE nodes SET report=? WHERE id=?').run(JSON.stringify(accepted), id);
    return { desired };
  }
  private snapshot(id: string): Target {
    const row = this.row(id);
    if (!row?.inventory) throw new UpdateError(409, `${id} 尚未接入中转同步。`);
    const local = parse<Inventory>(row.inventory)!;
    const nodes = this.access.status(this.nodeIds()).nodes;
    const node = nodes.find((n) => n.id === id)!;
    if (!node.url || pin(String(node.fingerprint)) !== local.localPin)
      throw new UpdateError(409, `${id} 服务身份与本机上报不一致。`);
    if (nodes.filter((n) => pin(String(n.fingerprint)) === local.localPin).length !== 1)
      throw new UpdateError(409, '节点证书身份必须唯一，请先更换克隆证书。');
    const url = new URL(String(node.url));
    publicIPv4(url.hostname);
    return {
      id,
      url: url.href,
      fingerprint: String(node.fingerprint),
      inventory: local,
      desiredRevision: parse<Desired>(row.desired)?.revision ?? 0,
    };
  }
  preview(host: unknown, ids: unknown, now = Date.now()): Preview {
    const ip = publicIPv4(host);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 64 ||
      ids.some((x) => typeof x !== 'string') ||
      new Set(ids).size !== ids.length
    )
      throw new UpdateError(400, '请选择不重复的中转节点。');
    const targets = (ids as string[]).map((id) => this.snapshot(id));
    const first = targets[0]!.inventory;
    if (
      targets.some(
        (t) =>
          t.inventory.hostKey !== first.hostKey ||
          t.inventory.port !== first.port ||
          t.inventory.host !== first.host,
      )
    )
      throw new UpdateError(409, '所选节点必须属于同一中转，请分批处理。');
    const result = { id: randomUUID(), host: ip, targets, expires: now + 300000 };
    this.db.prepare("DELETE FROM previews WHERE json_extract(value,'$.expires')<=?").run(now);
    this.db.prepare('INSERT INTO previews VALUES(?,?)').run(result.id, JSON.stringify(result));
    return result;
  }
  previewValue(id: string, now = Date.now()): Preview {
    const row = this.db.prepare('SELECT value FROM previews WHERE id=?').get(id);
    const value = parse<Preview>(String(row?.value ?? ''));
    if (!value || value.expires <= now) throw new UpdateError(409, '预检已过期，请重新检查。');
    for (const target of value.targets)
      if (JSON.stringify(this.snapshot(target.id)) !== JSON.stringify(target))
        throw new UpdateError(409, '节点配置已变化，请重新预检。');
    return value;
  }
  publish(id: string, administrator: string, now = Date.now()) {
    const preview = this.previewValue(id, now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = Number(
        this.db
          .prepare('INSERT INTO publications(administrator,created,value) VALUES(?,?,?)')
          .run(administrator, now, JSON.stringify(preview)).lastInsertRowid,
      );
      for (const target of preview.targets) {
        const desired: Desired = {
          revision,
          host: preview.host,
          port: 22,
          hostKey: target.inventory.hostKey,
        };
        this.db
          .prepare("UPDATE nodes SET desired=?,target=?,report='',verified=0 WHERE id=?")
          .run(JSON.stringify(desired), JSON.stringify(target), target.id);
      }
      this.db.prepare('DELETE FROM previews WHERE id=?').run(id);
      this.db.exec('COMMIT');
      return { revision, host: preview.host };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  verification(id: string, revision: number) {
    const row = this.row(id),
      desired = parse<Desired>(row?.desired ?? ''),
      report = parse<Report>(row?.report ?? '');
    if (
      !desired ||
      desired.revision !== revision ||
      !report ||
      report.revision !== revision ||
      report.state !== 'applied' ||
      row?.verified === revision
    )
      throw new UpdateError(409, '设备尚未完成此版本的本地切换或已验收。');
    const target = parse<Target>(row!.target)!;
    if (this.snapshot(id).inventory.localPin !== pin(target.fingerprint))
      throw new UpdateError(409, '节点身份已变化。');
    const url = new URL(target.url);
    url.hostname = desired.host;
    return { target, url: url.href, revision };
  }
  verified(id: string, revision: number) {
    const proof = this.verification(id, revision);
    this.access.replaceRelayHost(id, proof.target.url, proof.target.fingerprint, proof.url);
    this.db
      .prepare("UPDATE nodes SET verified=? WHERE id=? AND json_extract(desired,'$.revision')=?")
      .run(revision, id, revision);
  }
  verificationFailed(id: string, revision: number) {
    const row = this.row(id),
      report = parse<Report>(row?.report ?? '');
    if (report?.revision === revision && report.state === 'applied' && row?.verified !== revision) {
      report.message = '公网验收尚未通过，将继续重试；请检查新 VPS 上的转发端口和节点证书。';
      this.db.prepare('UPDATE nodes SET report=? WHERE id=?').run(JSON.stringify(report), id);
    }
  }
  status() {
    return {
      nodes: this.nodeIds().map((id) => {
        const row = this.row(id),
          desired = parse<Desired>(row?.desired ?? ''),
          report = parse<Report>(row?.report ?? '');
        return {
          id,
          inventory: parse<Inventory>(row?.inventory ?? ''),
          lastSeen: row?.seen ?? null,
          desired,
          state:
            desired && row?.verified === desired.revision
              ? 'succeeded'
              : (report?.state ?? (desired ? 'queued' : 'unconfigured')),
          message: report?.message ?? '',
        };
      }),
      history: this.db
        .prepare(
          'SELECT revision,administrator,created,value FROM publications ORDER BY revision DESC LIMIT 20',
        )
        .all()
        .map((row) => ({
          revision: row.revision,
          administrator: row.administrator,
          created: row.created,
          host: parse<Preview>(String(row.value))!.host,
        })),
    };
  }
  close() {
    this.db.close();
  }
}
