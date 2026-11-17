// Each device has one durable, explicitly confirmed workflow. No remote-command surface.
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { HostUpdates, supportsLegacyBridge } from './host-updates.ts';
import { AgentPackages, type SignedAgentIndex } from './agent-packages.ts';
import { UpdateError } from './store.ts';
import type {
  ServerRelease,
  SignedServerIndex,
} from '../../../packages/managed-server/src/index.ts';

type Obj = Record<string, any>;
type AppPublication = { release: ServerRelease; index: SignedServerIndex } | null;
type Target = {
  agent: { version: number; sha256: string };
  app: { build: number; sha256: string } | null;
};
type Workflow = {
  id: string;
  nodeId: string;
  target: Target;
  job: Obj;
  state: string;
  stage: string;
  createdAt: string;
  updatedAt: string;
  steps: Obj[];
  retryOf: string | null;
  legacy: boolean;
  appJobId: string | null;
  bridgeId: string | null;
  adoptionPhase: string | null;
  handoff: boolean;
  pendingInstance: string | null;
  pendingSeq: number;
  lastReportSeq: number;
  startedAt: string | null;
  continuationUntil: string | null;
  appResult: Obj | null;
  maintenanceRequired: boolean;
  repairProof: Obj | null;
  componentOnlyBridge: boolean;
  application: AppPublication;
};
const stages = ['agent', 'preflight', 'dependencies', 'prepare', 'maintenance', 'apply', 'verify'];
const states = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'maintenance-required'];
const terminal = (w: Workflow) => ['succeeded', 'failed', 'maintenance-required'].includes(w.state);
function fail(status = 400, message = 'Invalid host workflow request.'): never {
  throw new UpdateError(status, message);
}
function obj(v: unknown, required: string[], optional: string[] = []): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  const o = v as Obj;
  if (
    required.some((k) => !Object.hasOwn(o, k)) ||
    Object.keys(o).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail();
  return o;
}
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const positive = (v: unknown) => integer(v) && Number(v) > 0;
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const date = (v: unknown) => text(v, 40) && Number.isFinite(Date.parse(String(v)));
function bools(o: Obj, keys: string[]) {
  if (keys.some((k) => typeof o[k] !== 'boolean')) fail();
}
function inventory(value: unknown) {
  if (value === null) return;
  const v = obj(value, [
    'schema',
    'observedAt',
    'os',
    'docker',
    'storage',
    'kernel',
    'app',
    'recovery',
  ]);
  if (v.schema !== 1 || !date(v.observedAt)) fail();
  const os = obj(v.os, ['id', 'version', 'arch']);
  if (!text(os.id, 64) || !text(os.version, 64) || !text(os.arch, 32)) fail();
  const d = obj(v.docker, ['available', 'version', 'buildkitVersion', 'storageDriver', 'root']);
  bools(d, ['available']);
  for (const [k, max] of [
    ['version', 120],
    ['buildkitVersion', 160],
    ['storageDriver', 120],
    ['root', 256],
  ] as const)
    if (d[k] !== null && !text(d[k], max)) fail();
  const s = obj(v.storage, ['rootRw', 'freeBytes', 'freeInodes', 'sameFilesystem']);
  bools(s, ['rootRw', 'sameFilesystem']);
  if (!integer(s.freeBytes) || !integer(s.freeInodes)) fail();
  const k = obj(v.kernel, ['status']);
  if (!['clear', 'errors', 'unavailable'].includes(k.status)) fail();
  const a = obj(v.app, ['managementAvailable', 'descriptorSha256', 'phase', 'build', 'protocol']);
  bools(a, ['managementAvailable']);
  if (
    (a.descriptorSha256 !== null && !digest(a.descriptorSha256)) ||
    (a.phase !== null && !text(a.phase, 64)) ||
    (a.build !== null && !positive(a.build)) ||
    (a.protocol !== null && !positive(a.protocol))
  )
    fail();
  const r = obj(v.recovery, ['eligible', 'unfinishedCount']);
  bools(r, ['eligible']);
  if (!integer(r.unfinishedCount) || r.unfinishedCount > 10000) fail();
}
function app(value: unknown) {
  if (value === null) return null;
  const a = obj(
    value,
    ['current', 'phase', 'check', 'hostMaintenance', 'retryable'],
    ['serving', 'descriptorSha256', 'hostDiagnostics'],
  );
  const c = obj(a.current, ['build', 'protocol', 'appVersion', 'sha256']);
  if (
    !positive(c.build) ||
    !positive(c.protocol) ||
    !text(c.appVersion, 80) ||
    (c.sha256 !== null && !digest(c.sha256)) ||
    !text(a.phase, 64) ||
    a.check !== null
  )
    fail();
  bools(a, ['hostMaintenance', 'retryable']);
  if (
    (a.serving !== undefined && typeof a.serving !== 'boolean') ||
    (a.descriptorSha256 !== undefined && !digest(a.descriptorSha256))
  )
    fail();
  if (a.hostDiagnostics !== undefined) {
    const d = obj(a.hostDiagnostics, [
      'schema',
      'idle',
      'serving',
      'ready',
      'base',
      'program',
      'activity',
    ]);
    if (d.schema !== 1) fail();
    bools(d, ['idle', 'serving', 'ready']);
    const b = obj(d.base, ['build', 'descriptorSha256']),
      p = obj(d.program, ['build', 'protocol', 'sha256', 'descriptorSha256']);
    if (
      !positive(b.build) ||
      !digest(b.descriptorSha256) ||
      !positive(p.build) ||
      !positive(p.protocol) ||
      (p.sha256 !== null && !digest(p.sha256)) ||
      !digest(p.descriptorSha256)
    )
      fail();
    const activity = obj(d.activity, [
      'tasks',
      'terminals',
      'reviews',
      'pending',
      'registering',
      'connections',
    ]);
    if (Object.values(activity).some((v) => !integer(v) || Number(v) > 1000000)) fail();
  }
  return a;
}
function report(value: unknown) {
  if (value === null) return null;
  const r = obj(value, ['id', 'seq', 'stage', 'state', 'message', 'log']);
  if (
    !uuid(r.id) ||
    !positive(r.seq) ||
    !stages.includes(r.stage) ||
    !states.includes(r.state) ||
    !text(r.message, 1000) ||
    !text(r.log, 6000)
  )
    fail();
  return r;
}
function target(value: unknown): Target {
  const t = obj(value, ['agent', 'app']),
    a = obj(t.agent, ['version', 'sha256']);
  if (!positive(a.version) || !digest(a.sha256)) fail();
  if (t.app !== null) {
    const p = obj(t.app, ['build', 'sha256']);
    if (!positive(p.build) || !digest(p.sha256)) fail();
  }
  return t as Target;
}
const same = isDeepStrictEqual;
function applicationReady(w: Workflow, probe: Obj | null) {
  if (!probe || !w.target.app || probe.current.build !== w.target.app.build) return false;
  const release = JSON.parse(Buffer.from(w.job.index.payload, 'base64url').toString())
    .release as ServerRelease;
  if (
    release.build !== w.target.app.build ||
    release.sha256 !== w.target.app.sha256 ||
    probe.current.protocol !== release.protocol
  )
    return false;
  const d = probe.hostDiagnostics;
  if (probe.current.sha256 === w.target.app.sha256)
    return probe.serving === true || (d?.ready === true && d?.serving === true);
  return (
    probe.current.sha256 === null &&
    digest(release.descriptorSha256) &&
    probe.descriptorSha256 === release.descriptorSha256 &&
    d?.schema === 1 &&
    d.ready === true &&
    d.serving === true &&
    d.program.build === release.build &&
    d.program.protocol === release.protocol &&
    d.program.descriptorSha256 === release.descriptorSha256
  );
}

export class HostWorkflows {
  private db: DatabaseSync;
  private retentionNext = 0;
  private hosts: HostUpdates;
  private packages: AgentPackages;
  private publication: () => AppPublication;
  constructor(
    root: string,
    hosts: HostUpdates,
    packages: AgentPackages,
    publication: () => AppPublication,
  ) {
    this.hosts = hosts;
    this.packages = packages;
    this.publication = publication;
    const path = join(root, 'private/host-workflows.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS observations(node TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,node TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS latest(node TEXT PRIMARY KEY,id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflows_updated ON workflows(json_extract(value,'$.updatedAt'));
      CREATE INDEX IF NOT EXISTS workflows_retry ON workflows(json_extract(value,'$.retryOf'));
      CREATE INDEX IF NOT EXISTS workflows_bridge ON workflows(json_extract(value,'$.bridgeId'));
      CREATE INDEX IF NOT EXISTS workflows_app_job ON workflows(json_extract(value,'$.appJobId'));
      CREATE INDEX IF NOT EXISTS latest_workflow ON latest(id);`);
    hosts.reserveWith((id) => this.reservation(id));
  }
  // One bounded atomic SQL delete, after heartbeat commit; full workflow logs never
  // enter JS. References keep ancestors even when their descendants are also old.
  private retainHistory(now: number) {
    if (now < this.retentionNext) return;
    this.retentionNext = now + 3600000;
    this.db
      .prepare(
        `DELETE FROM workflows WHERE id IN (
      SELECT w.id FROM workflows w
      WHERE json_extract(w.value,'$.state') IN ('succeeded','failed')
        AND json_extract(w.value,'$.maintenanceRequired') = 0
        AND (json_extract(w.value,'$.legacy') = 0 OR json_extract(w.value,'$.adoptionPhase') = 'adopted')
        AND json_extract(w.value,'$.updatedAt') < ?
        AND NOT EXISTS (SELECT 1 FROM latest l WHERE l.id=w.id)
        AND NOT EXISTS (SELECT 1 FROM workflows r WHERE r.id<>w.id AND (
          json_extract(r.value,'$.retryOf')=w.id OR
          json_extract(r.value,'$.bridgeId')=w.id OR
          json_extract(r.value,'$.appJobId')=w.id))
      ORDER BY w.rowid LIMIT 50
    )`,
      )
      .run(new Date(now - 30 * 86400000).toISOString());
  }
  private observation(id: string, readOnly = false): Obj | null {
    const row = this.db.prepare('SELECT value FROM observations WHERE node=?').get(id) as
      { value: string } | undefined;
    const observation = row ? JSON.parse(row.value) : null;
    return observation?.credentialVersion === this.hosts.credentialVersion(id, readOnly)
      ? observation
      : null;
  }
  private saveObservation(id: string, o: Obj) {
    this.db
      .prepare(
        'INSERT INTO observations VALUES(?,?) ON CONFLICT(node) DO UPDATE SET value=excluded.value',
      )
      .run(id, JSON.stringify(o));
  }
  private load(id: string): Workflow | null {
    const row = this.db.prepare('SELECT value FROM workflows WHERE id=?').get(id) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  private latest(id: string) {
    const row = this.db.prepare('SELECT id FROM latest WHERE node=?').get(id) as
      { id: string } | undefined;
    return row ? this.load(row.id) : null;
  }
  private save(w: Workflow) {
    this.db
      .prepare(
        'INSERT INTO workflows VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(w.id, w.nodeId, JSON.stringify(w));
  }
  private appPublication() {
    try {
      return this.publication();
    } catch {
      return null;
    }
  }
  private reservation(id: string) {
    const w = this.latest(id);
    return w && (!terminal(w) || (w.legacy && w.adoptionPhase !== 'adopted'))
      ? (w.appJobId ?? w.id)
      : null;
  }
  private reconcile(w: Workflow, now: number) {
    if (w.legacy && !w.appResult) {
      const j = this.hosts.status(w.nodeId, now).job;
      if (j?.id === w.appJobId && ['succeeded', 'failed'].includes(j.state)) {
        w.appResult = {
          id: j.id,
          build: j.build,
          sha256: j.sha256,
          state: j.state,
          updatedAt: j.updatedAt,
          progress: j.progress,
        };
        this.save(w);
      }
    }
    if (terminal(w)) return;
    if (w.legacy) {
      const host = this.hosts.status(w.nodeId, now);
      const j = host.job;
      if (j?.id === w.appJobId && j.state === 'failed' && !w.componentOnlyBridge) {
        w.state = 'failed';
        w.stage = 'apply';
        w.updatedAt = j.updatedAt;
        w.steps.push({
          stage: 'apply',
          state: 'failed',
          message: j.progress,
          log: '',
          at: j.updatedAt,
        });
        this.save(w);
      } else if (
        w.adoptionPhase !== 'activating' &&
        ((!w.startedAt && Date.parse(w.job.expiresAt) <= now) ||
          (w.continuationUntil && Date.parse(w.continuationUntil) <= now))
      ) {
        w.state = 'failed';
        w.updatedAt = new Date(now).toISOString();
        w.steps.push({
          stage: 'agent',
          state: 'failed',
          message: 'Bridge authorization expired; explicit retry is required.',
          log: '',
          at: w.updatedAt,
        });
        this.save(w);
      } else if (!j || j.id !== w.appJobId) {
        if (host.online) {
          try {
            this.ensureLegacyJob(w, now);
          } catch (error) {
            if (!(error instanceof UpdateError) || error.status !== 409) throw error;
            w.state = 'failed';
            w.updatedAt = new Date(now).toISOString();
            w.steps.push({
              stage: 'prepare',
              state: 'failed',
              message:
                'The bound bridge could not be queued; refresh and explicitly confirm the signed target again.',
              log: '',
              at: w.updatedAt,
            });
            this.save(w);
          }
        }
      }
    } else if (w.state === 'queued' && Date.parse(w.job.expiresAt) <= now) {
      w.state = 'failed';
      w.updatedAt = new Date(now).toISOString();
      w.steps.push({
        stage: 'agent',
        state: 'failed',
        message: 'Confirmation expired before dispatch.',
        log: '',
        at: w.updatedAt,
      });
      this.save(w);
    }
  }
  status(id: string, now = Date.now()) {
    const host = this.hosts.status(id, now),
      o = this.observation(id),
      w = this.latest(id);
    if (w) this.reconcile(w, now);
    const p = this.packages.status(),
      a = this.appPublication();
    const fresh = (at: unknown) => date(at) && Math.abs(now - Date.parse(String(at))) <= 60000;
    const v = o?.capabilities.inventory;
    const healthyInventory =
      !!v &&
      o!.seen > now - 60000 &&
      fresh(v.observedAt) &&
      v.storage.rootRw &&
      v.kernel.status === 'clear' &&
      v.recovery.eligible &&
      v.recovery.unfinishedCount === 0 &&
      v.app.managementAvailable === true &&
      !!o?.app &&
      (o.app.serving === true ||
        (o.app.hostDiagnostics?.serving === true && o.app.hostDiagnostics?.ready === true)) &&
      (['idle', 'committed', 'rolled-back'].includes(o.app.phase) ||
        (o.app.retryable === true && o.app.serving === true));
    const proof = w?.repairProof;
    const repaired =
      healthyInventory ||
      (!!proof &&
        proof.receivedAt > now - 60000 &&
        fresh(proof.observedAt) &&
        proof.rootRw &&
        proof.kernelStatus === 'clear' &&
        proof.recovery === 'settled' &&
        proof.appReady);
    const retry =
      !!w &&
      ['failed', 'maintenance-required'].includes(w.state) &&
      (!(w.maintenanceRequired || w.state === 'maintenance-required') || repaired) &&
      (o ? o.seen > now - 90000 : host.online) &&
      (!o?.capabilities.inventory ||
        (o.capabilities.inventory.storage.rootRw &&
          o.capabilities.inventory.kernel.status === 'clear' &&
          o.capabilities.inventory.recovery.eligible)) &&
      (!o ||
        !o.app ||
        ['idle', 'committed', 'rolled-back'].includes(o.app.phase) ||
        (o.app.retryable && o.app.serving));
    return {
      nodeId: id,
      enrolled: host.enrolled,
      online: o ? o.seen > now - 90000 : host.online,
      lastSeen: o ? new Date(o.seen).toISOString() : host.lastSeen,
      registration: o
        ? o.registrationCommitted
          ? 'ready'
          : 'initializing'
        : host.online
          ? 'legacy'
          : host.enrolled
            ? 'initializing'
            : 'unenrolled',
      instanceId: o?.instanceId ?? null,
      agent: o?.agent ?? null,
      app: o?.app ?? host.current,
      capabilities: o?.capabilities ?? null,
      target: {
        agent:
          p && !p.expired ? { version: p.payload.version, sha256: p.payload.archive.sha256 } : null,
        app: a ? { build: a.release.build, sha256: a.release.sha256 } : null,
      },
      workflow: w,
      history: (
        this.db
          .prepare(
            'SELECT value FROM workflows WHERE node=? AND id<>? ORDER BY rowid DESC LIMIT 20',
          )
          .all(id, w?.id ?? '') as { value: string }[]
      ).map((row) => {
        const h = JSON.parse(row.value) as Workflow;
        return {
          id: h.id,
          target: h.target,
          state: h.state,
          stage: h.stage,
          createdAt: h.createdAt,
          updatedAt: h.updatedAt,
          retryOf: h.retryOf,
          appResult: h.appResult,
        };
      }),
      retry,
      adoption: w?.legacy
        ? { bridgeId: w.bridgeId, appJobId: w.appJobId, phase: w.adoptionPhase, attemptId: w.id }
        : null,
    };
  }
  confirm(id: string, input: unknown, now = Date.now()) {
    const i = obj(input, ['confirmed', 'agent', 'app'], ['retryOf']);
    if (i.confirmed !== true || (i.retryOf !== undefined && !uuid(i.retryOf))) fail();
    const wanted = target({ agent: i.agent, app: i.app }),
      readonlyHost = this.hosts.status(id, now, { readOnly: true }),
      o = this.observation(id, true),
      previous = this.latest(id);
    // Reject an ineligible bridge before status expiry or workflow reconciliation
    // can alter the historical diagnosis, job or reservation.
    const legacy = !o || (previous?.legacy && previous.adoptionPhase !== 'adopted');
    if (legacy && !wanted.app)
      fail(409, 'Legacy adoption requires an exact signed application bridge target.');
    const componentRetry = !!(
      legacy &&
      previous?.legacy &&
      same(previous.target.app, wanted.app) &&
      previous.appJobId &&
      readonlyHost.job?.id === previous.appJobId &&
      (readonlyHost.job.state === 'succeeded' ||
        (previous.repairProof?.targetReady === true &&
          previous.repairProof.rootRw &&
          previous.repairProof.kernelStatus === 'clear' &&
          previous.repairProof.recovery === 'settled' &&
          previous.repairProof.appReady &&
          previous.repairProof.receivedAt > now - 60000 &&
          Math.abs(now - Date.parse(previous.repairProof.observedAt)) <= 60000))
    );
    if (
      legacy &&
      !componentRetry &&
      wanted.app &&
      (!readonlyHost.current || readonlyHost.current.build >= wanted.app.build)
    )
      fail(409, 'Legacy bridge requires a newer application target.');
    const host = this.hosts.status(id, now);
    if (o && !o.registrationCommitted) fail(409, 'Host platform is initializing.');
    if (previous) this.reconcile(previous, now);
    if (previous && !terminal(previous)) {
      if (i.retryOf === undefined && same(previous.target, wanted)) return this.status(id, now);
      fail(409, 'Device already has an active workflow.');
    }
    if (previous && i.retryOf === undefined && same(previous.target, wanted))
      fail(409, 'Explicit retry of the previous workflow is required.');
    const maintenance =
      !!previous && (previous.maintenanceRequired || previous.state === 'maintenance-required');
    // Repair continuation always names the historical diagnosis. A newly confirmed
    // current publication may differ; retryOf and history retain both exact targets.
    if (maintenance && i.retryOf !== previous!.id)
      fail(409, 'Maintenance recovery requires an explicit continuation and fresh repair proof.');
    if (
      i.retryOf !== undefined &&
      (!previous ||
        previous.id !== i.retryOf ||
        !this.status(id, now).retry ||
        (!maintenance && !same(previous.target, wanted)))
    )
      fail(409, 'Retry is not eligible for this exact target.');
    if (!host.enrolled || !(o ? o.seen > now - 90000 : host.online))
      fail(409, 'Host channel is not online.');
    const p = this.packages.status();
    if (
      !p ||
      p.expired ||
      p.payload.version !== wanted.agent.version ||
      p.payload.archive.sha256 !== wanted.agent.sha256
    )
      fail(409, 'Agent publication changed or expired.');
    const publication = this.appPublication();
    if (
      wanted.app &&
      (!publication ||
        publication.release.build !== wanted.app.build ||
        publication.release.sha256 !== wanted.app.sha256)
    )
      fail(409, 'Application publication changed or expired.');
    if (host.job && ['queued', 'running'].includes(host.job.state))
      fail(409, 'Legacy update is still active.');
    if (o && wanted.agent.version < o.agent.version) fail(409, 'Agent rollback is prohibited.');
    if (legacy && !supportsLegacyBridge(publication?.release))
      fail(409, 'Legacy adoption requires a supported signed bridge runtime.');
    if (
      !legacy &&
      o?.app &&
      !['idle', 'committed', 'rolled-back'].includes(o.app.phase) &&
      !(o.app.retryable && o.app.serving)
    )
      fail(409, 'Application recovery is not settled.');
    const identity = randomUUID(),
      at = new Date(now).toISOString();
    const job = {
      id: identity,
      nodeId: id,
      build: wanted.app?.build ?? null,
      sha256: wanted.app?.sha256 ?? null,
      index: wanted.app ? publication!.index : null,
      agentIndex: p.index,
      createdAt: at,
      expiresAt: new Date(now + 600000).toISOString(),
      ...(o ? { instanceId: o.instanceId } : {}),
    };
    if (legacy) {
      job.build = null;
      job.sha256 = null;
      job.index = null;
    }
    const w: Workflow = {
      id: identity,
      nodeId: id,
      target: wanted,
      job,
      state: 'queued',
      stage: 'agent',
      createdAt: at,
      updatedAt: at,
      steps: [],
      retryOf: i.retryOf ?? null,
      legacy: !!legacy,
      appJobId: legacy ? (componentRetry ? previous!.appJobId : identity) : null,
      bridgeId: legacy ? (componentRetry ? previous!.bridgeId : identity) : null,
      adoptionPhase: legacy ? 'waiting-app' : null,
      handoff: false,
      pendingInstance: null,
      pendingSeq: 0,
      lastReportSeq: 0,
      startedAt: null,
      continuationUntil: null,
      appResult: null,
      maintenanceRequired: false,
      repairProof: null,
      componentOnlyBridge: componentRetry,
      application: legacy ? publication : null,
    };
    // The predetermined application ID is durably associated before v1 enqueue. A retry
    // or prepared discovery reconciles an interruption without creating a second job.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save(w);
      this.db
        .prepare('INSERT INTO latest VALUES(?,?) ON CONFLICT(node) DO UPDATE SET id=excluded.id')
        .run(id, w.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (legacy && !componentRetry) this.ensureLegacyJob(w, now);
    return this.status(id, now);
  }
  private ensureLegacyJob(w: Workflow, now: number) {
    if (this.hosts.status(w.nodeId, now).job?.id === w.appJobId) return;
    const p = w.application;
    if (!p || p.release.build !== w.target.app!.build || p.release.sha256 !== w.target.app!.sha256)
      fail(409, 'Approved application bridge publication is unavailable.');
    this.hosts.enqueue(
      w.nodeId,
      { confirmed: true, build: w.target.app!.build, sha256: w.target.app!.sha256 },
      p.release,
      p.index,
      now,
      { id: w.appJobId!, reservation: w.appJobId!, bridgePreflight: true },
    );
  }
  poll(token: string, input: unknown, now = Date.now()) {
    // Ownership, candidate sequence, observations and workflow progress share one
    // durable commit. A stopped old worker must never remain the sole authority
    // after an interrupted candidate transfer.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.pollTransaction(token, input, now);
      this.db.exec('COMMIT');
      try {
        this.retainHistory(now);
      } catch {
        /* Retention never interrupts heartbeat. */
      }
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private pollTransaction(token: string, input: unknown, now: number) {
    const i = obj(input, ['nodeId', 'instanceId', 'agent', 'app', 'capabilities', 'report']);
    if (typeof i.nodeId !== 'string') fail();
    this.hosts.authorize(i.nodeId, token);
    if (!uuid(i.instanceId)) fail();
    const a = obj(i.agent, ['version', 'sha256']);
    if (!positive(a.version) || !digest(a.sha256)) fail();
    const probe = app(i.app),
      c = obj(i.capabilities, [
        'hostWorker',
        'platformCommitted',
        'automaticBuildkit',
        'signedImageRunner',
        'inventory',
        'inventoryError',
      ]);
    if (c.hostWorker !== 2 || c.automaticBuildkit !== true || c.signedImageRunner !== true) fail();
    bools(c, ['platformCommitted']);
    inventory(c.inventory);
    if (c.inventoryError !== null) {
      const e = obj(c.inventoryError, ['at', 'reason']);
      if (!date(e.at) || !text(e.reason, 80)) fail();
    }
    const r = report(i.report),
      o = this.observation(i.nodeId),
      w = this.latest(i.nodeId);
    if (w) this.reconcile(w, now);
    let owner = o?.instanceId === i.instanceId;
    // Uncommitted initial health is replaceable, but never crosses an active workflow.
    const initial = (!o || !o.registrationCommitted) && (!w || terminal(w));
    if (initial) owner = true;
    const exact = !!w && same(w.target.agent, a),
      active = !!w && !terminal(w);
    // Candidate health proves reachability only. The platform's subsequent committed
    // running report is the sole ownership transfer; old rollback owner stays valid.
    if (active && r?.id === w.id && r.stage === 'agent' && exact && !owner) {
      const expected = w.handoff || (w.legacy && w.adoptionPhase === 'activating');
      if (
        expected &&
        r.state === 'waiting' &&
        r.seq > w.lastReportSeq &&
        r.seq > w.pendingSeq &&
        (!w.pendingInstance || w.pendingInstance === i.instanceId)
      ) {
        w.pendingInstance = i.instanceId;
        w.pendingSeq = r.seq;
        this.save(w);
      }
      if (
        expected &&
        r.state === 'running' &&
        w.pendingInstance === i.instanceId &&
        r.seq > w.lastReportSeq &&
        r.seq > w.pendingSeq
      ) {
        owner = true;
        w.handoff = false;
        this.save(w);
      }
    }
    let acknowledged: string | null = r?.id ?? null;
    if (owner) {
      this.saveObservation(i.nodeId, {
        credentialVersion: this.hosts.credentialVersion(i.nodeId),
        registrationCommitted: o?.registrationCommitted === true || c.platformCommitted,
        instanceId: i.instanceId,
        agent: a,
        app: probe,
        capabilities: c,
        seen: now,
      });
      this.hosts.observeV2(
        i.nodeId,
        probe
          ? { build: probe.current.build, protocol: probe.current.protocol, phase: probe.phase }
          : null,
        now,
      );
      if (active && r?.id === w.id && r.seq > w.lastReportSeq) {
        const validSuccess =
          r.state !== 'succeeded' ||
          (exact &&
            (w.legacy
              ? r.stage === 'agent' &&
                (w.componentOnlyBridge ||
                  this.hosts.status(i.nodeId, now).job?.state === 'succeeded')
              : w.target.app
                ? r.stage === 'verify' && applicationReady(w, probe)
                : r.stage === 'agent'));
        if (!validSuccess && r.state === 'succeeded') acknowledged = null;
        if (validSuccess) {
          w.lastReportSeq = r.seq;
          w.stage = r.stage;
          w.state = r.state === 'queued' ? 'running' : r.state;
          w.updatedAt = new Date(now).toISOString();
          if (r.stage === 'agent' && r.state === 'waiting' && !exact) w.handoff = true;
          const entry = {
            stage: r.stage,
            state: r.state,
            message: r.message.replaceAll(token, '[redacted]'),
            log: r.log.replaceAll(token, '[redacted]'),
            at: w.updatedAt,
          };
          if (!w.steps.length || !same({ ...w.steps.at(-1), at: '' }, { ...entry, at: '' }))
            w.steps.push(entry);
          w.steps = w.steps.slice(-100);
          if (w.state === 'succeeded' && w.legacy) w.adoptionPhase = 'adopted';
          this.save(w);
        }
      }
    }
    let job: Obj | null = null;
    if (
      owner &&
      this.observation(i.nodeId)?.registrationCommitted &&
      w &&
      !w.legacy &&
      !terminal(w)
    ) {
      if (w.state === 'queued') {
        w.state = 'running';
        w.updatedAt = new Date(now).toISOString();
        this.save(w);
      }
      job = { ...w.job, instanceId: i.instanceId };
    }
    return { job, acknowledged };
  }
  adoption(token: string, input: unknown, now = Date.now()) {
    const i = obj(
      input,
      ['nodeId', 'phase'],
      ['bridgeId', 'appJobId', 'attemptId', 'report', 'proof'],
    );
    if (typeof i.nodeId !== 'string') fail();
    this.hosts.authorize(i.nodeId, token);
    if (
      ![
        'prepared',
        'precheck',
        'waiting-app',
        'waiting-ack',
        'activating',
        'adopted',
        'failed',
        'maintenance-required',
      ].includes(i.phase)
    )
      fail();
    const w = this.latest(i.nodeId);
    if (!w?.legacy || (i.bridgeId !== undefined && i.bridgeId !== w.bridgeId))
      fail(409, 'No matching legacy bridge.');
    if (i.phase === 'prepared') {
      if (!uuid(i.appJobId) || i.appJobId !== w.appJobId)
        fail(409, 'Bridge application identity mismatch.');
    } else if (i.bridgeId !== w.bridgeId) fail(409, 'Bridge identity is required.');
    if (
      (i.appJobId !== undefined && i.appJobId !== w.appJobId) ||
      (i.attemptId !== undefined && i.attemptId !== w.id)
    )
      fail(409, 'Stale adoption attempt.');
    if (
      ['activating', 'adopted', 'failed', 'maintenance-required', 'precheck'].includes(i.phase) &&
      i.attemptId !== w.id
    )
      fail(409, 'Attempt identity is required.');
    if (i.phase === 'precheck') {
      const p = obj(i.proof, [
        'observedAt',
        'rootRw',
        'kernelStatus',
        'recovery',
        'appReady',
        'targetReady',
      ]);
      if (
        !date(p.observedAt) ||
        Math.abs(now - Date.parse(p.observedAt)) > 60000 ||
        typeof p.rootRw !== 'boolean' ||
        typeof p.appReady !== 'boolean' ||
        typeof p.targetReady !== 'boolean' ||
        (p.targetReady && !p.appReady) ||
        !['clear', 'errors', 'unavailable'].includes(p.kernelStatus) ||
        !['settled', 'unfinished', 'unknown'].includes(p.recovery)
      )
        fail();
      if (!['failed', 'maintenance-required'].includes(w.state))
        fail(409, 'Repair precheck requires a terminal unsuccessful attempt.');
      w.repairProof = { ...p, receivedAt: now };
      this.save(w);
    } else if (i.proof !== undefined) fail();
    let message = '',
      log = '';
    if (i.report !== undefined) {
      const r = obj(i.report, ['message', 'log']);
      if (!text(r.message, 1000) || !text(r.log, 6000)) fail();
      message = r.message.replaceAll(token, '[redacted]');
      log = r.log.replaceAll(token, '[redacted]');
    }
    this.reconcile(w, now);
    const j = this.hosts.status(i.nodeId, now).job;
    if (!j || j.id !== w.appJobId) fail(409, 'Associated application job unavailable.');
    if (i.phase === 'maintenance-required' && w.adoptionPhase !== 'adopted') {
      w.maintenanceRequired = true;
      if (terminal(w)) {
        w.steps.push({
          stage: 'maintenance',
          state: 'maintenance-required',
          message,
          log,
          at: new Date(now).toISOString(),
        });
        this.save(w);
      }
    }
    let activationAccepted = false;
    if (!terminal(w)) {
      if (i.phase === 'prepared' && !w.startedAt) {
        if (Date.parse(w.job.expiresAt) <= now) fail(409, 'Confirmation expired.');
        w.startedAt = new Date(now).toISOString();
        w.continuationUntil = new Date(now + 2 * 3600000).toISOString();
        w.state = 'running';
      }
      if (i.phase === 'activating' && w.adoptionPhase !== 'activating') {
        if (
          (!w.componentOnlyBridge && j.state !== 'succeeded') ||
          !w.startedAt ||
          !w.continuationUntil ||
          Date.parse(w.continuationUntil) <= now
        )
          fail(409, 'Application completion and bounded started authorization are required.');
        activationAccepted = true;
      }
      if (i.phase === 'adopted' && (!this.observation(i.nodeId) || w.adoptionPhase !== 'adopted'))
        fail(409, 'Worker completion proof is required.');
      if (['failed', 'maintenance-required'].includes(i.phase)) {
        w.state = i.phase;
        w.stage = 'agent';
      }
      if (
        (w.adoptionPhase !== 'adopted' &&
          !['prepared', 'waiting-app', 'waiting-ack'].includes(i.phase)) ||
        w.adoptionPhase === 'waiting-app'
      )
        w.adoptionPhase = i.phase;
      w.updatedAt = new Date(now).toISOString();
      if (message || log)
        w.steps.push({ stage: 'agent', state: i.phase, message, log, at: w.updatedAt });
      w.steps = w.steps.slice(-100);
      this.save(w);
    }
    const eligible =
      !terminal(w) &&
      w.adoptionPhase !== 'activating' &&
      (w.startedAt
        ? !!w.continuationUntil && Date.parse(w.continuationUntil) > now
        : Date.parse(w.job.expiresAt) > now);
    return {
      bridge: {
        id: w.bridgeId,
        appJobId: w.appJobId,
        build: w.target.app!.build,
        sha256: w.target.app!.sha256,
        state: j.state,
        index: j.index,
      },
      attempt: {
        id: w.id,
        agentIndex: w.job.agentIndex as SignedAgentIndex,
        app: w.target.app,
        job: w.job,
        createdAt: w.createdAt,
        expiresAt: w.job.expiresAt,
        startedAt: w.startedAt,
        continuationUntil: w.continuationUntil,
        state: w.adoptionPhase,
        startAllowed: eligible,
        activationAccepted,
        targetReadyApproved: w.componentOnlyBridge,
      },
    };
  }
  close() {
    this.hosts.reserveWith(() => null);
    this.db.close();
  }
}
