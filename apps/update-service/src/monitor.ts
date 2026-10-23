import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  validateMonitorReport,
  type MonitorReport,
  type MonitorSnapshot,
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
        report.rateLimits &&
        before.rateLimits &&
        report.rateLimits.measuredAt < before.rateLimits.measuredAt
      )
        throw new Error('Regressive quota snapshot');
    }
    this.db
      .prepare(
        'INSERT INTO snapshots VALUES (?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET observed_at=excluded.observed_at, report=excluded.report, received_at=excluded.received_at',
      )
      .run(report.nodeId, report.observedAt, JSON.stringify(report), new Date().toISOString());
  }
  status(): { nodes: MonitorSnapshot[] } {
    return {
      nodes: this.db
        .prepare('SELECT report, received_at FROM snapshots ORDER BY node_id')
        .all()
        .map((row) => ({
          ...validateMonitorReport(JSON.parse(String(row.report))),
          receivedAt: String(row.received_at),
        })),
    };
  }
  close(): void {
    this.db.close();
  }
}
