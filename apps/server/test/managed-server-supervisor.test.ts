import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture, tar } from './managed-server-archive.test.ts';
import {
  sha256,
  compatibility,
  signServerIndex,
  RUNTIME_LEVEL,
  type ServerPayload,
} from '../../../packages/managed-server/src/index.ts';
import {
  ManagedServerSupervisor,
  selectBackupDirectories,
  type LaunchOptions,
  type ProgramChild,
} from '../src/managed-server-supervisor.ts';

function setup(t: { after(fn: () => void): void }, failCandidate = false) {
  const fixture = releaseFixture(t),
    keys = generateKeyPairSync('ed25519');
  writeFileSync(
    join(fixture.root, 'SERVER-RELEASE.json'),
    JSON.stringify({ ...fixture.descriptor, build: 1 }),
  );
  mkdirSync(join(fixture.root, 'deploy'));
  writeFileSync(join(fixture.root, 'deploy/managed-server.json'), JSON.stringify({ build: 1 }));
  const data = join(fixture.root, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'sessions.sqlite'), 'original');
  const archive = tar(fixture.files);
  const payload: ServerPayload = {
    schema: 1,
    product: 'cc-desk-tunnel-managed-server',
    channel: 'pilot',
    platform: 'linux',
    arch: 'x64',
    revision: 2,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    release: {
      build: 2,
      appVersion: '0.2.11',
      protocol: 42,
      sourceCommit: 'a'.repeat(40),
      size: archive.length,
      sha256: sha256(archive),
      descriptorSha256: sha256(fixture.descriptorBytes),
      packageLockSha256: sha256(readFileSync(join(fixture.root, 'package-lock.json'))),
      runtimeLevel: RUNTIME_LEVEL,
      compatibility: compatibility(fixture.root),
    },
  };
  const envelope = signServerIndex(payload, 'test', keys.privateKey);
  const events: string[] = [];
  let live = 0;
  let crash = () => {};
  const launch = async (options: LaunchOptions): Promise<ProgramChild> => {
    assert.equal(live, 0, 'old child exits before new starts');
    live++;
    events.push(`launch:${options.current.build}`);
    let exit!: () => void;
    const exited = new Promise<void>((r) => {
      exit = r;
    });
    let ended = false;
    const finish = () => {
      if (!ended) {
        ended = true;
        live--;
        exit();
      }
    };
    crash = finish;
    if (options.current.sha256) writeFileSync(join(data, 'sessions.sqlite'), 'candidate-write');
    return {
      exited,
      ready:
        failCandidate && options.current.sha256
          ? Promise.reject(new Error('probe failed'))
          : Promise.resolve({ ...options.expected, openedStore: true, effectivePolicy: true }),
      commit: () => {
        events.push('commit');
      },
      cancelMaintenance: () => {
        events.push('cancel-maintenance');
      },
      stop: async () => {
        events.push('stop');
        finish();
      },
    };
  };
  const options = {
    root: fixture.root,
    stateRoot: join(fixture.root, 'managed'),
    dataDirectories: [data],
    keys: { test: keys.publicKey },
    runtimeCheck: () => true,
    launch,
    download: async (url: string) =>
      url.endsWith('.tar.gz') ? archive : Buffer.from(JSON.stringify(envelope)),
  };
  return { ...fixture, data, payload, envelope, options, events, keys, crash: () => crash() };
}
test('upgrade cold backs up after exit, commits authenticated readiness and re-verifies installed release on restart', async (t) => {
  const f = setup(t),
    supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  const check = await supervisor.check(42);
  assert.equal(check.reason, 'available');
  assert.ok(check.index);
  assert.equal((await supervisor.check(999)).reason, 'protocol-unavailable');
  await assert.rejects(
    supervisor.prepare({ clientProtocol: 42, confirmed: true, build: 2, sha256: '0'.repeat(64) }),
  );
  await supervisor.prepare({
    clientProtocol: 42,
    confirmed: true,
    build: 2,
    sha256: f.payload.release.sha256,
  });
  await supervisor.activate();
  assert.equal((await supervisor.status()).phase, 'committed');
  assert.equal((await supervisor.status()).current.build, 2);
  assert.equal(
    readFileSync(join(supervisor.backupDirectory!, '0/sessions.sqlite'), 'utf8'),
    'original',
  );
  await supervisor.stop();
  const restarted = new ManagedServerSupervisor(f.options);
  await restarted.start();
  assert.equal((await restarted.status()).current.build, 2);
  await restarted.stop();
  writeFileSync(
    join(f.options.stateRoot, 'releases', f.payload.release.sha256, 'apps/server/src/store.ts'),
    'tampered',
  );
  await assert.rejects(new ManagedServerSupervisor(f.options).start(), /digest|inventory/i);
});
test('failed candidate rolls back program, retains candidate data and keeps cold backup', async (t) => {
  const f = setup(t, true),
    supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  await supervisor.prepare({
    clientProtocol: 42,
    confirmed: true,
    build: 2,
    sha256: f.payload.release.sha256,
  });
  await supervisor.activate();
  assert.equal((await supervisor.status()).phase, 'rolled-back');
  assert.equal((await supervisor.status()).current.build, 1);
  assert.equal(readFileSync(join(f.data, 'sessions.sqlite'), 'utf8'), 'candidate-write');
  assert.equal(
    readFileSync(join(supervisor.backupDirectory!, '0/sessions.sqlite'), 'utf8'),
    'original',
  );
  await supervisor.stop();
});
test('dependency, immutable hook and persistence changes require manual image upgrade', async (t) => {
  const f = setup(t);
  f.options.runtimeCheck = () => false;
  const supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  assert.equal((await supervisor.check(42)).reason, 'manual-image-upgrade');
  await supervisor.stop();
});
test('signed dependency, protected hook, data format or runtime changes report manual upgrade', async (t) => {
  const f = setup(t);
  let envelope = f.envelope;
  f.options.download = async () => Buffer.from(JSON.stringify(envelope));
  const supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  const variants = [
    { packageLockSha256: '0'.repeat(64) },
    {
      compatibility: {
        ...f.payload.release.compatibility,
        'apps/server/src/native-moderation-hook.ts': '0'.repeat(64),
      },
    },
    {
      compatibility: {
        ...f.payload.release.compatibility,
        'apps/server/src/store.ts': '0'.repeat(64),
      },
    },
    { runtimeLevel: 'node24-cli2.1.295-v2' },
  ];
  for (let i = 0; i < variants.length; i++) {
    envelope = signServerIndex(
      {
        ...f.payload,
        revision: 10 + i,
        release: {
          ...f.payload.release,
          build: 10 + i,
          sha256: String(i).repeat(64),
          ...variants[i],
        },
      },
      'test',
      f.keys.privateKey,
    );
    assert.equal((await supervisor.check(42)).reason, 'manual-image-upgrade');
  }
  await supervisor.stop();
});
test('crash journal rolls back program only and clean shutdown never respawns', async (t) => {
  const f = setup(t),
    supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  await supervisor.prepare({
    clientProtocol: 42,
    confirmed: true,
    build: 2,
    sha256: f.payload.release.sha256,
  });
  await supervisor.activate();
  await supervisor.stop();
  const journal = JSON.parse(readFileSync(join(f.options.stateRoot, 'journal.json'), 'utf8'));
  writeFileSync(
    join(f.options.stateRoot, 'journal.json'),
    JSON.stringify({ ...journal, phase: 'probing', target: f.envelope }),
  );
  const restarted = new ManagedServerSupervisor(f.options);
  await restarted.start();
  assert.equal((await restarted.status()).current.build, 1);
  assert.equal((await restarted.status()).phase, 'rolled-back');
  assert.equal(readFileSync(join(f.data, 'sessions.sqlite'), 'utf8'), 'candidate-write');
  await restarted.stop();
  const launches = f.events.filter((e) => e.startsWith('launch')).length;
  f.crash();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.events.filter((e) => e.startsWith('launch')).length, launches);
});
test('staging expiration or signature rotation aborts without switching program', async (t) => {
  const f = setup(t);
  let requests = 0;
  f.options.download = async (url: string) => {
    if (url.endsWith('.tar.gz')) return tar(f.files);
    requests++;
    return Buffer.from(
      JSON.stringify(
        requests === 1
          ? f.envelope
          : signServerIndex({ ...f.payload, revision: 3 }, 'test', f.keys.privateKey),
      ),
    );
  };
  const supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  await assert.rejects(
    supervisor.prepare({
      clientProtocol: 42,
      confirmed: true,
      build: 2,
      sha256: f.payload.release.sha256,
    }),
    /changed/i,
  );
  assert.equal((await supervisor.status()).current.build, 1);
  assert.equal(f.events.filter((e) => e.startsWith('launch')).length, 1);
  await supervisor.stop();
});
test('an installed candidate that fails readiness after container restart falls back to verified previous program', async (t) => {
  const f = setup(t);
  let fail = false;
  const launch = f.options.launch;
  f.options.launch = async (options) => {
    const child = await launch(options);
    return fail && options.current.sha256
      ? { ...child, ready: Promise.reject(new Error('bad restart')) }
      : child;
  };
  const supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  await supervisor.prepare({
    clientProtocol: 42,
    confirmed: true,
    build: 2,
    sha256: f.payload.release.sha256,
  });
  await supervisor.activate();
  await supervisor.stop();
  fail = true;
  const restarted = new ManagedServerSupervisor(f.options);
  await restarted.start();
  assert.equal((await restarted.status()).current.build, 1);
  assert.equal((await restarted.status()).phase, 'rolled-back');
  assert.equal(readFileSync(join(f.data, 'sessions.sqlite'), 'utf8'), 'candidate-write');
  await restarted.stop();
});
test('unexpected leader exit drains its old process group before relaunch', async (t) => {
  const f = setup(t),
    supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  f.crash();
  await new Promise((r) => setImmediate(r));
  const firstStop = f.events.indexOf('stop');
  assert.ok(
    firstStop >= 0 && firstStop < f.events.lastIndexOf('launch:1'),
    'Old process group must be stopped before a new leader launches',
  );
  await supervisor.stop();
});
for (const failDownload of [true, false])
  test(`leader exit during ${failDownload ? 'failed' : 'successful'} staging aborts owner and recovers service`, async (t) => {
    const f = setup(t);
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      finish = r;
    });
    const original = f.options.download;
    f.options.download = async (url) => {
      if (url.endsWith('.tar.gz')) {
        entered();
        await held;
        if (failDownload) throw new Error('offline');
      }
      return original(url);
    };
    const supervisor = new ManagedServerSupervisor(f.options);
    await supervisor.start();
    const preparation = supervisor.prepare({
      clientProtocol: 42,
      confirmed: true,
      build: 2,
      sha256: f.payload.release.sha256,
    });
    await started;
    f.crash();
    finish();
    await assert.rejects(preparation);
    await new Promise((r) => setImmediate(r));
    assert.equal(f.events.filter((e) => e === 'launch:1').length, 2);
    assert.equal((await supervisor.status()).target, null);
    await assert.rejects(supervisor.activate());
    await supervisor.stop();
  });
test('prepare deadline and prepared handoff lease cannot leave orphan activation', async (t) => {
  const f = setup(t);
  const original = f.options.download;
  let held = true;
  f.options.download = async (url) => {
    if (held && url.endsWith('.tar.gz')) return new Promise<ReturnType<typeof tar>>(() => {});
    return original(url);
  };
  const supervisor = new ManagedServerSupervisor({
    ...f.options,
    prepareTimeoutMs: 20,
    handoffTimeoutMs: 20,
  });
  await supervisor.start();
  await assert.rejects(
    supervisor.prepare({
      clientProtocol: 42,
      confirmed: true,
      build: 2,
      sha256: f.payload.release.sha256,
    }),
    /deadline|abort/i,
  );
  assert.equal((await supervisor.status()).target, null);
  assert.equal(f.events.filter((e) => e === 'cancel-maintenance').length, 1);
  await supervisor.stop();
  held = false;
  const handoff = new ManagedServerSupervisor({
    ...f.options,
    prepareTimeoutMs: 5000,
    handoffTimeoutMs: 20,
  });
  await handoff.start();
  await handoff.prepare({
    clientProtocol: 42,
    confirmed: true,
    build: 2,
    sha256: f.payload.release.sha256,
  });
  await new Promise((r) => setTimeout(r, 40));
  await assert.rejects(handoff.activate());
  assert.equal((await handoff.status()).target, null);
  assert.equal(f.events.filter((e) => e === 'cancel-maintenance').length, 2);
  await handoff.stop();
});

test('production startup readiness failures exhaust a durable launch budget across container restarts', async (t) => {
  const f = setup(t),
    launch = f.options.launch;
  f.options.launch = async (options) => ({
    ...(await launch(options)),
    ready: Promise.reject(new Error('startup readiness failed')),
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const supervisor = new ManagedServerSupervisor({ ...f.options, onUnexpectedExit: () => {} });
    await assert.rejects(supervisor.start(), /startup readiness failed/);
    assert.equal(
      JSON.parse(readFileSync(join(f.options.stateRoot, 'journal.json'), 'utf8')).attempts,
      attempt,
    );
    await supervisor.stop();
  }
  await assert.rejects(
    new ManagedServerSupervisor({ ...f.options, onUnexpectedExit: () => {} }).start(),
    /crash|restart/i,
  );
  assert.equal(f.events.filter((e) => e === 'launch:1').length, 3);
});
test('production unexpected exit persists finite crash floor and requires whole container teardown', async (t) => {
  const f = setup(t);
  let fatal!: () => void;
  const stopped = new Promise<void>((r) => {
    fatal = r;
  });
  const supervisor = new ManagedServerSupervisor({
    ...f.options,
    onUnexpectedExit: () => {
      fatal();
    },
  });
  await supervisor.start();
  f.crash();
  await stopped;
  assert.equal(f.events.filter((e) => e === 'launch:1').length, 1);
  const path = join(f.options.stateRoot, 'journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(journal.attempts, 1);
  writeFileSync(path, JSON.stringify({ ...journal, attempts: 3 }));
  await assert.rejects(
    new ManagedServerSupervisor({ ...f.options, onUnexpectedExit: () => {} }).start(),
    /crash|restart/i,
  );
  await supervisor.stop();
});
test('backup includes external CLI configuration, deduplicates roots and excludes managed state below data', async (t) => {
  const f = setup(t),
    external = join(f.root, 'external-claude');
  mkdirSync(external);
  writeFileSync(join(external, 'settings.json'), 'native-config');
  f.options.stateRoot = join(f.data, 'managed');
  f.options.dataDirectories = selectBackupDirectories(
    [f.data, join(f.data, 'nested'), external, external],
    f.options.stateRoot,
  );
  assert.equal(f.options.dataDirectories.length, 2);
  assert.deepEqual(
    selectBackupDirectories([f.root, join(f.root, '..config')], f.options.stateRoot),
    [f.root],
  );
  const supervisor = new ManagedServerSupervisor(f.options);
  await supervisor.start();
  await supervisor.prepare({
    clientProtocol: 42,
    confirmed: true,
    build: 2,
    sha256: f.payload.release.sha256,
  });
  await supervisor.activate();
  const dataIndex = f.options.dataDirectories.indexOf(f.data),
    configIndex = f.options.dataDirectories.indexOf(external);
  assert.equal(
    readFileSync(join(supervisor.backupDirectory!, String(configIndex), 'settings.json'), 'utf8'),
    'native-config',
  );
  assert.equal(existsSync(join(supervisor.backupDirectory!, String(dataIndex), 'managed')), false);
  await supervisor.stop();
});
