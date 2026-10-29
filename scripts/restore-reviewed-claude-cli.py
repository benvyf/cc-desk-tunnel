#!/usr/bin/env python3
"""Historical 2026-10-24 one-node repair of the pinned 2.1.295 CLI.

Not a general upgrade command: the exact original container and hashes are required.
Never executes Claude.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import tarfile
import tempfile

CONTAINER = 'cc-desk-tunnel-ba938975-proxy-1'
ARCHIVE = pathlib.Path('/var/lib/cc-native-terminal-pilot-85876c41ffce/claude-code-linux-x64-2.1.295.tgz')
ARCHIVE_SHA = 'd45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95'
OFFICIAL_SHA = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
OBSERVED_SHA = 'f66a66b89fa1c229ff9edce0065277a2d0897ebd6710f6d3e8b722c6e1d9ec2e'
DATABASE = pathlib.Path('/srv/cc-desk-tunnel/state/sessions.sqlite')
BACKUPS = pathlib.Path('/var/lib/cc-cli-official-restore')
CLI = '/opt/runtime/cli/bin/claude'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, timeout=60)
    require(result.returncode == 0, 'Docker operation failed: ' + args[0])
    return result.stdout


def inspect(container):
    return json.loads(docker('inspect', container))[0]


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def idle(container):
    text = docker('top', container['Id'], '-eo', 'pid,args').decode()
    for line in text.splitlines()[1:]:
        require(not re.search(r'(?i)(claude|anthropic|[/\\]cli\.js)', line), 'Claude-related process exists; close clients and retry.')
        allowed = ('apps/server/src/main.ts', 'apps/server/src/managed-main.ts',
                   'apps/server/src/managed-server-main.ts', '/app/healthcheck.mjs')
        require(not re.search(r'(^|[ /])node(?:js)?(?:\s|$)', line) or any(p in line for p in allowed),
                'Unknown Node process exists; restoration refused.')
    for name in ('tcp', 'tcp6'):
        lines = pathlib.Path('/proc/%s/net/%s' % (container['State']['Pid'], name)).read_text().splitlines()[1:]
        require(all(line.split()[3] != '01' for line in lines), 'Active connection exists; close CC clients and retry.')
    require(DATABASE.is_file(), 'Expected session database is missing.')
    with sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
        require(not any(json.loads(row[0]).get('activeRun') for row in db.execute('SELECT metadata FROM sessions')),
                'Active or waiting run exists; finish it before retrying.')


def sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_durable(source, target):
    with open(source, 'rb') as src, open(target, 'xb') as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())


def restore_file(original, prepared, backup):
    container_id = original['Id']
    paused_attempted = False
    replaced = False
    root = pathlib.Path('/proc/%s/root' % original['State']['Pid'])
    target = root / CLI.lstrip('/')
    stage = target.with_name('.claude-restore-' + backup.name)
    rollback = target.with_name('.claude-original-' + backup.name)
    try:
        paused_attempted = True
        docker('pause', container_id)
        current = inspect(container_id)
        require(current['State']['Paused'] and current['State']['Pid'] == original['State']['Pid']
                and current['Image'] == original['Image'], 'Container changed during preparation.')
        idle(current)
        for name in ('opt', 'opt/runtime', 'opt/runtime/cli', 'opt/runtime/cli/bin', CLI.lstrip('/')):
            require(not (root / name).is_symlink(), 'Unexpected symlink in CLI path.')
        info = target.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o755,
                'Unexpected CLI type, owner or permissions.')
        require(digest(target) == OBSERVED_SHA, 'CLI differs from the diagnosed file; no replacement made.')
        copy_durable(target, backup / 'claude.before')
        require(digest(backup / 'claude.before') == OBSERVED_SHA, 'Backup verification failed.')
        record = {'containerId': container_id, 'imageId': current['Image'], 'path': CLI,
                  'beforeSha256': OBSERVED_SHA, 'officialSha256': OFFICIAL_SHA,
                  'uid': info.st_uid, 'gid': info.st_gid, 'mode': '755', 'mtimeNs': info.st_mtime_ns}
        with open(backup / 'record.json', 'x') as stream:
            json.dump(record, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        sync_dir(backup)
        copy_durable(prepared, stage)
        os.chown(stage, 0, info.st_gid)
        os.chmod(stage, 0o755)
        require(digest(stage) == OFFICIAL_SHA, 'Staged CLI verification failed.')
        # Preserve the old inode for an atomic rollback while the service is paused.
        os.link(target, rollback)
        sync_dir(target.parent)
        replaced = True
        os.replace(stage, target)
        sync_dir(target.parent)
        require(digest(target) == OFFICIAL_SHA, 'Restored CLI verification failed.')
        info = target.stat()
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o755, 'Restored permissions are incorrect.')
    except BaseException:
        if replaced:
            os.replace(rollback, target)
            sync_dir(target.parent)
            require(digest(target) == OBSERVED_SHA, 'Rollback verification failed; retain the backup for recovery.')
            print('Original CLI restored after failure.', flush=True)
        raise
    finally:
        # Unpause even if copying, hashing, or rollback failed or the user pressed Ctrl+C.
        try:
            if paused_attempted and inspect(container_id)['State'].get('Paused'):
                docker('unpause', container_id)
        except BaseException:
            print('CC may still be paused. Resume with: sudo docker unpause ' + container_id, flush=True)
            raise
        finally:
            for path in (stage, rollback):
                if path.exists():
                    path.unlink()
    current = inspect(container_id)
    require(current['State']['Running'] and not current['State']['Paused'],
            'Container is not running; inspect it before continuing.')


def main():
    require(os.geteuid() == 0, 'Run with sudo python3.')
    original = inspect(CONTAINER)
    require(original['State']['Running'] and not original['State']['Paused'], 'Container must be running and unpaused.')
    require(not original['HostConfig'].get('ReadonlyRootfs'), 'Container root filesystem is read-only.')
    for mount in original['Mounts']:
        destination = mount['Destination'].rstrip('/')
        require(destination and not (CLI == destination or CLI.startswith(destination + '/')),
                'CLI has an unexpected external mount.')
    target = pathlib.Path('/proc/%s/root' % original['State']['Pid']) / CLI.lstrip('/')
    actual = digest(target)
    if actual == OFFICIAL_SHA:
        print('CLI already matches the pinned official 2.1.295 binary; no changes made.', flush=True)
        return
    require(actual == OBSERVED_SHA, 'CLI identity changed since diagnosis; nothing changed.')
    print('1/4 Verifying cached official 2.1.295 archive...', flush=True)
    require(digest(ARCHIVE) == ARCHIVE_SHA, 'Cached official archive hash mismatch.')
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(shutil.disk_usage(BACKUPS).free > target.stat().st_size * 4 + 512 * 1024 * 1024,
            'Insufficient backup/staging space.')
    require(shutil.disk_usage(target.parent).free > target.stat().st_size * 3 + 512 * 1024 * 1024,
            'Insufficient container filesystem space.')
    with tempfile.TemporaryDirectory(prefix='cc-official-cli-') as folder:
        prepared = pathlib.Path(folder) / 'claude'
        with tarfile.open(ARCHIVE) as archive, archive.extractfile('package/claude') as source, open(prepared, 'xb') as output:
            shutil.copyfileobj(source, output)
        require(digest(prepared) == OFFICIAL_SHA, 'Official binary hash mismatch.')
        backup = pathlib.Path(tempfile.mkdtemp(prefix=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-'), dir=BACKUPS))
        print('2/4 Checking idle state; briefly pausing CC. Backup: ' + str(backup), flush=True)
        print('If this process is forcibly killed, resume CC with: sudo docker unpause ' + CONTAINER, flush=True)
        restore_file(original, prepared, backup)
        print('3/4 Full official SHA256 and root/0755 verified; CC unpaused.', flush=True)
        print('4/4 SUCCESS: same-version official CLI restored. No Claude execution or provider requests.', flush=True)
        print(json.dumps({'sha256': OFFICIAL_SHA, 'backup': str(backup), 'containerRunning': True}), flush=True)


def terminate(*_):
    raise SystemExit('Terminated; cleanup requested.')


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except Exception as error:
        raise SystemExit('RESTORATION STOPPED: ' + str(error)) from None
