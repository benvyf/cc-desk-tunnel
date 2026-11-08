#!/usr/bin/env python3
"""Cut over the confirmed ubuntu-cc pilot; retain a complete offline rollback."""

import argparse
import copy
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/var/lib/cc-space-037-upgrade')
DATA = Path('/srv/cc-desk-tunnel')
BASE = 'sha256:365918cb8abf4f4b784502a6bbabeda5704dc928e5c899438199776001b1adb2'
IMAGE = 'cc-space-preview:0.3.7-build4'
DESCRIPTOR = '27876f345c2992abf77b925686aedee2af9b151babeef46af2486afb361009ac'
TARGET = {'build': 4, 'protocol': 21}
NODE = 'ubuntu-cc'
REBUILT_NODES = {
    'ubuntu-cc-02': {
        'container': 'cc-desk-tunnel-96ccb91a-proxy-1',
        'image': 'sha256:cb3822893e9da5bd3c21c68810309b9238c263e2a227c5207d875b12f5484697',
        'policy': '/var/lib/cc-node-rebuild-ubuntu-cc-02/policy',
    },
    'ubuntu-cc-03': {
        'container': 'cc-desk-tunnel-4b35c593-proxy-1',
        'image': 'sha256:ae2d8b77a5dde6bced39f93ffcbe281def8f117c9b262b69580a0cd4faa40aca',
        'policy': '/var/lib/cc-node-rebuild-ubuntu-cc-03/policy',
    },
}
REBUILT_DESCRIPTOR = 'fc8afc4c71fe556135fc356aca8186a104943afe021fdc27bd4f43d41a86cad6'
HELPER_SHA = '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0'
HELPER_URL = 'https://raw.githubusercontent.com/benvyf/cc-desk-tunnel/2913675e8131604cb65a9291337791f3efc9327b/apps/update-service/web/server-bootstrap.py'


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def select_node(node):
    global NODE
    if node != 'ubuntu-cc' and node not in REBUILT_NODES:
        raise RuntimeError('Unsupported host; no upgrade requested')
    NODE = node
    return REBUILT_NODES.get(node)


def configure_helper(module):
    profile = REBUILT_NODES.get(NODE)
    if not profile:
        return module
    module.CONTAINER = profile['container']
    reviewed_validate = module.validate_runtime
    def validate(original):
        # Reuse all pinned runtime constraints; only the confirmed policy source differs.
        policy = [m for m in original.get('Mounts', []) if m['Destination'] == '/etc/claude-code']
        if len(policy) != 1 or policy[0]['Source'] != profile['policy']:
            raise RuntimeError('The confirmed node policy mount changed')
        normalized = copy.deepcopy(original)
        for mount in normalized.get('Mounts', []):
            if mount['Destination'] == '/etc/claude-code':
                mount['Source'] = '/etc/claude-code'
        reviewed_validate(normalized)
    module.validate_runtime = validate
    return module


def helper(path, download=False):
    if not path.exists() and download:
        with urllib.request.urlopen(HELPER_URL, timeout=30) as response:
            content = response.read(128 * 1024)
        if hashlib.sha256(content).hexdigest() != HELPER_SHA:
            raise RuntimeError('Reviewed helper digest mismatch')
        path.write_bytes(content)
    if digest(path) != HELPER_SHA:
        raise RuntimeError('Reviewed helper digest mismatch')
    spec = importlib.util.spec_from_file_location('reviewed_bootstrap', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return configure_helper(module)


def private_command(args, backup):
    with open(backup / 'operations.log', 'ab') as log:
        subprocess.run(args, check=True, stdout=log, stderr=log, timeout=300)


def save(b, backup, record):
    b.durable_json(backup / 'record.json', record)


def sync_file(path):
    with path.open('rb+') as stream:
        os.fsync(stream.fileno())


def sync_directory(path):
    if os.name == 'posix':
        descriptor = os.open(path, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)


def directory_identity(path):
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError('Expected a physical recovery directory: ' + str(path))
    info = path.stat()
    return {'device': info.st_dev, 'inode': info.st_ino}


def same_directory(path, identity):
    if not identity or path.is_symlink() or not path.is_dir():
        return False
    return directory_identity(path) == identity


def present(path):
    return path.exists() or path.is_symlink()


def sync_tree(root):
    directories = [root]
    for path in root.rglob('*'):
        if path.is_symlink():
            continue
        if path.is_dir():
            directories.append(path)
        elif path.is_file():
            with path.open('rb' if os.name == 'posix' else 'rb+') as stream:
                os.fsync(stream.fileno())
    for directory in sorted(directories, key=lambda p: len(p.parts), reverse=True):
        sync_directory(directory)


def prepare_restore(b, backup, record):
    archive = backup / 'data.tar.gz'
    if digest(archive) != record['archiveSha256']:
        raise RuntimeError('Cold backup digest mismatch; data left untouched')
    preserved = DATA.with_name(DATA.name + '.after-' + backup.name)
    plan = record.get('restore')
    if not plan:
        if present(preserved):
            raise RuntimeError('Unrecorded preserved data already exists; inspect rollback before retry')
        candidate = directory_identity(DATA)
        stage = Path(tempfile.mkdtemp(prefix='.cc-space-037-restore-', dir=str(DATA.parent)))
        sync_directory(DATA.parent)
        plan = {'stage': str(stage), 'stageIdentity': directory_identity(stage),
                'preserved': str(preserved), 'candidateIdentity': candidate, 'state': 'extracting'}
        record['restore'] = plan
        record['phase'] = 'restoring'
        save(b, backup, record)
    stage = Path(plan['stage'])
    if (not stage.is_absolute() or stage.parent.resolve() != DATA.parent.resolve() or
            not stage.name.startswith('.cc-space-037-restore-') or
            not same_directory(stage, plan.get('stageIdentity')) or plan.get('preserved') != str(preserved)):
        raise RuntimeError('Recovery staging identity changed; data left untouched')
    if present(preserved) and not same_directory(preserved, plan.get('candidateIdentity')):
        raise RuntimeError('Unknown preserved data directory; data left untouched')
    if present(DATA) and not (same_directory(DATA, plan.get('candidateIdentity')) or
                              same_directory(DATA, plan.get('restoredIdentity'))):
        raise RuntimeError('Unknown current data directory; data left untouched')
    restored = stage / 'data'
    if plan['state'] == 'extracting':
        if not same_directory(DATA, plan['candidateIdentity']) or present(preserved):
            raise RuntimeError('Recovery extraction state differs; data left untouched')
        with tarfile.open(archive, 'r:gz') as content:
            required = sum(member.size for member in content if member.isfile()) + 512 * 1024**2
        free = shutil.disk_usage(DATA.parent).free
        if free < required:
            raise RuntimeError(f'Insufficient recovery space: required={required}; available={free}; missing={required-free} bytes; candidate service not stopped')
        private_command(['tar', '-xpf', str(archive), '--numeric-owner', '-C', str(stage)], backup)
        verify_cold_backup(archive, data=restored)
        sync_tree(restored)
        sync_directory(stage)
        sync_directory(DATA.parent)
        plan['restoredIdentity'] = directory_identity(restored)
        plan['state'] = 'prepared'
        save(b, backup, record)
    elif plan['state'] not in ('prepared', 'restored'):
        raise RuntimeError('Unknown recovery state; data left untouched')
    if same_directory(DATA, plan['restoredIdentity']):
        if not same_directory(preserved, plan['candidateIdentity']):
            raise RuntimeError('Preserved candidate data is missing; inspect recovery')
        verify_cold_backup(archive, data=DATA)
    else:
        if not same_directory(restored, plan['restoredIdentity']):
            raise RuntimeError('Prepared recovery data changed; data left untouched')
        if not (same_directory(DATA, plan['candidateIdentity']) and not present(preserved) or
                not present(DATA) and same_directory(preserved, plan['candidateIdentity'])):
            raise RuntimeError('Recovery directories differ; data left untouched')
        verify_cold_backup(archive, data=restored)
    return stage, preserved


def restore_data(b, backup, record):
    plan = record['restore']
    stage, preserved = prepare_restore(b, backup, record)
    if not same_directory(DATA, plan['restoredIdentity']):
        if same_directory(DATA, plan['candidateIdentity']):
            DATA.rename(preserved)
            sync_directory(DATA.parent)
        (stage / 'data').rename(DATA)
        sync_directory(DATA.parent)
        sync_directory(stage)
    plan['state'] = 'restored'
    record['preservedNewData'] = str(preserved)
    record['dataChanged'] = False
    save(b, backup, record)


def rollback(b, backup):
    record = json.loads((backup / 'record.json').read_text())
    original = json.loads((backup / 'original.json').read_text())
    engine = b.Engine()
    replacement, current = b.recovery_container(engine, backup, original)
    if record['phase'] == 'rolled-back':
        if current and current['Id'] == original['Id'] and current['State']['Running']:
            print('Already rolled back; original container is running.')
            return
        raise RuntimeError('Rollback record and current container differ')
    if record.get('dataChanged'):
        old = engine.request('GET', '/containers/' + original['Id'] + '/json')
        if old['State'].get('Running'):
            raise RuntimeError('Original container is running; stop it before restoring the cold backup')
        # Validate and prepare recovery while the current service can still run.
        # Space/integrity failures must not stop the candidate first.
        prepare_restore(b, backup, record)
    if replacement:
        candidate = engine.request('GET', '/containers/' + replacement + '/json')
        isolated = False
        if candidate['State'].get('Running'):
            was_paused = candidate['State'].get('Paused', False)
            if not was_paused:
                engine.request('POST', '/containers/' + replacement + '/pause')
            try:
                processes = engine.request('GET', '/containers/' + replacement + '/top?ps_args=-eo%20pid,args')['Processes']
                if busy(b, processes):
                    raise RuntimeError('Finish Claude tasks and close clients before rollback')
                b.frozen_idle(candidate)
                for name in candidate['NetworkSettings']['Networks']:
                    engine.request('POST', '/networks/' + b.urllib.parse.quote(name, safe='') + '/disconnect', {'Container': replacement, 'Force': True})
                isolated = True
            except BaseException:
                if not was_paused:
                    engine.request('POST', '/containers/' + replacement + '/unpause')
                raise
            else:
                engine.request('POST', '/containers/' + replacement + '/unpause')
        engine.request('POST', '/containers/' + replacement + '/update', {'RestartPolicy': {'Name': 'no'}})
        if candidate['State'].get('Running'):
            engine.request('POST', '/containers/' + replacement + '/stop?t=30')
        if not isolated:
            for name in candidate['NetworkSettings']['Networks']:
                engine.request('POST', '/networks/' + b.urllib.parse.quote(name, safe='') + '/disconnect', {'Container': replacement, 'Force': True})
        engine.request('POST', '/containers/' + replacement + '/rename?name=' + b.CONTAINER + '-failed-' + backup.name)
    # A stopped original can still be paused if interruption occurred at the first admission check.
    old = engine.request('GET', '/containers/' + original['Id'] + '/json')
    if old['State'].get('Paused'):
        engine.request('POST', '/containers/' + original['Id'] + '/unpause')
    if record.get('dataChanged'):
        if old['State'].get('Running'):
            raise RuntimeError('Original container is running; stop it before restoring the cold backup')
        restore_data(b, backup, record)
    b.restore(engine, original)
    b.wait_healthy(engine, original['Id'])
    record['phase'] = 'rolled-back'
    save(b, backup, record)
    print('ROLLED_BACK: original container and pre-upgrade data restored; new data retained separately.')


def busy(b, processes):
    # The current supervisor runs its business server in a child; it is not an SDK worker.
    return b.busy([[cell.replace('/apps/server/src/managed-server-child.ts', '/apps/server/src/managed-server-main.ts') for cell in row] for row in processes])


def check_space(reserve=512 * 1024 * 1024):
    if DATA.is_mount() or DATA.stat().st_dev != DATA.parent.stat().st_dev:
        raise RuntimeError('Data mountpoint is unsupported by the offline rollback rename; no cutover')
    size = sum(p.stat().st_size for p in DATA.rglob('*') if p.is_file() and not p.is_symlink())
    shared = ROOT.stat().st_dev == DATA.stat().st_dev
    targets = [('backup/recovery', ROOT, size * 2 + reserve)] if shared else [
        ('backup', ROOT, size + reserve), ('recovery', DATA.parent, size + reserve)]
    for stage, path, required in targets:
        free = shutil.disk_usage(path).free
        print(f'SPACE: {stage}; path={path}; required={required}; available={free}; missing={max(0, required-free)} bytes; required={required/1024**3:.2f} GiB; available={free/1024**3:.2f} GiB', flush=True)
        if free < required:
            raise RuntimeError(f'Insufficient {stage} space: required={required}; available={free}; missing={required-free} bytes; no cutover; original service left running')


def frozen_tasks_idle(b, engine, original):
    if busy(b, engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20pid,args')['Processes']):
        raise RuntimeError('Finish Claude tasks and close native terminals before upgrading; original service left running')
    database = DATA / 'state/sessions.sqlite'
    if not database.is_file():
        raise RuntimeError('Expected local session state is missing')
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
        if any(json.loads(row[0]).get('activeRun') for row in db.execute('SELECT metadata FROM sessions')):
            raise RuntimeError('Finish Claude tasks, including waiting runs, before upgrading; original service left running')


def check_idle(b, original):
    # An observational early check avoids leaving an unjournaled pause if this
    # process is killed. install() freezes and rechecks before the actual cutover.
    frozen_tasks_idle(b, b.Engine(), original)


def verify_cold_backup(path, data=None):
    sync_file(path)
    data = DATA if data is None else data
    expected = {'data'} | {'data/' + p.relative_to(data).as_posix() for p in data.rglob('*')}
    seen = set()
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            parts = Path(member.name).parts
            if not parts or parts[0] != 'data' or '..' in parts:
                raise RuntimeError('Cold backup contains an unexpected path')
            if member.name in seen:
                raise RuntimeError('Cold backup contains duplicate entries')
            seen.add(member.name)
            source = data.joinpath(*parts[1:])
            if member.isfile() or member.islnk():
                checksum = hashlib.sha256()
                with archive.extractfile(member) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        checksum.update(block)
                if source.is_symlink() or checksum.hexdigest() != digest(source):
                    raise RuntimeError('Cold backup does not match source data')
            elif member.issym() and (not source.is_symlink() or os.readlink(source) != member.linkname):
                raise RuntimeError('Cold backup link differs from source data')
    if seen != expected:
        raise RuntimeError('Cold backup inventory differs from source data')


def install(b, disconnect_clients=False):
    engine = b.Engine()
    if DATA.is_symlink() or not DATA.is_dir():
        raise RuntimeError('Expected physical data directory is missing')
    original = engine.request('GET', '/containers/' + b.CONTAINER + '/json')
    b.validate_runtime(original)
    if original['Image'] != BASE:
        raise RuntimeError('The confirmed original image changed')
    b.runtime_and_policy(b.CONTAINER)
    candidate = engine.request('GET', '/images/' + b.urllib.parse.quote(IMAGE, safe='') + '/json')['Id']
    check = "const f=require('fs'),c=require('crypto'),a=require('assert/strict');a.equal(c.createHash('sha256').update(f.readFileSync('/app/SERVER-RELEASE.json')).digest('hex'),process.argv[1]);a.equal(c.createHash('sha256').update(f.readFileSync('/opt/runtime/cli/bin/claude')).digest('hex'),'4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358');"
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint', '/opt/runtime/node/bin/node', candidate, '-e', check, DESCRIPTOR], check=True, timeout=30, capture_output=True)
    check_space()
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + os.urandom(4).hex()
    backup = ROOT / ('backup-' + stamp)
    backup.mkdir(mode=0o700)
    sync_directory(ROOT)
    rollback_source = Path(__file__).read_text().replace("ROOT = Path('/var/lib/cc-space-037-upgrade')", 'ROOT = Path(' + repr(str(ROOT)) + ')')
    rollback_source = rollback_source.replace("NODE = 'ubuntu-cc'", 'NODE = ' + repr(NODE))
    (backup / 'rollback.py').write_text(rollback_source)
    shutil.copyfile(ROOT / 'helper.py', backup / 'helper.py')
    sync_file(backup / 'rollback.py')
    sync_file(backup / 'helper.py')
    b.durable_json(backup / 'original.json', original)
    record = {'phase': 'prepared', 'dataChanged': False, 'backup': str(backup)}
    save(b, backup, record)
    print('Backup and offline rollback directory: ' + str(backup), flush=True)
    print('Rollback command: sudo python3 ' + str(backup / 'rollback.py') + ' --rollback ' + str(backup), flush=True)
    paused = False
    changed = False
    try:
        record['phase'] = 'admission'
        save(b, backup, record)
        engine.request('POST', '/containers/' + original['Id'] + '/pause')
        paused = True
        if busy(b, engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20pid,args')['Processes']):
            raise RuntimeError('Finish Claude tasks and close clients before upgrading')
        if disconnect_clients:
            # The container is frozen: no new run can start between this check
            # and network isolation. Idle client sockets will be closed by stop.
            frozen_tasks_idle(b, engine, original)
        else:
            b.frozen_idle(original)
        # Freeze closes the race with task/data growth during preparation.
        check_space()
        if getattr(b, 'validate_cutover', None):
            b.validate_cutover(engine.request('GET', '/containers/' + original['Id'] + '/json'))
        changed = True
        record['phase'] = 'stopping'
        save(b, backup, record)
        engine.request('POST', '/containers/' + original['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
        for name in b.endpoints(original):
            engine.request('POST', '/networks/' + b.urllib.parse.quote(name, safe='') + '/disconnect', {'Container': original['Id'], 'Force': True})
        engine.request('POST', '/containers/' + original['Id'] + '/unpause')
        paused = False
        engine.request('POST', '/containers/' + original['Id'] + '/stop?t=30')
        if disconnect_clients:
            print('CLIENTS_DISCONNECTED: service stopped; reconnection blocked until upgrade or rollback completes.', flush=True)
        print('Creating full cold backup; keep this terminal open.', flush=True)
        with tarfile.open(backup / 'data.tar.gz', 'w:gz', dereference=False) as archive:
            archive.add(DATA, arcname='data')
        verify_cold_backup(backup / 'data.tar.gz')
        record['archiveSha256'] = digest(backup / 'data.tar.gz')
        record['phase'] = 'backed-up'
        save(b, backup, record)
        print('BACKUP_VERIFIED: full cold backup and SHA256 recorded.', flush=True)
        engine.request('POST', '/containers/' + original['Id'] + '/rename?name=' + b.CONTAINER + '-before-' + stamp)
        record['dataChanged'] = True
        save(b, backup, record)
        state = DATA / 'managed-server'
        if state.exists():
            state.rename(DATA / ('managed-server.before-' + stamp))
        state.mkdir(mode=0o700)
        os.chown(state, 1000, 1000)
        intent = {'image': candidate, 'nonce': os.urandom(16).hex(), 'originalId': original['Id']}
        b.durable_json(backup / 'replacement-intent.json', intent)
        config = b.clone_config(original, candidate)
        config['Labels'] = {**(config.get('Labels') or {}), 'org.cc-desk-tunnel.bootstrap': intent['nonce']}
        replacement = engine.request('POST', '/containers/create?name=' + b.CONTAINER, config)['Id']
        b.durable_json(backup / 'replacement-record.json', {'id': replacement})
        record['phase'] = 'starting'
        save(b, backup, record)
        engine.request('POST', '/containers/' + replacement + '/start')
        b.wait_healthy(engine, replacement)
        b.live_status(b.CONTAINER, {**TARGET, 'descriptorSha256': DESCRIPTOR})
        record['phase'] = 'installed'
        record['containerId'] = replacement
        record['imageId'] = candidate
        save(b, backup, record)
    except BaseException:
        if paused:
            engine.request('POST', '/containers/' + original['Id'] + '/unpause')
            if not changed:
                record['phase'] = 'prepared'
                save(b, backup, record)
        if changed:
            print('Cutover did not complete; attempting rollback.', flush=True)
            rollback(b, backup)
        raise
    print('UPGRADE_OK: Linux Build ' + str(TARGET['build']) + ' / protocol ' + str(TARGET['protocol']) + '; original image, container and cold backup retained.')
    print('Rollback command: sudo python3 ' + str(backup / 'rollback.py') + ' --rollback ' + str(backup))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--install', action='store_true')
    action.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or socket.gethostname().split('.')[0] != NODE:
        parser.error('Run with sudo on the confirmed ' + NODE + ' host')
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o077:
        raise RuntimeError('Unsafe private backup directory')
    import fcntl
    with open(ROOT / 'upgrade.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.rollback:
            backup = args.rollback.resolve()
            if backup.parent != ROOT or not backup.name.startswith('backup-'):
                raise RuntimeError('Unexpected rollback directory')
            b = helper(backup / 'helper.py')
            rollback(b, backup)
        else:
            install(helper(ROOT / 'helper.py', download=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        if isinstance(error, SystemExit):
            raise
        reason = str(error) if isinstance(error, RuntimeError) or type(error).__name__ == 'InstallError' else type(error).__name__
        print('Upgrade stopped: ' + reason + '. Check the printed backup directory; do not delete it.', file=sys.stderr)
        sys.exit(1)
