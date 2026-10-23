import { createHash, randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultThresholds, evaluateJev, JevError, rulesVersion, type JevUsage } from './jev.ts';
import { UpdateError } from './store.ts';

const modes = ['keyword_triggered_jev', 'keyword_and_api', 'api_only', 'keyword_only'] as const;
type Policy = {
  revision: number;
  mode: (typeof modes)[number];
  keywords: string[];
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  retentionDays: number;
  thresholds: Record<string, number>;
};
export type ModerationDecision = {
  allowed: boolean;
  action: 'allow' | 'keyword_block' | 'jev_block' | 'error';
  matchedKeyword?: string;
  categories?: string[];
  scores?: Record<string, number>;
  model?: string;
  error?: string;
  rulesVersion: string;
  jevAttempted?: boolean;
  usage?: JevUsage;
};

export async function checkText(
  policy: Policy,
  text: string,
  fetcher: typeof fetch = fetch,
): Promise<ModerationDecision> {
  const normalized = text.toLowerCase();
  const keyword =
    policy.mode === 'api_only'
      ? undefined
      : policy.keywords.find((word) => normalized.includes(word.toLowerCase()));
  const base = { rulesVersion, ...(keyword ? { matchedKeyword: keyword } : {}) };
  if (keyword && (policy.mode === 'keyword_and_api' || policy.mode === 'keyword_only'))
    return { ...base, allowed: false, action: 'keyword_block' };
  if (policy.mode === 'keyword_only' || (policy.mode === 'keyword_triggered_jev' && !keyword))
    return { ...base, allowed: true, action: 'allow' };
  try {
    const result = await evaluateJev(policy, text, fetcher);
    const categories = Object.keys(result.scores).filter(
      (category) => result.scores[category]! >= policy.thresholds[category]!,
    );
    return {
      ...base,
      ...result,
      jevAttempted: true,
      categories,
      allowed: !categories.length,
      action: categories.length ? 'jev_block' : 'allow',
    };
  } catch (error) {
    return {
      ...base,
      allowed: false,
      action: 'error',
      error: error instanceof JevError ? error.message : 'jev_unavailable',
      jevAttempted: error instanceof JevError ? error.attempted : true,
      ...(error instanceof JevError && error.usage ? { usage: error.usage } : {}),
    };
  }
}

function invalid(): never {
  throw new UpdateError(400, 'Invalid moderation configuration.');
}
function validate(value: unknown, current: Policy): Policy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  const fields = Object.keys(current);
  if (Object.keys(v).length !== fields.length || !fields.every((key) => Object.hasOwn(v, key)))
    return invalid();
  if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0) return invalid();
  if (!modes.includes(v.mode as Policy['mode'])) return invalid();
  if (
    !Array.isArray(v.keywords) ||
    v.keywords.length > 500 ||
    !v.keywords.every((word) => typeof word === 'string' && word.trim() && word.length <= 120)
  )
    return invalid();
  if (typeof v.baseUrl !== 'string') return invalid();
  let url: URL;
  try {
    url = new URL(v.baseUrl);
  } catch {
    return invalid();
  }
  if (url.protocol !== 'https:' || url.origin !== v.baseUrl || url.username || url.password)
    return invalid();
  if (typeof v.model !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(v.model)) return invalid();
  // null keeps the existing secret; empty string explicitly removes it.
  if (v.apiKey !== null && (typeof v.apiKey !== 'string' || !/^[\x21-\x7e]{0,512}$/.test(v.apiKey)))
    return invalid();
  if (!Number.isInteger(v.timeoutMs) || Number(v.timeoutMs) < 1000 || Number(v.timeoutMs) > 30000)
    return invalid();
  if (
    !Number.isInteger(v.retentionDays) ||
    Number(v.retentionDays) < 1 ||
    Number(v.retentionDays) > 90
  )
    return invalid();
  if (!v.thresholds || typeof v.thresholds !== 'object' || Array.isArray(v.thresholds))
    return invalid();
  const thresholds = v.thresholds as Record<string, unknown>;
  const names = Object.keys(defaultThresholds);
  if (
    Object.keys(thresholds).length !== names.length ||
    !names.every(
      (name) =>
        typeof thresholds[name] === 'number' &&
        Number.isFinite(thresholds[name]) &&
        Number(thresholds[name]) >= 0 &&
        Number(thresholds[name]) <= 1,
    )
  )
    return invalid();
  return {
    ...(v as Policy),
    keywords: [...new Set(v.keywords.map((word) => word.trim()))],
    apiKey: v.apiKey === null ? current.apiKey : (v.apiKey as string),
  };
}

// Open only after UpdateStore holds the data-directory owner lock.
export class ModerationStore {
  private db: DatabaseSync;
  private active = 0;
  private constructor(db: DatabaseSync) {
    this.db = db;
  }
  static async open(root: string) {
    const path = join(root, 'private/moderation.sqlite');
    const db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, detail TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_at ON events(at);
        CREATE TABLE IF NOT EXISTS usage_totals (id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL,
          requests INTEGER NOT NULL, errors INTEGER NOT NULL, reported INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);`);
      db.prepare('INSERT OR IGNORE INTO usage_totals VALUES (1,?,0,0,0,0,0)').run(
        new Date().toISOString(),
      );
      db.prepare('INSERT OR IGNORE INTO policy (id,value) VALUES (1,?)').run(
        JSON.stringify({
          revision: 0,
          mode: 'keyword_and_api',
          keywords: [],
          baseUrl: 'https://api.typesafe.ai',
          model: 'jev-latest',
          apiKey: '',
          timeoutMs: 5000,
          retentionDays: 7,
          thresholds: defaultThresholds,
        }),
      );
      const store = new ModerationStore(db);
      const policy = store.policy();
      const added = Object.keys(defaultThresholds).filter(
        (name) => !Object.hasOwn(policy.thresholds, name),
      );
      if (added.length) {
        policy.thresholds = { ...defaultThresholds, ...policy.thresholds };
        policy.revision++;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE policy SET value=? WHERE id=1').run(JSON.stringify(policy));
          store.record('system', 'config.migrated', policy.revision, {
            rulesVersion,
            addedCategories: added,
          });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      store.prune();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  private policy(): Policy {
    return JSON.parse(
      this.db.prepare('SELECT value FROM policy WHERE id=1').get()!.value as string,
    );
  }
  config() {
    const { apiKey, ...policy } = this.policy();
    return {
      ...policy,
      apiKeyConfigured: Boolean(apiKey),
      enforcement: 'node-api-ready' as const,
      rulesVersion,
    };
  }
  private prune() {
    this.db
      .prepare('DELETE FROM events WHERE at < ?')
      .run(Date.now() - this.policy().retentionDays * 86400000);
  }
  private record(actor: string, kind: string, revision: number, detail: unknown) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO events VALUES (?,?,?,?,?,?)')
      .run(id, Date.now(), actor, kind, revision, JSON.stringify(detail));
    return id;
  }
  save(value: unknown, actor: string) {
    const current = this.policy();
    const policy = validate(value, current);
    if (policy.revision !== current.revision)
      throw new UpdateError(409, 'Moderation configuration changed; refresh before saving.');
    policy.revision++;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE policy SET value=? WHERE id=1').run(JSON.stringify(policy));
      this.record(actor, 'config.updated', policy.revision, {
        mode: policy.mode,
        keyChanged: value && (value as Record<string, unknown>).apiKey !== null,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.prune();
    return this.config();
  }
  events() {
    this.prune();
    return this.db
      .prepare('SELECT * FROM events ORDER BY at DESC, rowid DESC LIMIT 100')
      .all()
      .map((row) => ({
        id: row.id,
        at: new Date(Number(row.at)).toISOString(),
        actor: row.actor,
        kind: row.kind,
        revision: row.revision,
        detail: JSON.parse(row.detail as string),
      }));
  }
  usage() {
    const row = this.db.prepare('SELECT * FROM usage_totals WHERE id=1').get()!;
    return {
      startedAt: row.started_at as string,
      requests: Number(row.requests),
      errorRequests: Number(row.errors),
      reportedRequests: Number(row.reported),
      unreportedRequests: Number(row.requests) - Number(row.reported),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.input_tokens) + Number(row.output_tokens),
      remainingTokens: null,
      remainingBalance: null,
      providerConsoleUrl: 'https://console.typesafe.ai/',
    };
  }
  async preview(text: unknown, actor: string, fetcher: typeof fetch = fetch) {
    return this.review(text, actor, 'admin.preview', {}, fetcher);
  }
  async review(
    text: unknown,
    actor: string,
    kind: 'admin.preview' | 'node.review',
    context: Record<string, string>,
    fetcher: typeof fetch = fetch,
  ) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 65536)
      throw new UpdateError(400, 'Expected non-empty text up to 64 KiB.');
    if (this.active >= 2) throw new UpdateError(429, 'Moderation preview busy; retry later.');
    this.active++;
    const policy = this.policy();
    const start = Date.now();
    try {
      const result = await checkText(policy, text, fetcher);
      let id: string;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (result.jevAttempted)
          this.db
            .prepare(
              `UPDATE usage_totals SET requests=requests+1, errors=errors+?,
            reported=reported+?, input_tokens=input_tokens+?, output_tokens=output_tokens+? WHERE id=1`,
            )
            .run(
              Number(result.action === 'error'),
              Number(Boolean(result.usage)),
              result.usage?.inputTokens ?? 0,
              result.usage?.outputTokens ?? 0,
            );
        id = this.record(actor, kind, policy.revision, {
          ...context,
          ...result,
          latencyMs: Date.now() - start,
          textBytes: Buffer.byteLength(text),
          textSha256: createHash('sha256').update(text).digest('hex'),
        });
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      this.prune();
      return { id, revision: policy.revision, ...result };
    } finally {
      this.active--;
    }
  }
}
