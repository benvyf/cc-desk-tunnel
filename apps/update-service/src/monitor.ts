import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  validateMonitorReport,
  type MonitorReport,
  type MonitorSnapshot,
  type MonitorAccountRecord,
} from '../../../packages/protocol/src/account-monitor.ts';

// The update store owns the process lock and creates private/ before this database opens.
export class MonitorStore {
  private db: DatabaseSync;
  private nodes: Set<string>;
  constructor(root: string, nodeIds: string[]) {
    this.nodes = new Set(nodeIds);
    this.db = new DatabaseSync(join(root, 'private', 'monitor.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS snapshots (node_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, report TEXT NOT NULL, received_at TEXT NOT NULL)',
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_snapshots (account_id TEXT NOT NULL, node_id TEXT NOT NULL, observed_at TEXT NOT NULL, report TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(account_id, node_id));
      INSERT OR IGNORE INTO accounts SELECT json_extract(report, '$.account.id'), '', MIN(received_at), MAX(received_at) FROM snapshots WHERE json_type(report, '$.account')='object' GROUP BY json_extract(report, '$.account.id');
      INSERT OR IGNORE INTO account_snapshots SELECT json_extract(report, '$.account.id'), node_id, observed_at, report, received_at FROM snapshots WHERE json_type(report, '$.account')='object';
    `);
    for (const row of this.db.prepare('SELECT node_id FROM snapshots').all())
      if (!this.nodes.has(String(row.node_id)))
        this.db.prepare('DELETE FROM snapshots WHERE node_id=?').run(row.node_id);
  }
  put(report: MonitorReport): void {
    const previous = this.db
      .prepare('SELECT report FROM snapshots WHERE node_id=?')
      .get(report.nodeId);
    if (previous) {
      const before = JSON.parse(String(previous.report)) as MonitorReport;
      if (report.observedAt <= before.observedAt) return;
      if (
        report.account?.id === before.account?.id &&
        report.rateLimits?.available &&
        before.rateLimits?.available &&
        report.rateLimits.measuredAt < before.rateLimits.measuredAt
      )
        throw new Error('Regressive quota snapshot');
    }
    if (report.account) {
      const old = this.db
        .prepare('SELECT report FROM account_snapshots WHERE account_id=? AND node_id=?')
        .get(report.account.id, report.nodeId);
      if (old) {
        const before = JSON.parse(String(old.report)) as MonitorReport;
        if (before.schema === 2 && report.schema === 1)
          report = {
            ...report,
            schema: 2,
            identity: before.identity,
            quotaStatus: report.rateLimits
              ? {
                  state: report.rateLimits.available ? 'ok' : 'unavailable',
                  measuredAt: report.rateLimits.measuredAt,
                }
              : { state: 'unknown', measuredAt: null },
            account: { ...before.account!, ...report.account },
            // Legacy usage has no run provenance, so keep the last richer observation.
            usage: before.usage,
          };
        const sameContext = !['organization', 'apiProvider'].some((key) => {
          const a = before.account?.[key as 'organization' | 'apiProvider'];
          const b = report.account?.[key as 'organization' | 'apiProvider'];
          return a && b && a !== b;
        });
        const oldUsage = report.schema === 2 && !before.usage?.runId ? null : before.usage;
        report = {
          ...report,
          account: {
            ...before.account!,
            ...report.account,
            subscriptionType: report.account!.subscriptionType ?? before.account!.subscriptionType,
            ...(report.schema === 2
              ? {
                  organization:
                    report.account!.organization ?? before.account?.organization ?? null,
                  authMethod: report.account!.authMethod ?? before.account?.authMethod ?? null,
                  apiProvider: report.account!.apiProvider ?? before.account?.apiProvider ?? null,
                }
              : {}),
          },
          rateLimits: !sameContext
            ? report.rateLimits
            : report.rateLimits?.available &&
                (!before.rateLimits?.available ||
                  report.rateLimits.measuredAt >= before.rateLimits.measuredAt)
              ? report.rateLimits
              : (before.rateLimits ?? report.rateLimits),
          usage: !sameContext
            ? report.usage
            : report.usage && (!oldUsage || report.usage.measuredAt >= oldUsage.measuredAt)
              ? report.usage
              : oldUsage,
        };
      }
    }
    report = validateMonitorReport(report);
    const receivedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO snapshots VALUES (?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET observed_at=excluded.observed_at, report=excluded.report, received_at=excluded.received_at',
        )
        .run(report.nodeId, report.observedAt, JSON.stringify(report), receivedAt);
      if (report.account) {
        this.db
          .prepare(
            'INSERT INTO accounts VALUES (?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET last_seen_at=excluded.last_seen_at',
          )
          .run(report.account.id, '', receivedAt, receivedAt);
        this.db
          .prepare(
            'INSERT INTO account_snapshots VALUES (?,?,?,?,?) ON CONFLICT(account_id,node_id) DO UPDATE SET observed_at=excluded.observed_at, report=excluded.report, received_at=excluded.received_at',
          )
          .run(
            report.account.id,
            report.nodeId,
            report.observedAt,
            JSON.stringify(report),
            receivedAt,
          );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  note(id: string, note: string): boolean {
    return (
      this.db.prepare('UPDATE accounts SET note=? WHERE account_id=?').run(note, id).changes > 0
    );
  }
  status(): {
    nodes: MonitorSnapshot[];
    configuredNodes: string[];
    accounts: MonitorAccountRecord[];
  } {
    const decode = (row: Record<string, unknown>): MonitorSnapshot => ({
      ...validateMonitorReport(JSON.parse(String(row.report))),
      receivedAt: String(row.received_at),
    });
    const samples = new Map<string, MonitorSnapshot[]>();
    for (const row of this.db
      .prepare('SELECT account_id, report, received_at FROM account_snapshots ORDER BY node_id')
      .all()) {
      const id = String(row.account_id);
      if (!samples.has(id)) samples.set(id, []);
      samples.get(id)!.push(decode(row));
    }
    return {
      configuredNodes: [...this.nodes].sort(),
      accounts: this.db
        .prepare('SELECT * FROM accounts ORDER BY last_seen_at DESC, account_id')
        .all()
        .map((row) => ({
          id: String(row.account_id),
          note: String(row.note),
          firstSeenAt: String(row.first_seen_at),
          lastSeenAt: String(row.last_seen_at),
          snapshots: samples.get(String(row.account_id)) ?? [],
        })),
      nodes: this.db
        .prepare('SELECT report, received_at FROM snapshots ORDER BY node_id')
        .all()
        .map(decode),
    };
  }
  close(): void {
    this.db.close();
  }
}
