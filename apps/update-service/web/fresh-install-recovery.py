#!/usr/bin/env python3
"""Cold recovery for clean reinstall, using the reviewed host-upgrade machinery.

The installer holds root/install.lock throughout. It admits the signed release and
checks live_status before commit; this module never downloads or chooses releases.
"""
import hashlib
import inspect
import json
from pathlib import Path
import secrets
import shutil
import tarfile
import time
import urllib.parse


def fingerprint(container):
    value = {key: container[key] for key in ('Id', 'Name', 'Image', 'Config', 'HostConfig')}
    value['Mounts'] = sorted(container['Mounts'], key=lambda mount: json.dumps(mount, sort_keys=True))
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def restore_isolated(b, backup, data, verify, digest, sync_directory):
    """Handle the fresh-install gap before a replacement DATA directory exists."""
    record = json.loads((backup / 'record.json').read_text())
    if data.exists() or data.is_symlink() or not record.get('dataChanged'):
        return
    original = json.loads((backup / 'original.json').read_text())
    engine = b.Engine()
    _, current = b.recovery_container(engine, backup, original)
    old = engine.request('GET', '/containers/' + original['Id'] + '/json')
    if old['State'].get('Running') or current and current['State'].get('Running'):
        raise RuntimeError('Running container conflicts with missing recovery data; data left untouched')
    isolated = Path(record.get('isolation', ''))
    if (isolated.parent != data.parent or not isolated.name.startswith(data.name + '.before-reset-') or
            isolated.is_symlink() or not isolated.is_dir() or
            [isolated.stat().st_dev, isolated.stat().st_ino] != record.get('dataIdentity')):
        raise RuntimeError('Recovery isolation identity changed; data left untouched')
    archive = backup / 'data.tar.gz'
    if digest(archive) != record.get('archiveSha256'):
        raise RuntimeError('Cold backup checksum mismatch; data left untouched')
    verify(archive, data=isolated)
    isolated.rename(data)
    sync_directory(data.parent)
    record['dataChanged'] = False
    b.durable_json(backup / 'record.json', record)


def mark_rolled_back(b, root, backup):
    journal = root / 'reset.json'
    plan = json.loads(journal.read_text())
    if plan.get('backup') != str(backup):
        raise RuntimeError('Rollback journal belongs to another recovery transaction')
    plan['phase'] = 'rolled-back'
    b.durable_json(journal, plan)


class Recovery:
    def __init__(self, root, data, node, helper, legacy, retirement):
        self.root, self.data, self.node = Path(root), Path(data), node
        self.b, self.legacy, self.retirement = helper, legacy, retirement
        # The legacy transaction chooses original.json for restoration; the helper
        # must recognize the fresh replacement under its canonical service name.
        self.b.CONTAINER = 'cc-desk-tunnel'
        self.legacy.ROOT, self.legacy.DATA, self.legacy.NODE = self.root, self.data, node

    def _paths(self, plan, prepared=True):
        required = ('nodeId', 'hostname', 'containerId', 'fingerprint', 'dataIdentity', 'archive', 'phase')
        if (any(key not in plan for key in required) or plan['nodeId'] != self.node or
                prepared and (plan.get('recoveryVersion') != 1 or not plan.get('backup'))):
            raise RuntimeError('Missing or incompatible cold recovery plan; no cutover')
        isolated = Path(plan['archive'])
        if (not self.data.is_absolute() or self.data.resolve() != self.data or self.data.is_symlink() or
                isolated.parent != self.data.parent or
                not isolated.name.startswith(self.data.name + '.before-reset-') or isolated.is_symlink()):
            raise RuntimeError('Unsafe recovery isolation paths')
        if prepared:
            backup = Path(plan['backup'])
            if backup.parent != self.root or not backup.name.startswith('backup-') or backup.resolve() != backup:
                raise RuntimeError('Unsafe recovery backup path')
            return backup, isolated
        return None, isolated

    def _identity(self, path, plan):
        if (path.is_symlink() or not path.is_dir() or
                [path.stat().st_dev, path.stat().st_ino] != plan['dataIdentity']):
            raise RuntimeError('Recovery data directory identity changed')

    def _original(self, plan):
        engine = self.b.Engine()
        original = engine.request('GET', '/containers/' + plan['containerId'] + '/json')
        if fingerprint(original) != plan['fingerprint']:
            raise RuntimeError('Original container identity or configuration changed')
        self._healthy(original)
        self._mounts(original)
        # Recheck all references, including unrelated containers sharing this DATA.
        for item in engine.request('GET', '/containers/json?all=true'):
            if item['Id'] == original['Id']:
                continue
            other = engine.request('GET', '/containers/' + item['Id'] + '/json')
            for mount in other.get('Mounts', []):
                source = Path(mount['Source']).resolve() if mount.get('Source') else None
                if source and (source == self.data or source in self.data.parents or self.data in source.parents):
                    raise RuntimeError('CC data directory has another container reference')
        return engine, original

    def _healthy(self, container):
        state = container.get('State', {})
        if not state.get('Running') or state.get('Paused') or state.get('Health', {}).get('Status') != 'healthy':
            raise RuntimeError('Expected current healthy, running, unpaused CC service')

    def _mounts(self, container):
        mounts = container.get('Mounts', [])
        data = [mount for mount in mounts if mount.get('Type') == 'bind' and
                mount.get('Source') == str(self.data) and mount.get('Destination') == '/data' and mount.get('RW') is True]
        if len(data) != 1 or any(mount != data[0] and not (
                mount.get('Type') == 'bind' and mount.get('Destination') == '/etc/claude-code' and
                mount.get('RW') is False) for mount in mounts):
            raise RuntimeError('Unexpected CC data mounts; no cutover')

    def _save_plan(self, plan):
        self.b.durable_json(self.root / 'reset.json', plan)

    def _not_rolled_back(self, plan):
        phases = [plan.get('phase')]
        journal = self.root / 'reset.json'
        if journal.exists():
            saved = json.loads(journal.read_text())
            if saved.get('backup') == plan.get('backup'):
                phases.append(saved.get('phase'))
        if plan.get('backup'):
            backup, _ = self._paths(plan)
            record = json.loads((backup / 'record.json').read_text())
            phases.append(record.get('phase'))
        if 'rolled-back' in phases:
            raise RuntimeError('Cold recovery was rolled-back; inspect offline rollback and start a new confirmed installation manually')

    def _unmounted(self, path):
        engine = self.b.Engine()
        for item in engine.request('GET', '/containers/json?all=true'):
            container = engine.request('GET', '/containers/' + item['Id'] + '/json')
            for mount in container.get('Mounts', []):
                source = Path(mount['Source']).resolve() if mount.get('Source') else None
                if source and (source == path or source in path.parents or path in source.parents):
                    raise RuntimeError('Recovery isolation has a container mount reference')

    def _rollback_source(self):
        source = Path(self.legacy.__file__).read_text()
        source = source.replace("ROOT = Path('/var/lib/cc-space-037-upgrade')", 'ROOT = Path(' + repr(str(self.root)) + ')')
        source = source.replace("DATA = Path('/srv/cc-desk-tunnel')", 'DATA = Path(' + repr(str(self.data)) + ')')
        source = source.replace("NODE = 'ubuntu-cc'", 'NODE = ' + repr(self.node))
        source = source.replace("'upgrade.lock'", "'install.lock'")
        source = source.replace('return configure_helper(module)', "module.CONTAINER = 'cc-desk-tunnel'\n    return module")
        original = 'def rollback(b, backup):\n'
        if source.count(original) != 1:
            raise RuntimeError('Reviewed rollback entry point changed')
        source = source.replace(original, 'def reviewed_rollback(b, backup):\n')
        wrapper = (inspect.getsource(restore_isolated) + '\n\n' + inspect.getsource(mark_rolled_back) +
                   '\n\ndef rollback(b, backup):\n'
                   '    restore_isolated(b, backup, DATA, verify_cold_backup, digest, sync_directory)\n'
                   '    reviewed_rollback(b, backup)\n'
                   '    mark_rolled_back(b, ROOT, backup)\n\n\n')
        return source.replace('def busy(b, processes):\n', wrapper + 'def busy(b, processes):\n')

    def prepare(self, plan):
        self._not_rolled_back(plan)
        if plan.get('recoveryVersion') == 1:
            self._paths(plan)
            return plan
        _, isolated = self._paths(plan, prepared=False)
        self._identity(self.data, plan)
        if isolated.exists():
            raise RuntimeError('Recovery isolation already exists')
        _, original = self._original(plan)
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
        backup = self.root / ('backup-' + stamp)
        backup.mkdir(mode=0o700)
        self.legacy.sync_directory(self.root)
        (backup / 'rollback.py').write_text(self._rollback_source())
        shutil.copyfile(self.b.__file__, backup / 'helper.py')
        for name in ('rollback.py', 'helper.py'):
            self.legacy.sync_file(backup / name)
        self.b.durable_json(backup / 'original.json', original)
        self.b.durable_json(backup / 'record.json', {'phase': 'prepared', 'dataChanged': False,
            'backup': str(backup), 'isolation': str(isolated), 'dataIdentity': plan['dataIdentity']})
        plan.update(recoveryVersion=1, backup=str(backup))
        self._save_plan(plan)
        print('Rollback command: sudo python3 ' + str(backup / 'rollback.py') + ' --rollback ' + str(backup), flush=True)
        return plan

    def cutover(self, plan):
        self._not_rolled_back(plan)
        backup, isolated = self._paths(plan)
        if plan['phase'] == 'done':
            return
        record = json.loads((backup / 'record.json').read_text())
        if record['phase'] != 'prepared' or record.get('dataChanged'):
            raise RuntimeError('Interrupted cold recovery; use the printed rollback command before retrying')
        self._identity(self.data, plan)
        if isolated.exists():
            raise RuntimeError('Recovery isolation already exists')
        engine, original = self._original(plan)
        paused, changed = False, False
        try:
            engine.request('POST', '/containers/' + original['Id'] + '/pause')
            paused = True
            self.legacy.frozen_tasks_idle(self.b, engine, original)
            frozen = engine.request('GET', '/containers/' + original['Id'] + '/json')
            if fingerprint(frozen) != plan['fingerprint'] or not frozen['State'].get('Paused'):
                raise RuntimeError('Original container changed while freezing')
            self._identity(self.data, plan)
            self.legacy.check_space()
            record['phase'] = 'stopping'
            self.legacy.save(self.b, backup, record)
            changed = True
            engine.request('POST', '/containers/' + original['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
            for name in self.b.endpoints(original):
                engine.request('POST', '/networks/' + urllib.parse.quote(name, safe='') + '/disconnect',
                               {'Container': original['Id'], 'Force': True})
            engine.request('POST', '/containers/' + original['Id'] + '/unpause')
            paused = False
            engine.request('POST', '/containers/' + original['Id'] + '/stop?t=30')
            stopped = engine.request('GET', '/containers/' + original['Id'] + '/json')
            if stopped['State'].get('Running') or stopped['State'].get('Paused'):
                raise RuntimeError('Original container did not stop')
            self._identity(self.data, plan)
            with tarfile.open(backup / 'data.tar.gz', 'w:gz', dereference=False) as archive:
                archive.add(self.data, arcname='data')
            self.legacy.verify_cold_backup(backup / 'data.tar.gz', data=self.data)
            record.update(archiveSha256=self.legacy.digest(backup / 'data.tar.gz'), phase='backed-up')
            self.legacy.save(self.b, backup, record)
            print('BACKUP_VERIFIED: full current cold backup and SHA256 recorded.', flush=True)
            engine.request('POST', '/containers/' + original['Id'] + '/rename?name=cc-desk-tunnel-before-' + backup.name)
            record['dataChanged'] = True
            self.legacy.save(self.b, backup, record)
            self._identity(self.data, plan)
            if isolated.exists() or isolated.is_symlink():
                raise RuntimeError('Recovery isolation appeared during cutover')
            self.data.rename(isolated)
            self.legacy.sync_directory(self.data.parent)
            plan['phase'] = 'done'
            self._save_plan(plan)
        except BaseException:
            if paused:
                engine.request('POST', '/containers/' + original['Id'] + '/unpause')
            if changed:
                self.rollback(plan)
            raise

    def rollback(self, plan):
        backup, _ = self._paths(plan)
        restore_isolated(self.b, backup, self.data, self.legacy.verify_cold_backup,
                         self.legacy.digest, self.legacy.sync_directory)
        self.legacy.rollback(self.b, backup)
        mark_rolled_back(self.b, self.root, backup)
        plan['phase'] = 'rolled-back'

    def commit(self, plan, current_container_info):
        self._not_rolled_back(plan)
        backup, isolated = self._paths(plan)
        current = current_container_info
        self._healthy(current)
        self._mounts(current)
        if current.get('Name') != '/cc-desk-tunnel' or current['Id'] == plan['containerId'] or plan['phase'] != 'done':
            raise RuntimeError('Unexpected replacement container identity')
        record = json.loads((backup / 'record.json').read_text())
        if self.legacy.digest(backup / 'data.tar.gz') != record.get('archiveSha256'):
            raise RuntimeError('Cold backup checksum mismatch; retention stopped')
        if isolated.exists() or isolated.is_symlink():
            self._identity(isolated, plan)
            self.legacy.verify_cold_backup(backup / 'data.tar.gz', data=isolated)
        self.b.durable_json(backup / 'replacement-record.json', {'id': current['Id']})
        record.update(phase='installed', containerId=current['Id'], imageId=current['Image'])
        self.legacy.save(self.b, backup, record)
        try:
            entry = (self.root.name, 'backup-*')
            if entry not in self.retirement.LEGACY:
                self.retirement.LEGACY = [*self.retirement.LEGACY, entry]
            self.retirement.retire(self.root, container_name='cc-desk-tunnel', apply=True)
            if isolated.exists() or isolated.is_symlink():
                # Current DATA may have changed since cutover; only the staged
                # original inode is eligible, after checksum and full comparison.
                self._identity(isolated, plan)
                if self.legacy.digest(backup / 'data.tar.gz') != record['archiveSha256']:
                    raise RuntimeError('Cold backup checksum changed')
                self.legacy.verify_cold_backup(backup / 'data.tar.gz', data=isolated)
                self._unmounted(isolated)
                shutil.rmtree(isolated)
                self.legacy.sync_directory(self.data.parent)
        except Exception as error:
            print('RETENTION_PENDING: ' + str(error) + '; healthy installation and rollback retained.', flush=True)
