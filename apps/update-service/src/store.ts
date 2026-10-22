import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import {
  verifyIndex,
  type Payload,
  type Release,
} from '../../../packages/managed-updates/src/index.ts';

export class UpdateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function requireState(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new UpdateError(status, message);
}
type Keys = Parameters<typeof verifyIndex>[1];
type CandidateRow = {
  id: string;
  envelope: string;
  payload: string;
  uploaded: number;
  created_at: string;
};
type ChannelRow = {
  channel: string;
  revision: number;
  payload_hash: string;
  envelope: string;
  payload: string;
  activated_at: string;
};
type BuildRow = { build: number; identity: string; ready: number };
type AuditRow = {
  at: string;
  actor: string;
  action: string;
  channel: string;
  build: number | null;
  revision: number;
  source_commit: string | null;
  sha256: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function identity(r: Release): string {
  return JSON.stringify([
    r.build,
    r.appVersion,
    r.protocol,
    r.sourceCommit,
    r.filename,
    r.size,
    r.sha256,
  ]);
}
function existsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

async function syncDirectories(paths: string[]): Promise<void> {
  if (process.platform === 'win32') return; // Actual Linux durability is a deployment acceptance check.
  for (const path of paths) {
    const directory = await open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export class UpdateStore {
  private root: string;
  private keys: Keys;
  private actor: string;
  private db: DatabaseSync;
  private owner: DatabaseSync;
  private busy = false;
  private closed = false;

  private constructor(
    root: string,
    keys: Keys,
    actor: string,
    db: DatabaseSync,
    owner: DatabaseSync,
  ) {
    this.root = root;
    this.keys = keys;
    this.actor = actor;
    this.db = db;
    this.owner = owner;
  }

  static async open(root: string, keys: Keys, actor: string): Promise<UpdateStore> {
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    const privateDir = join(root, 'private');
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await chmod(privateDir, 0o700);
    for (const dir of [join(root, 'public'), join(root, 'public/artifacts')]) {
      await mkdir(dir, { recursive: true, mode: 0o755 });
      await chmod(dir, 0o755);
    }
    const owner = new DatabaseSync(join(privateDir, 'owner.sqlite'));
    let db: DatabaseSync | undefined;
    try {
      // A dedicated, uncommitted exclusive transaction is an OS-released process lock.
      owner.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);');
      db = new DatabaseSync(join(privateDir, 'state.sqlite'));
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, envelope TEXT NOT NULL, payload TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS builds (build INTEGER PRIMARY KEY, identity TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS channels (channel TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload_hash TEXT NOT NULL, envelope TEXT NOT NULL, payload TEXT NOT NULL, activated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, channel TEXT NOT NULL, build INTEGER, revision INTEGER NOT NULL, source_commit TEXT, sha256 TEXT);`);
      for (const file of await readdir(privateDir)) {
        if (file.endsWith('.part')) await rm(join(privateDir, file), { force: true });
        if (file.endsWith('.bin')) {
          const candidate = db
            .prepare('SELECT uploaded FROM candidates WHERE id=?')
            .get(file.slice(0, -4));
          if (!candidate?.uploaded) await rm(join(privateDir, file), { force: true });
        }
      }
      for (const row of db.prepare('SELECT id FROM candidates WHERE uploaded=1').all()) {
        try {
          await lstat(join(privateDir, `${row.id}.bin`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          db.prepare('UPDATE candidates SET uploaded=0 WHERE id=?').run(row.id!);
        }
      }
      await syncDirectories([
        privateDir,
        join(root, 'public/artifacts'),
        join(root, 'public'),
        root,
        dirname(root),
      ]);
      return new UpdateStore(root, keys, actor, db, owner);
    } catch (error) {
      db?.close();
      owner.close();
      throw error;
    }
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    requireState(!this.closed && !this.busy, 409, 'Service busy; retry later.');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private get(id: string): CandidateRow {
    requireState(UUID.test(id), 404, 'Candidate not found.');
    const row = this.db.prepare('SELECT * FROM candidates WHERE id=?').get(id) as
      CandidateRow | undefined;
    requireState(row, 404, 'Candidate not found.');
    return row;
  }

  private verified(row: CandidateRow) {
    try {
      return verifyIndex(row.envelope, this.keys);
    } catch {
      throw new UpdateError(400, 'Invalid or expired signed index.');
    }
  }

  private audit(action: string, p: Payload): void {
    this.db
      .prepare(
        'INSERT INTO audit (at,actor,action,channel,build,revision,source_commit,sha256) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        new Date().toISOString(),
        this.actor,
        action,
        p.channel,
        p.release?.build ?? null,
        p.revision,
        p.release?.sourceCommit ?? null,
        p.release?.sha256 ?? null,
      );
  }

  async createCandidate(envelope: Buffer): Promise<{ id: string }> {
    return this.mutate(async () => {
      let p: Payload;
      try {
        p = verifyIndex(envelope, this.keys).payload;
      } catch {
        throw new UpdateError(400, 'Invalid or expired signed index.');
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM candidates').get()!;
      requireState(
        Number(count.count) < 8,
        409,
        'Candidate limit reached; delete unused candidates.',
      );
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO candidates (id,envelope,payload,created_at) VALUES (?,?,?,?)')
        .run(id, envelope.toString('utf8'), JSON.stringify(p), new Date().toISOString());
      this.audit('candidate-created', p);
      return { id };
    });
  }

  async upload(id: string, input: Readable): Promise<void> {
    return this.mutate(async () => {
      const row = this.get(id);
      const p = this.verified(row).payload;
      requireState(p.release, 400, 'Empty candidate cannot accept an artifact.');
      requireState(!row.uploaded, 409, 'Artifact already uploaded.');
      const path = join(this.root, 'private', `${id}.part`);
      const file = await open(path, 'wx', 0o600);
      let size = 0;
      const hash = createHash('sha256');
      try {
        for await (const chunk of input) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          requireState(size <= p.release.size, 413, 'Artifact exceeds signed size.');
          hash.update(bytes);
          // FileHandle.write may write fewer bytes than requested.
          let offset = 0;
          while (offset < bytes.length) {
            const result = await file.write(bytes, offset);
            requireState(result.bytesWritten > 0, 500, 'Artifact write failed.');
            offset += result.bytesWritten;
          }
        }
        requireState(
          size === p.release.size && hash.digest('hex') === p.release.sha256,
          400,
          'Artifact size or hash mismatch.',
        );
        await file.sync();
        await file.close();
        await link(path, join(this.root, 'private', `${id}.bin`));
        await syncDirectories([join(this.root, 'private')]);
        this.db.prepare('UPDATE candidates SET uploaded=1 WHERE id=?').run(id);
        this.audit('artifact-uploaded', p);
      } finally {
        await file.close();
        await rm(path, { force: true });
      }
    });
  }

  private async checkFile(path: string, r: Release): Promise<void> {
    const info = await lstat(path);
    requireState(
      info.isFile() && !info.isSymbolicLink() && info.size === r.size,
      400,
      'Invalid artifact file.',
    );
    const file = await open(path, 'r');
    try {
      let size = 0;
      const hash = createHash('sha256');
      for await (const bytes of file.createReadStream({ autoClose: false })) {
        size += bytes.length;
        requireState(size <= r.size, 400, 'Invalid artifact size.');
        hash.update(bytes);
      }
      requireState(
        size === r.size && hash.digest('hex') === r.sha256,
        400,
        'Invalid artifact hash.',
      );
    } finally {
      await file.close();
    }
  }

  async activate(id: string): Promise<{ idempotent: boolean }> {
    return this.mutate(async () => {
      const row = this.get(id);
      const index = this.verified(row);
      const p = index.payload;
      const current = this.db.prepare('SELECT * FROM channels WHERE channel=?').get(p.channel) as
        ChannelRow | undefined;
      if (current) {
        requireState(
          p.revision >= current.revision &&
            (p.revision !== current.revision || current.payload_hash === index.payloadHash),
          409,
          'Rejected revision replay or conflict.',
        );
        if (p.revision === current.revision) return { idempotent: true };
      }
      if (p.release) {
        const r = p.release;
        const channelBuild = Number(
          this.db
            .prepare(
              "SELECT COALESCE(MAX(build),0) AS build FROM audit WHERE channel=? AND action='published'",
            )
            .get(p.channel)!.build,
        );
        requireState(
          r.build >= channelBuild,
          409,
          'Channel build cannot decrease, including after withdrawal.',
        );
        const known = this.db.prepare('SELECT * FROM builds WHERE build=?').get(r.build) as
          BuildRow | undefined;
        if (known) requireState(known.identity === identity(r), 409, 'Conflicting build identity.');
        else {
          const highest = Number(
            this.db.prepare('SELECT COALESCE(MAX(build),0) AS build FROM builds').get()!.build,
          );
          requireState(r.build > highest, 409, 'New build must exceed all reserved builds.');
        }
        const file = join(this.root, 'public/artifacts', String(r.build), 'win32-x64', r.filename);
        if (!known?.ready) {
          requireState(row.uploaded, 400, 'Candidate requires an uploaded artifact.');
          const staged = join(this.root, 'private', `${id}.bin`);
          await this.checkFile(staged, r);
          if (!known)
            this.db
              .prepare('INSERT INTO builds (build,identity) VALUES (?,?)')
              .run(r.build, identity(r));
          const dir = join(this.root, 'public/artifacts', String(r.build), 'win32-x64');
          await mkdir(dir, { recursive: true, mode: 0o755 });
          await chmod(join(dir, '..'), 0o755);
          await chmod(dir, 0o755);
          try {
            await link(staged, file);
          } catch (error) {
            if (!existsError(error)) throw error;
          }
          await this.checkFile(file, r);
          await chmod(file, 0o644);
          const artifact = await open(file, 'r+');
          try {
            await artifact.sync();
          } finally {
            await artifact.close();
          }
          await syncDirectories([
            dir,
            dirname(dir),
            join(this.root, 'public/artifacts'),
            join(this.root, 'public'),
            this.root,
          ]);
        } else await this.checkFile(file, r);
      }
      // Expiry may have elapsed while hashing a large file. Never activate stale signatures.
      this.verified(row);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (p.release)
          this.db.prepare('UPDATE builds SET ready=1 WHERE build=?').run(p.release.build);
        this.db
          .prepare(
            'INSERT INTO channels (channel,revision,payload_hash,envelope,payload,activated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(channel) DO UPDATE SET revision=excluded.revision,payload_hash=excluded.payload_hash,envelope=excluded.envelope,payload=excluded.payload,activated_at=excluded.activated_at',
          )
          .run(
            p.channel,
            p.revision,
            index.payloadHash,
            row.envelope,
            row.payload,
            new Date().toISOString(),
          );
        this.audit(p.state === 'empty' ? 'withdrawn' : 'published', p);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return { idempotent: false };
    });
  }

  async removeCandidate(id: string): Promise<void> {
    return this.mutate(async () => {
      const row = this.get(id);
      const p = JSON.parse(row.payload) as Payload;
      await rm(join(this.root, 'private', `${id}.bin`), { force: true });
      this.db.prepare('DELETE FROM candidates WHERE id=?').run(id);
      this.audit('candidate-deleted', p);
    });
  }

  channel(name: string): Buffer | null {
    requireState(name === 'pilot' || name === 'stable', 404, 'Channel not found.');
    const row = this.db.prepare('SELECT envelope FROM channels WHERE channel=?').get(name);
    return row ? Buffer.from(String(row.envelope)) : null;
  }

  status() {
    const channels = (
      this.db.prepare('SELECT * FROM channels ORDER BY channel').all() as ChannelRow[]
    ).map((row) => ({
      channel: row.channel,
      payload: JSON.parse(row.payload) as Payload,
      activatedAt: row.activated_at,
    }));
    const candidates = (
      this.db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all() as CandidateRow[]
    ).map((row) => {
      const payload = JSON.parse(row.payload) as Payload;
      const known = payload.release
        ? (this.db.prepare('SELECT * FROM builds WHERE build=?').get(payload.release.build) as
            BuildRow | undefined)
        : undefined;
      return {
        id: row.id,
        payload,
        uploaded: Boolean(row.uploaded),
        needsArtifact: Boolean(
          payload.release && !(known?.ready && known.identity === identity(payload.release)),
        ),
        createdAt: row.created_at,
      };
    });
    const audit = this.db
      .prepare(
        'SELECT at,actor,action,channel,build,revision,source_commit,sha256 FROM audit ORDER BY id DESC LIMIT 100',
      )
      .all() as AuditRow[];
    return { channels, candidates, audit, busy: this.busy };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    requireState(!this.busy, 409, 'Service busy; retry shutdown.');
    this.closed = true;
    this.db.close();
    this.owner.close();
  }
}
