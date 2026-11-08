#!/usr/bin/env python3
"""Verified retention of the current installation's previous cold-backup payload.

Keep the rollback that created the current healthy installation, all container
mounts, and every image/container. Never run Claude or touch live account data.
The manual CLI is restricted to ubuntu-cc; the signed updater passes its already
authorized node's container while holding the same upgrade lock.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess

CONTAINER = 'cc-desk-tunnel-ba938975-proxy-1'
UPGRADE = Path('/var/lib/cc-runtime-upgrade')
LEGACY = [
    ('cc-desk-tunnel-pilot-4a39bc3', 'production-backup'),
    ('cc-monitor-install', 'backup-*'),
    ('cc-server-bootstrap', 'backup-*'),
    ('cc-native-terminal-pilot-85876c41ffce', 'activation/backup'),
    ('cc-native-terminal-paths-ff5743958cb8', 'activation/backup'),
    ('cc-moderation-pilot-2638731374c8', 'activation-backup'),
    ('cc-space-037-upgrade', 'backup-*'),
    ('cc-space-terminal-upgrade', 'backup-*'),
    ('cc-message-review-upgrade', 'backup-*'),
    ('cc-runtime-upgrade', 'backup-*'),
]
PAYLOADS = ('data.tar', 'data.tar.gz', 'old-image.tar', 'source-config.tar')


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def physical(path):
    need(path.is_absolute() and path.resolve() == path, 'Linked or unexpected path: ' + str(path))


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=30)


def inventory():
    ids = docker('ps', '-aq').split()
    result = []
    for start in range(0, len(ids), 64):
        result.extend(json.loads(docker('inspect', *ids[start:start + 64])))
    return result


def identity(container):
    return container['Id'], container['Image'], container['State']['StartedAt']


def references(containers):
    # Healthcheck timestamps change while the service runs; compare resource identities instead.
    return sorted((identity(c), c['Name'], c['State']['Status'],
                   c['State'].get('Paused', False),
                   json.dumps(c.get('Mounts', []), sort_keys=True)) for c in containers)


def preserved_rollback(containers, root=UPGRADE, container_name=CONTAINER):
    current = next(c for c in containers if c['Name'] == '/' + container_name)
    need(current['State'].get('Running') and not current['State'].get('Paused') and
         current['State'].get('Health', {}).get('Status') == 'healthy',
         'Current production container must be healthy and running')
    matches = []
    for directory in root.glob('backup-*'):
        physical(directory)
        record = json.loads((directory / 'record.json').read_bytes())
        need(record.get('phase') in ('installed', 'rolled-back', 'prepared'),
             'Unresolved upgrade record: ' + str(directory))
        need(record.get('phase') != 'prepared' or not record.get('dataChanged'),
             'Unresolved prepared cutover: ' + str(directory))
        if record.get('phase') == 'installed' and record.get('containerId') == current['Id']:
            need(record.get('imageId') == current['Image'], 'Current image differs from installation record')
            matches.append((directory, record))
    need(len(matches) == 1, 'Cannot identify exactly one rollback for the current installation')
    directory, record = matches[0]
    original_file = directory / 'original.json'
    physical(original_file)
    original = json.loads(original_file.read_bytes())
    rollback = next((c for c in containers if c['Id'] == original['Id']), None)
    need(rollback is not None and rollback['Image'] == original['Image'] and
         rollback['State']['Status'] == 'exited', 'Required rollback container is unavailable')
    for name in ('data.tar.gz', 'rollback.py', 'helper.py'):
        path = directory / name
        physical(path)
        need(path.is_file(), 'Required rollback file missing: ' + str(path))
    archive = directory / 'data.tar.gz'
    actual = digest(archive)
    need(record.get('archiveSha256') == actual,
         f'Required cold-backup checksum does not match: path={archive}; '
         f'expected={record.get("archiveSha256")}; actual={actual}')
    return current, directory


def plan(containers, keep, base=Path('/var/lib')):
    mounts = [Path(mount['Source']).resolve() for c in containers for mount in c.get('Mounts', [])
              if mount.get('Source')]
    targets, skipped = [], []
    for root_name, pattern in LEGACY:
        root = base / root_name
        if not root.exists():
            continue
        physical(root)
        for backup in root.glob(pattern):
            physical(backup)
            if not backup.is_dir() or backup == keep:
                continue
            # A mount inside the backup, or a mount of its ancestor, protects it.
            if any(p == backup or p in backup.parents or backup in p.parents for p in mounts):
                skipped.append(str(backup))
                continue
            record = backup / 'record.json'
            if record.exists():
                physical(record)
                value = json.loads(record.read_bytes())
                need(value.get('phase') in ('installed', 'rolled-back', 'prepared'),
                     'Unresolved historical backup: ' + str(backup))
                need(value.get('phase') != 'prepared' or not value.get('dataChanged'),
                     'Unresolved historical cutover: ' + str(backup))
            for name in PAYLOADS:
                path = backup / name
                if not path.exists():
                    continue
                physical(path)
                info = path.lstat()
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                     'Expected independent regular backup payload: ' + str(path))
                targets.append({'path': str(path), 'size': info.st_size,
                                'device': info.st_dev, 'inode': info.st_ino,
                                'mtime': info.st_mtime_ns})
    return targets, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Retire only the validated payload plan')
    args = parser.parse_args()
    need(os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc',
         'Run with sudo on ubuntu-cc only')
    physical(UPGRADE)
    import fcntl
    lock_path = UPGRADE / 'upgrade.lock'
    physical(lock_path)
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        retire(UPGRADE, apply=args.apply)


def retire(root, container_name=CONTAINER, apply=False):
    # Caller holds upgrade.lock for the entire plan and deletion operation.
    physical(root)
    containers = inventory()
    current, keep = preserved_rollback(containers, root, container_name)
    targets, skipped = plan(containers, keep)
    print('KEEP: current healthy service and verified rollback: ' + str(keep), flush=True)
    print('PLAN: ' + str(len(targets)) + ' superseded backup payloads; logical bytes=' +
          str(sum(item['size'] for item in targets)), flush=True)
    print(json.dumps({'targets': targets, 'mountedBackupsPreserved': skipped}), flush=True)
    if not apply:
        print('READ_ONLY: add --apply to retire the listed historical backup payloads')
        return
    # Recheck the whole reference set, not just the currently running container.
    latest = inventory()
    need(references(latest) == references(containers), 'Container inventory changed; rerun cleanup')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    log = root / ('retirement-' + stamp + '.json')
    report = {'current': identity(current), 'keptRollback': str(keep), 'targets': targets,
              'removed': [], 'state': 'started'}
    with log.open('x') as stream:
        os.chmod(log, 0o600)
        json.dump(report, stream)
    for item in targets:
        path = Path(item['path'])
        physical(path)
        info = path.lstat()
        need((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_nlink) ==
             (item['device'], item['inode'], item['size'], item['mtime'], 1),
             'Payload changed; remaining cleanup stopped: ' + str(path))
        marker = path.parent / 'RETIRED-BACKUP.json'
        physical(marker)
        marker.write_text(json.dumps({'reason': 'User retired superseded historical rollback payloads',
                                     'keptRollback': str(keep), 'audit': str(log)}) + '\n')
        path.unlink()
        report['removed'].append(str(path))
        log.write_text(json.dumps(report) + '\n')
    report['state'] = 'completed'
    log.write_text(json.dumps(report) + '\n')
    print('DONE: superseded payloads retired; old rollback metadata/logs kept; no images, containers or live data deleted.')
    print('AUDIT: ' + str(log))
    subprocess.run(['df', '-h', '/'], check=True)


if __name__ == '__main__':
    main()
