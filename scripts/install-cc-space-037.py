#!/usr/bin/env python3
"""Cut over the confirmed ubuntu-cc pilot; retain a complete offline rollback."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
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
HELPER_SHA = '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0'
HELPER_URL = 'https://raw.githubusercontent.com/benvyf/cc-desk-tunnel/2913675e8131604cb65a9291337791f3efc9327b/apps/update-service/web/server-bootstrap.py'


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


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
    return module


def private_command(args, backup):
    with open(backup / 'operations.log', 'ab') as log:
        subprocess.run(args, check=True, stdout=log, stderr=log, timeout=300)


def save(b, backup, record):
    b.durable_json(backup / 'record.json', record)


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
    if replacement:
        candidate = engine.request('GET', '/containers/' + replacement + '/json')
        if candidate['State'].get('Running'):
            engine.request('POST', '/containers/' + replacement + '/pause')
            try:
                processes = engine.request('GET', '/containers/' + replacement + '/top?ps_args=-eo%20pid,args')['Processes']
                if busy(b, processes):
                    raise RuntimeError('Finish Claude tasks and close clients before rollback')
                b.frozen_idle(candidate)
            finally:
                engine.request('POST', '/containers/' + replacement + '/unpause')
        engine.request('POST', '/containers/' + replacement + '/update', {'RestartPolicy': {'Name': 'no'}})
        if candidate['State'].get('Running'):
            engine.request('POST', '/containers/' + replacement + '/stop?t=30')
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
        archive = backup / 'data.tar.gz'
        if digest(archive) != record['archiveSha256']:
            raise RuntimeError('Cold backup digest mismatch; data left untouched')
        stage = Path(tempfile.mkdtemp(prefix='.cc-space-037-restore-', dir=str(DATA.parent)))
        private_command(['tar', '-xpf', str(archive), '--numeric-owner', '-C', str(stage)], backup)
        preserved = DATA.with_name(DATA.name + '.after-' + backup.name)
        if preserved.exists():
            raise RuntimeError('Preserved new data already exists; inspect rollback before retry')
        if DATA.exists():
            DATA.rename(preserved)
        (stage / 'data').rename(DATA)
        record['preservedNewData'] = str(preserved)
        record['dataChanged'] = False
        save(b, backup, record)
    b.restore(engine, original)
    b.wait_healthy(engine, original['Id'])
    record['phase'] = 'rolled-back'
    save(b, backup, record)
    print('ROLLED_BACK: original container and pre-upgrade data restored; new data retained separately.')


def busy(b, processes):
    # The current supervisor runs its business server in a child; it is not an SDK worker.
    return b.busy([[cell.replace('/apps/server/src/managed-server-child.ts', '/apps/server/src/managed-server-main.ts') for cell in row] for row in processes])


def install(b):
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
    size = sum(p.stat().st_size for p in DATA.rglob('*') if p.is_file() and not p.is_symlink())
    if shutil.disk_usage(ROOT).free < size * 2 + 512 * 1024 * 1024:
        raise RuntimeError('Insufficient free space for backup and recovery')
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + os.urandom(4).hex()
    backup = ROOT / ('backup-' + stamp)
    backup.mkdir(mode=0o700)
    rollback_source = Path(__file__).read_text().replace("ROOT = Path('/var/lib/cc-space-037-upgrade')", 'ROOT = Path(' + repr(str(ROOT)) + ')')
    (backup / 'rollback.py').write_text(rollback_source)
    shutil.copyfile(ROOT / 'helper.py', backup / 'helper.py')
    b.durable_json(backup / 'original.json', original)
    record = {'phase': 'prepared', 'dataChanged': False, 'backup': str(backup)}
    save(b, backup, record)
    print('Backup and offline rollback directory: ' + str(backup), flush=True)
    print('Rollback command: sudo python3 ' + str(backup / 'rollback.py') + ' --rollback ' + str(backup), flush=True)
    paused = False
    changed = False
    try:
        engine.request('POST', '/containers/' + original['Id'] + '/pause')
        paused = True
        if busy(b, engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20pid,args')['Processes']):
            raise RuntimeError('Finish Claude tasks and close clients before upgrading')
        b.frozen_idle(original)
        changed = True
        record['phase'] = 'stopping'
        save(b, backup, record)
        engine.request('POST', '/containers/' + original['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
        for name in b.endpoints(original):
            engine.request('POST', '/networks/' + b.urllib.parse.quote(name, safe='') + '/disconnect', {'Container': original['Id'], 'Force': True})
        engine.request('POST', '/containers/' + original['Id'] + '/unpause')
        paused = False
        engine.request('POST', '/containers/' + original['Id'] + '/stop?t=30')
        print('Creating full cold backup; keep this terminal open.', flush=True)
        with tarfile.open(backup / 'data.tar.gz', 'w:gz', dereference=False) as archive:
            archive.add(DATA, arcname='data')
        record['archiveSha256'] = digest(backup / 'data.tar.gz')
        record['phase'] = 'backed-up'
        save(b, backup, record)
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
    if os.geteuid() != 0 or socket.gethostname().split('.')[0] != 'ubuntu-cc':
        parser.error('Run with sudo on the confirmed ubuntu-cc host')
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
