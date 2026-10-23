import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, parse, sep } from 'node:path';
import {
  COMPATIBILITY_PATHS,
  MAX_INDEX_BYTES,
  RUNTIME_LEVEL,
  compatibility,
  parseDescriptor,
  releaseFilename,
  requireValue,
  sha256,
  strictObject,
  verifyServerIndex,
  type KeyInput,
  type ReplayState,
  type ServerRelease,
  type SignedServerIndex,
} from '../../../packages/managed-server/src/index.ts';
import {
  assertSafeDirectory,
  durableWrite,
  extractRelease,
  readRegular,
  syncDirectory,
  verifyReleaseDirectory,
} from './managed-server-files.ts';
import type {
  CurrentProgram,
  InstallConfirmation,
  Phase,
  ServerCheck,
  ServerStatus,
} from './managed-server-http.ts';

export type ReadyProof = {
  nonce: string;
  build: number;
  protocol: number;
  releaseHash: string;
  policyHash: string;
  openedStore: true;
  effectivePolicy: true;
};
export type LaunchOptions = {
  root: string;
  current: CurrentProgram;
  expected: Omit<ReadyProof, 'openedStore' | 'effectivePolicy'>;
};
export type ProgramChild = {
  ready: Promise<ReadyProof>;
  exited: Promise<void>;
  stop(): Promise<void>;
  commit(): void;
  cancelMaintenance?(): void;
};
type Journal = {
  schema: 1;
  phase: Phase;
  current: SignedServerIndex | null;
  previous: SignedServerIndex | null;
  target: SignedServerIndex | null;
  backup: string | null;
  attempts: number;
};
type Options = {
  root: string;
  stateRoot: string;
  dataDirectories: string[];
  keys: Record<string, KeyInput>;
  launch(options: LaunchOptions): Promise<ProgramChild>;
  runtimeCheck(): boolean;
  download?: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Buffer>;
  readyTimeoutMs?: number;
  prepareTimeoutMs?: number;
  handoffTimeoutMs?: number;
  onUnexpectedExit?: () => void | Promise<void>;
  baselineCurrent?: CurrentProgram;
};
const ORIGIN = 'https://api.ghostapi.org';
const INDEX = ORIGIN + '/cc-updates/server/v1/channels/pilot/linux-x64.json';
export const PREPARE_TIMEOUT_MS = 120000;
export const MANAGEMENT_IPC_TIMEOUT_MS = 180000;
function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
export function selectBackupDirectories(paths: string[], stateRoot: string) {
  const selected: string[] = [];
  for (const path of [...new Set(paths.map((p) => resolve(p)))].sort(
    (a, b) => a.length - b.length,
  )) {
    requireValue(
      path !== parse(path).root && !within(resolve(stateRoot), path),
      'Unsafe backup source overlaps managed state',
    );
    if (!selected.some((parent) => within(parent, path))) selected.push(path);
  }
  return selected;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('Preparation aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}
export async function downloadTrusted(url: string, maxBytes: number, signal?: AbortSignal) {
  const u = new URL(url);
  requireValue(
    u.origin === ORIGIN &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname.startsWith('/cc-updates/server/v1/'),
    'Untrusted download URL',
  );
  const result = await fetch(u, {
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
    headers: { 'accept-encoding': 'identity' },
  });
  requireValue(
    result.ok &&
      result.body &&
      (!result.headers.has('content-length') ||
        Number(result.headers.get('content-length')) <= maxBytes),
    'Release download failed',
  );
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = result.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      requireValue(total <= maxBytes, 'Download too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export class ManagedServerSupervisor {
  private options: Options;
  private journal: Journal = {
    schema: 1,
    phase: 'idle',
    current: null,
    previous: null,
    target: null,
    backup: null,
    attempts: 0,
  };
  private replay?: ReplayState;
  private child?: ProgramChild;
  private stopped = false;
  private transitioning = false;
  private prepared = false;
  private activeOperation?: Promise<void>;
  private preparing?: { owner: ProgramChild; controller: AbortController; deadline: number };
  private preparedOwner?: ProgramChild;
  private preparedPrevious: SignedServerIndex | null | undefined;
  private handoffTimer?: NodeJS.Timeout;
  private handoffDeadline = 0;
  private exitedChildren = new WeakSet<ProgramChild>();
  private committedChildren = new WeakSet<ProgramChild>();
  private missedExit?: ProgramChild;
  private failure?: string;
  private readonly base: CurrentProgram;
  private readonly baseDescriptorHash: string;
  private readonly baselineCompatibility: Record<string, string>;
  private readonly baselineLock: string;
  private readonly policyHash: string;
  private readonly disabled: boolean;
  constructor(options: Options) {
    this.options = {
      ...options,
      dataDirectories: selectBackupDirectories(options.dataDirectories, options.stateRoot),
    };
    assertSafeDirectory(options.root);
    this.baselineCompatibility = compatibility(options.root);
    this.baselineLock = sha256(readRegular(join(options.root, 'package-lock.json')));
    this.policyHash = sha256(JSON.stringify(this.baselineCompatibility));
    const descriptorPath = join(options.root, 'SERVER-RELEASE.json');
    this.disabled = !existsSync(descriptorPath);
    const descriptorBytes = this.disabled ? null : readRegular(descriptorPath, 4 * 1024 * 1024);
    const d = descriptorBytes ? parseDescriptor(descriptorBytes) : null;
    if (d)
      for (const [path, expected] of Object.entries(d.files)) {
        const bytes = readRegular(join(options.root, path), expected.size);
        requireValue(
          bytes.length === expected.size && sha256(bytes) === expected.sha256,
          'Baseline inventory digest mismatch',
        );
      }
    this.base = d
      ? { build: d.build, protocol: d.protocol, appVersion: d.appVersion, sha256: null }
      : (options.baselineCurrent ?? { build: 1, protocol: 1, appVersion: '0.0.0', sha256: null });
    this.baseDescriptorHash = descriptorBytes
      ? sha256(descriptorBytes)
      : sha256('immutable-source-baseline');
  }
  get backupDirectory() {
    return this.journal.backup
      ? join(this.options.stateRoot, 'backups', this.journal.backup)
      : null;
  }
  private verified(envelope: SignedServerIndex) {
    return verifyServerIndex(JSON.stringify(envelope), {
      keys: this.options.keys,
      installed: true,
    });
  }
  private directory(envelope: SignedServerIndex | null) {
    return envelope
      ? join(this.options.stateRoot, 'releases', this.verified(envelope).payload.release.sha256)
      : this.options.root;
  }
  private current(envelope = this.journal.current): CurrentProgram {
    if (!envelope) return this.base;
    const r = this.verified(envelope).payload.release;
    return { build: r.build, protocol: r.protocol, appVersion: r.appVersion, sha256: r.sha256 };
  }
  private persist() {
    durableWrite(join(this.options.stateRoot, 'journal.json'), this.journal);
  }
  private phase(phase: Phase) {
    this.journal.phase = phase;
    this.persist();
  }
  private compatible(release: ServerRelease) {
    return (
      !this.disabled &&
      this.options.runtimeCheck() &&
      release.runtimeLevel === RUNTIME_LEVEL &&
      release.packageLockSha256 === this.baselineLock &&
      COMPATIBILITY_PATHS.every(
        (path) => release.compatibility[path] === this.baselineCompatibility[path],
      )
    );
  }
  private verifyInstalled(envelope: SignedServerIndex | null) {
    if (!envelope) return;
    const r = this.verified(envelope).payload.release;
    requireValue(this.compatible(r), 'Installed release requires manual image upgrade');
    const d = verifyReleaseDirectory(this.directory(envelope), r);
    const sourceCompatibility = compatibility(this.directory(envelope));
    requireValue(
      d.files['package-lock.json'].sha256 === r.packageLockSha256 &&
        COMPATIBILITY_PATHS.every((p) => sourceCompatibility[p] === r.compatibility[p]),
      'Installed compatibility inventory mismatch',
    );
  }
  private async index(signal?: AbortSignal) {
    const download = (this.options.download ?? downloadTrusted)(INDEX, MAX_INDEX_BYTES, signal);
    const bytes = await (signal ? abortable(download, signal) : download);
    signal?.throwIfAborted();
    const index = verifyServerIndex(bytes, { keys: this.options.keys, replay: this.replay });
    this.replay = index.replay;
    durableWrite(join(this.options.stateRoot, 'replay.json'), this.replay);
    return index;
  }
  async check(protocol: number): Promise<ServerCheck> {
    if (this.disabled)
      return {
        schema: 1,
        current: this.current(),
        candidate: null,
        index: null,
        compatible: false,
        reason: 'disabled',
      };
    const index = await this.index(),
      release = index.payload.release;
    const reason = !this.compatible(release)
      ? 'manual-image-upgrade'
      : release.protocol !== protocol
        ? 'protocol-unavailable'
        : release.build <= this.current().build
          ? 'current'
          : this.transitioning
            ? 'busy'
            : 'available';
    return {
      schema: 1,
      current: this.current(),
      candidate: release,
      index: index.envelope,
      compatible: reason === 'available' || reason === 'current',
      reason,
    };
  }
  async status(): Promise<ServerStatus> {
    return {
      schema: 1,
      phase: this.journal.phase,
      current: this.current(),
      target: this.journal.target ? this.verified(this.journal.target).payload.release : null,
      ...(this.failure ? { error: this.failure } : {}),
    };
  }
  async prepare(request: InstallConfirmation) {
    requireValue(
      !this.stopped && !this.transitioning && !this.prepared && request.confirmed === true,
      'Upgrade unavailable',
    );
    const operation = this.prepareRelease(request);
    this.activeOperation = operation;
    try {
      await operation;
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }
  private async prepareRelease(request: InstallConfirmation) {
    requireValue(this.child, 'Missing upgrade owner');
    this.transitioning = true;
    this.failure = undefined;
    const previous = this.journal.previous;
    const controller = new AbortController(),
      owner = this.child;
    this.preparing = {
      owner,
      controller,
      deadline: Date.now() + (this.options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS),
    };
    const checkOwner = () => {
      if (this.stopped || this.child !== owner || this.exitedChildren.has(owner))
        controller.abort(new Error('Preparation owner exited'));
      if (Date.now() >= this.preparing!.deadline)
        controller.abort(new Error('Preparation deadline exceeded'));
      controller.signal.throwIfAborted();
    };
    const timer = setTimeout(
      () => controller.abort(new Error('Preparation deadline exceeded')),
      this.options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS,
    );
    try {
      const index = await this.index(controller.signal),
        r = index.payload.release;
      checkOwner();
      requireValue(
        r.build === request.build &&
          r.sha256 === request.sha256 &&
          r.protocol === request.clientProtocol &&
          r.build > this.current().build &&
          this.compatible(r),
        'Confirmed release no longer installable',
      );
      this.journal.previous = this.journal.current;
      this.journal.target = index.envelope;
      this.phase('staging');
      const bytes = await abortable(
        (this.options.download ?? downloadTrusted)(
          `${ORIGIN}/cc-updates/server/v1/artifacts/${r.build}/linux-x64/${releaseFilename(r)}`,
          r.size,
          controller.signal,
        ),
        controller.signal,
      );
      checkOwner();
      const directory = this.directory(index.envelope);
      if (existsSync(directory)) verifyReleaseDirectory(directory, r);
      else extractRelease(bytes, directory, r);
      checkOwner();
      this.verifyInstalled(index.envelope);
      checkOwner();
      const fresh = await this.index(controller.signal);
      requireValue(fresh.payloadHash === index.payloadHash, 'Release changed during staging');
      checkOwner();
      this.prepared = true;
      this.preparedOwner = owner;
      this.preparedPrevious = previous;
      this.handoffDeadline = Date.now() + (this.options.handoffTimeoutMs ?? 10000);
      this.handoffTimer = setTimeout(
        () => this.cancelPrepared('handoff-timeout'),
        this.options.handoffTimeoutMs ?? 10000,
      );
    } catch (error) {
      this.journal.previous = previous;
      this.journal.target = null;
      this.phase('failed');
      this.failure = 'staging-failed';
      this.transitioning = false;
      owner.cancelMaintenance?.();
      throw error;
    } finally {
      clearTimeout(timer);
      this.preparing = undefined;
      if (!this.transitioning && this.missedExit && !this.stopped) this.resumeMissedExit();
    }
  }
  private cancelPrepared(reason: string) {
    if (!this.prepared) return;
    clearTimeout(this.handoffTimer);
    this.prepared = false;
    const owner = this.preparedOwner;
    this.preparedOwner = undefined;
    if (this.preparedPrevious !== undefined) this.journal.previous = this.preparedPrevious;
    this.preparedPrevious = undefined;
    this.journal.target = null;
    this.failure = reason;
    this.phase('failed');
    this.transitioning = false;
    owner?.cancelMaintenance?.();
  }
  async activate() {
    if (
      this.prepared &&
      (this.preparedOwner !== this.child ||
        this.exitedChildren.has(this.preparedOwner!) ||
        Date.now() >= this.handoffDeadline)
    )
      this.cancelPrepared('handoff-expired');
    requireValue(this.prepared && !this.stopped && this.journal.target, 'No prepared release');
    clearTimeout(this.handoffTimer);
    this.preparedOwner = undefined;
    this.preparedPrevious = undefined;
    this.prepared = false;
    const operation = this.switchProgram();
    this.activeOperation = operation;
    try {
      await operation;
    } finally {
      this.activeOperation = undefined;
    }
  }
  private async switchProgram() {
    const target = this.journal.target!,
      previous = this.journal.previous;
    try {
      this.phase('stopping');
      await this.stopChild();
      requireValue(!this.stopped, 'Supervisor stopping');
      this.phase('backup');
      this.backup();
      requireValue(!this.stopped, 'Supervisor stopping');
      const fresh = await this.index();
      requireValue(
        fresh.payloadHash === this.verified(target).payloadHash,
        'Release changed before switch',
      );
      this.verifyInstalled(target);
      this.journal.current = target;
      this.phase('switching');
      this.phase('probing');
      await this.launch();
      requireValue(!this.stopped, 'Supervisor stopping');
      this.journal.target = null;
      this.journal.attempts = 0;
      this.phase('committed');
      this.commitChild();
    } catch {
      await this.stopChild();
      if (this.stopped) return;
      // Candidate writes are retained. Byte-identical persistence modules guarantee old program readability.
      this.verifyInstalled(previous);
      this.journal.current = previous;
      this.journal.target = null;
      this.failure = 'candidate-failed';
      this.phase('rolled-back');
      await this.launch();
      this.commitChild();
    } finally {
      this.transitioning = false;
    }
  }
  private backup() {
    const name = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    this.journal.backup = name;
    this.persist();
    const destination = this.backupDirectory!;
    assertSafeDirectory(destination, true);
    let count = 0,
      bytes = 0;
    const copy = (source: string, target: string) => {
      assertSafeDirectory(source);
      assertSafeDirectory(target, true);
      for (const name of readdirSync(source)) {
        const src = join(source, name),
          dst = join(target, name),
          stat = lstatSync(src);
        if (resolve(src) === resolve(this.options.stateRoot)) continue;
        requireValue(!stat.isSymbolicLink(), 'Backup symlink rejected');
        if (stat.isDirectory()) copy(src, dst);
        else {
          requireValue(
            stat.isFile() && ++count <= 200000 && (bytes += stat.size) <= 8 * 1024 ** 3,
            'Backup exceeds safe limits',
          );
          copyFileSync(src, dst);
          const fd = openSync(dst, 'r+');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
      syncDirectory(target);
    };
    this.options.dataDirectories.forEach((source, index) => {
      if (existsSync(source)) copy(source, join(destination, String(index)));
    });
    durableWrite(join(destination, 'BACKUP.json'), {
      schema: 1,
      previous: this.journal.previous,
      sources: this.options.dataDirectories,
      createdAt: new Date().toISOString(),
    });
    syncDirectory(destination);
  }
  private async launch() {
    requireValue(!this.stopped, 'Supervisor stopping');
    this.verifyInstalled(this.journal.current);
    const current = this.current(),
      envelope = this.journal.current;
    const expected = {
      nonce: randomBytes(32).toString('hex'),
      build: current.build,
      protocol: current.protocol,
      releaseHash: envelope
        ? this.verified(envelope).payload.release.sha256
        : this.baseDescriptorHash,
      policyHash: this.policyHash,
    };
    const child = await this.options.launch({ root: this.directory(envelope), current, expected });
    this.child = child;
    let timer: NodeJS.Timeout | undefined;
    try {
      requireValue(!this.stopped, 'Supervisor stopping');
      const proof = await Promise.race([
        child.ready,
        child.exited.then(() => {
          throw new Error('Child exited before readiness');
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Readiness timed out')),
            this.options.readyTimeoutMs ?? 30000,
          );
        }),
      ]);
      requireValue(
        proof.openedStore === true &&
          proof.effectivePolicy === true &&
          Object.entries(expected).every(
            ([key, value]) => proof[key as keyof ReadyProof] === value,
          ),
        'Readiness proof mismatch',
      );
    } catch (error) {
      await this.stopChild();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    void child.exited
      .then(() => this.childExited(child))
      .catch(() => {
        this.failure = 'restart-limit';
        this.phase('failed');
      });
  }
  private commitChild() {
    requireValue(
      this.child && !this.exitedChildren.has(this.child) && !this.stopped,
      'Child exited before commit',
    );
    this.child.commit();
    this.committedChildren.add(this.child);
  }
  private async childExited(child: ProgramChild) {
    if (this.stopped || this.child !== child) return;
    this.exitedChildren.add(child);
    this.preparing?.controller.abort(new Error('Preparation owner exited'));
    if (this.preparedOwner === child) this.cancelPrepared('owner-exited');
    if (this.options.onUnexpectedExit && this.committedChildren.has(child)) {
      // PTYs may own separate process groups. Only whole-container teardown can prove all were reaped.
      this.stopped = true;
      this.journal.attempts = Math.min(3, this.journal.attempts + 1);
      this.failure = 'child-exit-container-restart';
      this.phase('failed');
      try {
        await this.stopChild();
      } finally {
        await this.options.onUnexpectedExit();
      }
      return;
    }
    if (this.transitioning) {
      this.missedExit = child;
      return;
    }
    await this.recoverExit();
  }
  private resumeMissedExit() {
    const child = this.missedExit;
    this.missedExit = undefined;
    if (child && this.child === child && !this.stopped)
      void this.recoverExit().catch(() => {
        this.failure = 'restart-limit';
        this.phase('failed');
      });
  }
  private async recoverExit() {
    this.transitioning = true;
    try {
      // Leader exit does not prove its detached process group is empty. Drain that handle before relaunch.
      await this.stopChild();
      while (!this.stopped && this.journal.attempts < 3) {
        this.journal.attempts++;
        this.persist();
        try {
          await this.launch();
          if (!this.stopped) this.commitChild();
          return;
        } catch {
          await this.stopChild();
        }
      }
      if (!this.stopped && !(await this.rollbackUnhealthy()))
        throw new Error('Restart limit reached');
    } finally {
      this.transitioning = false;
    }
  }
  private async stopChild() {
    const child = this.child;
    this.child = undefined;
    if (child) {
      await child.stop();
      await child.exited;
    }
  }
  private async rollbackUnhealthy() {
    if (
      this.stopped ||
      !this.journal.current ||
      JSON.stringify(this.journal.current) === JSON.stringify(this.journal.previous)
    )
      return false;
    this.verifyInstalled(this.journal.previous);
    this.journal.current = this.journal.previous;
    this.journal.target = null;
    this.failure = 'candidate-unhealthy';
    this.phase('rolled-back');
    await this.launch();
    requireValue(!this.stopped, 'Supervisor stopping');
    this.commitChild();
    return true;
  }
  async start() {
    assertSafeDirectory(this.options.stateRoot, true);
    assertSafeDirectory(join(this.options.stateRoot, 'releases'), true);
    assertSafeDirectory(join(this.options.stateRoot, 'backups'), true);
    const journalPath = join(this.options.stateRoot, 'journal.json');
    if (existsSync(journalPath)) {
      const j = strictObject(JSON.parse(readRegular(journalPath, MAX_INDEX_BYTES * 4).toString()), [
        'schema',
        'phase',
        'current',
        'previous',
        'target',
        'backup',
        'attempts',
      ]);
      requireValue(
        j.schema === 1 &&
          [
            'idle',
            'staging',
            'stopping',
            'backup',
            'switching',
            'probing',
            'committed',
            'rolled-back',
            'failed',
          ].includes(j.phase as string) &&
          Number.isSafeInteger(j.attempts) &&
          (j.attempts as number) >= 0 &&
          (j.attempts as number) <= 3 &&
          (j.backup === null ||
            (typeof j.backup === 'string' && /^\d{13}-[a-f0-9]{16}$/.test(j.backup))),
        'Invalid supervisor journal',
      );
      this.journal = j as Journal;
      for (const envelope of [this.journal.current, this.journal.previous, this.journal.target])
        if (envelope !== null) this.verified(envelope);
    }
    const replayPath = join(this.options.stateRoot, 'replay.json');
    if (existsSync(replayPath)) {
      const floor = strictObject(JSON.parse(readRegular(replayPath, 1024).toString()), [
        'revision',
        'payloadHash',
        'highestBuild',
        'artifactHash',
      ]);
      requireValue(
        Number.isSafeInteger(floor.revision) &&
          (floor.revision as number) > 0 &&
          Number.isSafeInteger(floor.highestBuild) &&
          (floor.highestBuild as number) > 0 &&
          [floor.payloadHash, floor.artifactHash].every(
            (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h),
          ),
        'Invalid replay floor',
      );
      this.replay = floor as ReplayState;
    }
    this.verifyInstalled(this.journal.current);
    this.verifyInstalled(this.journal.previous);
    requireValue(
      !this.options.onUnexpectedExit || this.journal.attempts < 3,
      'Container crash restart limit reached; administrator attention required',
    );
    if (this.journal.target) {
      this.journal.current = this.journal.previous;
      this.journal.target = null;
      this.phase('rolled-back');
    }
    this.transitioning = true;
    try {
      await this.launch();
      requireValue(!this.stopped, 'Supervisor stopping');
      this.commitChild();
    } catch (error) {
      await this.stopChild();
      if (this.options.onUnexpectedExit && !this.stopped) {
        this.journal.attempts = Math.min(3, this.journal.attempts + 1);
        this.failure = 'startup-readiness-failed';
        this.phase('failed');
      }
      if (!(await this.rollbackUnhealthy())) throw error;
    } finally {
      this.transitioning = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.preparing?.controller.abort(new Error('Supervisor stopping'));
    clearTimeout(this.handoffTimer);
    this.cancelPrepared('supervisor-stopping');
    await this.stopChild();
    await this.activeOperation?.catch(() => {});
  }
}
