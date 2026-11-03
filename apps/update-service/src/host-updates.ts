import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  SignedServerIndex,
  ServerRelease,
} from '../../../packages/managed-server/src/index.ts';
import { UpdateError } from './store.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Current = { build: number; protocol: number; phase: string };
type Job = {
  id: string;
  build: number;
  sha256: string;
  index: SignedServerIndex;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: string;
  updatedAt: string;
  progress: string;
};
type Row = {
  id: string;
  token: string;
  code: string;
  expires: number;
  seen: number;
  current: string;
  job: string;
};
const active = (job: Job | null) => job && ['queued', 'running'].includes(job.state);
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new UpdateError(400, '无效更新请求。');
}
function current(value: unknown): Current | null {
  if (value === null) return null;
  object(value);
  if (
    Object.keys(value).length !== 3 ||
    !Number.isSafeInteger(value.build) ||
    Number(value.build) < 1 ||
    !Number.isSafeInteger(value.protocol) ||
    Number(value.protocol) < 1 ||
    typeof value.phase !== 'string' ||
    value.phase.length > 32
  )
    throw new UpdateError(400, '无效设备版本。');
  return { build: Number(value.build), protocol: Number(value.protocol), phase: value.phase };
}

// One row per configured node, one outstanding job. Host credentials never enter the CC container or desktop.
export class HostUpdates {
  private db: DatabaseSync;
  private nodes: () => string[];
  constructor(root: string, nodes: () => string[]) {
    this.nodes = nodes;
    const file = join(root, 'private/host-updates.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,token TEXT NOT NULL,code TEXT NOT NULL,expires INTEGER NOT NULL,seen INTEGER NOT NULL,current TEXT NOT NULL,job TEXT NOT NULL);`);
  }
  private node(id: string, now: number) {
    if (!this.nodes().includes(id)) throw new UpdateError(404, '设备不存在。');
    const row = this.db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as Row | undefined;
    const job: Job | null = row?.job ? JSON.parse(row.job) : null;
    if (row && job?.state === 'queued' && now - Date.parse(job.createdAt) > 600000) {
      job.state = 'failed';
      job.progress = '任务等待超时，未执行，请重新确认更新。';
      job.updatedAt = new Date(now).toISOString();
      row.job = JSON.stringify(job);
      this.db.prepare('UPDATE nodes SET job=? WHERE id=?').run(row.job, id);
    }
    return row;
  }
  status(id: string, now = Date.now()) {
    const row = this.node(id, now);
    return {
      nodeId: id,
      enrolled: !!row?.token,
      online: !!row?.token && row.seen > now - 90000,
      lastSeen: row?.seen ? new Date(row.seen).toISOString() : null,
      current: row?.current ? (JSON.parse(row.current) as Current) : null,
      job: row?.job ? (JSON.parse(row.job) as Job) : null,
    };
  }
  issue(id: string, now = Date.now()) {
    const row = this.node(id, now);
    if (row?.job && active(JSON.parse(row.job)))
      throw new UpdateError(409, '设备有未完成的更新，请先检查更新结果。');
    const code = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO nodes VALUES(?,?,?,?,0,'','') ON CONFLICT(id) DO UPDATE SET code=excluded.code,expires=excluded.expires`,
      )
      .run(id, '', hash(code), now + 600000);
    return { code, expiresAt: new Date(now + 600000).toISOString() };
  }
  enroll(input: unknown, now = Date.now()) {
    object(input);
    if (
      Object.keys(input).length !== 2 ||
      typeof input.nodeId !== 'string' ||
      typeof input.code !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.code)
    )
      throw new UpdateError(400, '无效接入请求。');
    const row = this.node(input.nodeId, now);
    if (
      !row?.code ||
      row.expires <= now ||
      !timingSafeEqual(Buffer.from(row.code, 'hex'), Buffer.from(hash(input.code), 'hex'))
    )
      throw new UpdateError(401, '接入命令已失效，请在管理中心重新生成。');
    if (row.job && active(JSON.parse(row.job))) throw new UpdateError(409, '设备仍有未完成更新。');
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare("UPDATE nodes SET token=?,code='',expires=0,seen=0,current='' WHERE id=?")
      .run(hash(token), row.id);
    console.log('Host update channel enrolled', { nodeId: row.id });
    return { token };
  }
  enqueue(
    id: string,
    input: unknown,
    release: ServerRelease,
    index: SignedServerIndex,
    now = Date.now(),
  ) {
    object(input);
    if (
      Object.keys(input).length !== 3 ||
      input.confirmed !== true ||
      input.build !== release.build ||
      input.sha256 !== release.sha256
    )
      throw new UpdateError(409, '更新目标已变化，请刷新后确认具体版本。');
    const row = this.node(id, now);
    if (!row?.token || row.seen <= now - 90000 || !row.current)
      throw new UpdateError(409, '宿主机更新通道未就绪，请先接入并等待设备上报。');
    const previous = row.job ? (JSON.parse(row.job) as Job) : null;
    if (active(previous)) throw new UpdateError(409, '设备正在更新，请等待当前任务完成。');
    const version = JSON.parse(row.current) as Current;
    if (version.build >= release.build)
      throw new UpdateError(409, '设备已是当前或更高版本，无需更新。');
    if (!['idle', 'committed', 'rolled-back'].includes(version.phase))
      throw new UpdateError(409, '设备正在处理更新或需要检查，请先处理当前状态。');
    const job: Job = {
      id: randomUUID(),
      build: release.build,
      sha256: release.sha256,
      index,
      state: 'queued',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      progress: '等待设备接收更新任务',
    };
    this.db.prepare('UPDATE nodes SET job=? WHERE id=?').run(JSON.stringify(job), id);
    console.log('Host update requested', {
      nodeId: id,
      jobId: job.id,
      build: job.build,
      sha256: job.sha256,
    });
    return this.status(id, now);
  }
  poll(token: string, input: unknown, now = Date.now()) {
    object(input);
    if (
      typeof input.nodeId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      Object.keys(input).some((key) => !['nodeId', 'current', 'report'].includes(key)) ||
      !Object.hasOwn(input, 'current')
    )
      throw new UpdateError(400, '无效宿主机上报。');
    const row = this.node(input.nodeId, now);
    if (
      !row?.token ||
      !timingSafeEqual(Buffer.from(row.token, 'hex'), Buffer.from(hash(token), 'hex'))
    )
      throw new UpdateError(401, '更新通道授权已失效。');
    const version = current(input.current);
    const job: Job | null = row.job ? JSON.parse(row.job) : null;
    if (input.report !== undefined) {
      object(input.report);
      const report = input.report;
      if (
        Object.keys(report).length !== 3 ||
        typeof report.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(report.id) ||
        !['running', 'succeeded', 'failed'].includes(String(report.state)) ||
        typeof report.progress !== 'string' ||
        report.progress.length > 4000
      )
        throw new UpdateError(400, '无效更新进度。');
      // A terminal result is immutable; retries acknowledge it without executing another task.
      if (job && report.id === job.id && active(job)) {
        job.state = report.state as Job['state'];
        job.progress = report.progress.replaceAll(token, '[redacted]');
        job.updatedAt = new Date(now).toISOString();
      }
    }
    if (job?.state === 'queued') {
      // Persist dispatch before replying: a delivered task must never expire as unreceived.
      job.state = 'running';
      job.progress = '设备已领取，正在校验更新目标';
      job.updatedAt = new Date(now).toISOString();
    }
    this.db
      .prepare('UPDATE nodes SET seen=?,current=?,job=? WHERE id=?')
      .run(now, version ? JSON.stringify(version) : '', job ? JSON.stringify(job) : '', row.id);
    return {
      job: job && active(job) ? job : null,
      acknowledged: input.report ? input.report.id : null,
    };
  }
  close() {
    this.db.close();
  }
}
