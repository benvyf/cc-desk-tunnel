import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createCipheriv,
} from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UpdateError } from './store.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const ticketLifetime = 120_000;
const leaseLifetime = 60_000;
type Row = Record<string, unknown>;
function email(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new UpdateError(400, '请输入有效邮箱。');
  return value.trim().toLowerCase();
}
function password(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128)
    throw new UpdateError(400, '密码需要 8–128 个字符。');
}
function derive(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(value, salt, 64, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

// Independent desktop users. Neither the administrator credential nor a node's permanent token is issued to clients.
export class DesktopAccess {
  private db: DatabaseSync;
  private key: Buffer;
  private failures = new Map<string, { count: number; until: number }>();
  private validating = false;
  constructor(root: string) {
    const keyPath = join(root, 'private', 'desktop-access.key');
    try {
      this.key = readFileSync(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.key = randomBytes(32);
      writeFileSync(keyPath, this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw new Error('Invalid desktop access encryption key');
    const file = join(root, 'private', 'desktop-access.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,password TEXT NOT NULL,enabled INTEGER NOT NULL,last_login INTEGER);
      CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,fingerprint TEXT NOT NULL,credential TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS grants(user_id TEXT NOT NULL,node_id TEXT NOT NULL,PRIMARY KEY(user_id,node_id));
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,node_id TEXT NOT NULL,expires INTEGER NOT NULL);
    `);
  }
  private revoke(id: string) {
    this.db
      .prepare(
        'DELETE FROM tickets WHERE session_hash IN (SELECT hash FROM sessions WHERE user_id=?)',
      )
      .run(id);
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  private clean(now: number) {
    // Tickets remain tied to their parent session for live-connection lease renewal.
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.exec('DELETE FROM tickets WHERE session_hash NOT IN (SELECT hash FROM sessions)');
    for (const [key, value] of this.failures) if (value.until <= now) this.failures.delete(key);
  }
  status(nodeIds: string[]) {
    const nodes = this.db
      .prepare('SELECT id,name,url,fingerprint,credential FROM nodes')
      .all() as Row[];
    return {
      nodes: nodeIds.map((id) => {
        const node = nodes.find((row) => row.id === id);
        return {
          id,
          name: node?.name ?? id,
          url: node?.url ?? '',
          fingerprint: node?.fingerprint ?? '',
          credentialSaved: !!node?.credential,
        };
      }),
      users: this.db
        .prepare('SELECT id,email,enabled,last_login FROM users ORDER BY email')
        .all()
        .map((row) => ({
          id: String(row.id),
          email: String(row.email),
          enabled: !!row.enabled,
          lastLogin: row.last_login,
          nodes: this.db
            .prepare('SELECT node_id FROM grants WHERE user_id=?')
            .all(String(row.id))
            .map((x) => String(x.node_id)),
        })),
    };
  }
  saveNode(id: string, input: Record<string, unknown>, nodeIds: string[]) {
    if (!nodeIds.includes(id)) throw new UpdateError(404, '设备不存在。');
    const { name, url, fingerprint = '', credential = '' } = input;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 80 ||
      typeof url !== 'string' ||
      typeof fingerprint !== 'string' ||
      typeof credential !== 'string' ||
      credential.length > 4096
    )
      throw new UpdateError(400, '连接配置不正确。');
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new UpdateError(400, '请输入有效服务地址。');
    }
    if (
      target.protocol !== 'wss:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      (fingerprint && !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$|^[a-f0-9]{64}$/i.test(fingerprint))
    )
      throw new UpdateError(400, '需要 wss 服务地址，以及完整 SHA-256 证书指纹（或留空）。');
    let encrypted = String(
      this.db.prepare('SELECT credential FROM nodes WHERE id=?').get(id)?.credential ?? '',
    );
    if (credential) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const data = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final()]);
      encrypted = Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    }
    this.db
      .prepare(
        'INSERT INTO nodes(id,name,url,fingerprint,credential) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,fingerprint=excluded.fingerprint,credential=excluded.credential',
      )
      .run(id, name.trim(), target.href, fingerprint, encrypted);
  }
  async saveUser(id: string | undefined, input: Record<string, unknown>, nodeIds: string[]) {
    const address = email(input.email);
    if (
      typeof input.enabled !== 'boolean' ||
      !Array.isArray(input.nodes) ||
      input.nodes.some((x) => typeof x !== 'string' || !nodeIds.includes(x))
    )
      throw new UpdateError(400, '请选择有效设备和账号状态。');
    const old = id ? this.db.prepare('SELECT * FROM users WHERE id=?').get(id) : undefined;
    if (id && !old) throw new UpdateError(404, '用户不存在。');
    const state = () =>
      JSON.stringify([
        this.db.prepare('SELECT email,salt,password,enabled FROM users WHERE id=?').get(id!),
        this.db.prepare('SELECT node_id FROM grants WHERE user_id=? ORDER BY node_id').all(id!),
      ]);
    const before = id ? state() : null;
    let salt = String(old?.salt ?? ''),
      digest = String(old?.password ?? '');
    if (!old || input.password) {
      password(input.password);
      salt = randomBytes(16).toString('hex');
      digest = (await derive(input.password, salt)).toString('hex');
    }
    // Password derivation yields: a later disable/reset/revocation must not be overwritten.
    if (id && state() !== before) throw new UpdateError(409, '此用户已被修改，请刷新后重试。');
    const userId = id ?? randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO users(id,email,salt,password,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,salt=excluded.salt,password=excluded.password,enabled=excluded.enabled',
        )
        .run(userId, address, salt, digest, input.enabled ? 1 : 0);
      this.db.prepare('DELETE FROM grants WHERE user_id=?').run(userId);
      for (const node of new Set(input.nodes as string[]))
        this.db.prepare('INSERT INTO grants VALUES(?,?)').run(userId, node);
      this.revoke(userId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if ((error as Error).message.includes('UNIQUE')) throw new UpdateError(409, '此邮箱已存在。');
      throw error;
    }
    return userId;
  }
  async login(input: Record<string, unknown>, address: string, now = Date.now()) {
    this.clean(now);
    let identity: string;
    try {
      identity = email(input.email);
    } catch {
      throw new UpdateError(401, '邮箱或密码不正确，或账号已停用。');
    }
    const keys = ['ip:' + address, 'email:' + identity];
    if (keys.some((key) => (this.failures.get(key)?.count ?? 0) >= 10))
      throw new UpdateError(429, '登录尝试过多，请一分钟后重试。');
    if (this.validating) throw new UpdateError(429, '登录验证繁忙，请稍后重试。');
    this.validating = true;
    try {
      const row = this.db.prepare('SELECT * FROM users WHERE email=?').get(identity);
      const value =
        typeof input.password === 'string' && input.password.length <= 128 ? input.password : '';
      const actual = await derive(value, String(row?.salt ?? 'cc-space-unregistered-email'));
      const current = row
        ? this.db.prepare('SELECT salt,password,enabled FROM users WHERE id=?').get(String(row.id))
        : undefined;
      if (
        !row?.enabled ||
        !current?.enabled ||
        current.password !== row.password ||
        current.salt !== row.salt ||
        !timingSafeEqual(actual, Buffer.from(String(row?.password ?? '00'.repeat(64)), 'hex'))
      ) {
        for (const key of keys) {
          const previous = this.failures.get(key);
          this.failures.set(key, {
            count: (previous?.count ?? 0) + 1,
            until: previous?.until ?? now + 60_000,
          });
        }
        throw new UpdateError(401, '邮箱或密码不正确，或账号已停用。');
      }
      const token = secret(),
        expires = now + (input.remember === true ? 30 * 86400_000 : 8 * 3600_000);
      this.db
        .prepare('INSERT INTO sessions VALUES(?,?,?)')
        .run(hash(token), String(row.id), expires);
      this.db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now, String(row.id));
      keys.forEach((key) => this.failures.delete(key));
      return {
        token,
        email: identity,
        expiresAt: expires,
        workspaces: this.workspaces(token, now),
      };
    } finally {
      this.validating = false;
    }
  }
  private session(token: string, now: number) {
    const row = this.db
      .prepare(
        'SELECT sessions.*,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>? AND users.enabled=1',
      )
      .get(hash(token), now);
    if (!row) throw new UpdateError(401, '登录已失效，请重新登录。');
    return row;
  }
  workspaces(token: string, now = Date.now()) {
    const row = this.session(token, now);
    return this.db
      .prepare(
        'SELECT nodes.id,nodes.name FROM nodes JOIN grants ON grants.node_id=nodes.id WHERE grants.user_id=? ORDER BY nodes.name',
      )
      .all(String(row.user_id));
  }
  connect(token: string, nodeId: string, now = Date.now()) {
    const session = this.session(token, now);
    const node = this.db
      .prepare(
        'SELECT nodes.id,nodes.name,nodes.url,nodes.fingerprint FROM nodes JOIN grants ON grants.node_id=nodes.id WHERE grants.user_id=? AND nodes.id=?',
      )
      .get(String(session.user_id), nodeId);
    if (!node) throw new UpdateError(403, '未分配此工作空间。');
    const ticket = 'ccs_' + secret();
    // A new connection replaces the preceding ticket for this desktop login and node.
    this.db
      .prepare('DELETE FROM tickets WHERE session_hash=? AND node_id=?')
      .run(hash(token), nodeId);
    this.db
      .prepare('INSERT INTO tickets VALUES(?,?,?,?)')
      .run(hash(ticket), hash(token), nodeId, now + ticketLifetime);
    return { ...node, token: ticket, expiresAt: now + ticketLifetime };
  }
  validate(ticket: string, nodeId: string, renewal: boolean, now = Date.now()) {
    const row = this.db
      .prepare(
        `SELECT tickets.expires,sessions.user_id,users.email FROM tickets
      JOIN sessions ON sessions.hash=tickets.session_hash JOIN users ON users.id=sessions.user_id
      JOIN grants ON grants.user_id=users.id AND grants.node_id=tickets.node_id
      WHERE tickets.hash=? AND tickets.node_id=? AND sessions.expires>? AND users.enabled=1`,
      )
      .get(hash(ticket), nodeId, now);
    if (!row || (!renewal && Number(row.expires) <= now))
      throw new UpdateError(401, '连接授权已失效。');
    return {
      userId: String(row.user_id),
      email: String(row.email),
      validUntil: now + leaseLifetime,
    };
  }
  logout(token: string) {
    this.db.prepare('DELETE FROM tickets WHERE session_hash=?').run(hash(token));
    this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
  }
  close() {
    this.db.close();
  }
}
