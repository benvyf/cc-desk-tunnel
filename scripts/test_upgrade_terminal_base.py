import base64
import hashlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).with_name('upgrade-terminal-base.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
helper_spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).parents[1] / 'apps/update-service/web/server-bootstrap.py')
bootstrap = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(bootstrap)
legacy_spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('install-cc-space-037.py'))
cutover = importlib.util.module_from_spec(legacy_spec)
legacy_spec.loader.exec_module(cutover)


@unittest.skipUnless(os.name == 'posix', 'Linux root filesystem and fcntl required')
class UpgradeTests(unittest.TestCase):
    def exercise(self, install=False, corrupt=False, invalid_baseline=False, existing=False, wrong_base=False, invalid_candidate=False, cleanup=False, low_space=False, node='ubuntu-cc', changed_image=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content = b'{}'
            descriptor = json.dumps({'build': upgrade.TARGET_BUILD, 'protocol': 22, 'sourceCommit': 'a' * 40, 'files': {'deploy/docker/managed-settings.json': {'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}}}).encode()
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz') as archive:
                for name, data in [('SERVER-RELEASE.json', descriptor), ('deploy/docker/managed-settings.json', content)]:
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            archive_bytes = output.getvalue()
            release = {'build': upgrade.TARGET_BUILD, 'protocol': 22, 'sourceCommit': 'a' * 40, 'sha256': hashlib.sha256(archive_bytes).hexdigest(), 'descriptorSha256': hashlib.sha256(descriptor).hexdigest()}
            index = json.dumps({'payload': base64.urlsafe_b64encode(json.dumps({'release': release}).encode()).decode().rstrip('=')}).encode()
            calls = []
            profile = cutover.REBUILT_NODES.get(node)
            current = {'Id': 'original', 'Image': profile['image'] if profile and not changed_image else 'sha256:' + 'b' * 64, 'State': {'Running': True}}
            def offline_preflight(*args):
                bootstrap.offline_preflight(*args)
                calls.append('offline')
            helper = SimpleNamespace(CONTAINER='fixture', PROFILE={'files': {}}, Engine=lambda: SimpleNamespace(request=lambda *args: current), validate_runtime=lambda _: None, runtime_and_policy=lambda _: None, verify_index=lambda *args: {'release': release}, offline_preflight=offline_preflight)
            legacy = SimpleNamespace(select_node=lambda host: cutover.select_node(host), REBUILT_DESCRIPTOR=cutover.REBUILT_DESCRIPTOR, DATA=root / 'data', helper=lambda *args, **kwargs: helper, install=lambda _, **kwargs: calls.extend(['install', kwargs['disconnect_clients']]))
            inspections = 0
            def command(args, **kwargs):
                nonlocal inspections
                calls.append(args[:2])
                if invalid_baseline and args[:2] == ['docker', 'exec']:
                    raise RuntimeError('Unknown baseline')
                if args[:3] == ['docker', 'image', 'inspect']:
                    inspections += 1
                    if inspections == 1 and not existing:
                        return SimpleNamespace(returncode=1)
                    return SimpleNamespace(returncode=0, stdout=json.dumps([
                        {'Id': 'sha256:' + 'c' * 64, 'RootFS': {'Layers': ['wrong' if wrong_base else 'base', 'app']}},
                        {'RootFS': {'Layers': ['base']}}
                    ]).encode())
                if invalid_candidate and args[:2] == ['docker', 'run'] and '-e' in args:
                    raise subprocess.CalledProcessError(1, args)
                return SimpleNamespace(returncode=0)
            download = lambda path, _: index if path.endswith('.json') else archive_bytes + (b'x' if corrupt else b'')
            create_temp = tempfile.mkdtemp
            with patch.object(upgrade.shutil, 'disk_usage', return_value=SimpleNamespace(free=0 if low_space else 10 * 1024**3)), patch.object(upgrade, 'ROOT', root / 'private'), patch.object(upgrade.os, 'geteuid', create=True, return_value=0), patch.object(upgrade.socket, 'gethostname', return_value=node), patch.object(upgrade, 'load', return_value=legacy), patch.object(upgrade, 'download', side_effect=download), patch.object(upgrade.subprocess, 'run', side_effect=command), patch.object(upgrade.tempfile, 'mkdtemp', side_effect=lambda **_: create_temp(dir=root)), patch('sys.argv', ['upgrade', *(['--install', '--disconnect-clients'] if install else []), *(['--cleanup'] if cleanup else [])]):
                if corrupt or invalid_baseline or wrong_base or invalid_candidate or low_space or changed_image:
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)): upgrade.main()
                    self.assertNotIn('offline', calls)
                    self.assertNotIn('install', calls)
                else:
                    upgrade.main()
                    self.assertIn('offline', calls)
                    self.assertEqual('install' in calls, install)
                    self.assertEqual(['docker', 'builder'] in calls, cleanup)
                    if cleanup:
                        self.assertLess(calls.index(['docker', 'builder']), calls.index(['docker', 'image']))
                    self.assertEqual(['docker', 'build'] in calls, not existing)
                    if install:
                        self.assertIs(calls[-1], True)
                        self.assertEqual(legacy.TARGET, {'build': upgrade.TARGET_BUILD, 'protocol': 22})
                        self.assertEqual(legacy.BASE, current['Image'])

    def test_node02_uses_confirmed_image(self): self.exercise(install=True, cleanup=True, node='ubuntu-cc-02')
    def test_node03_uses_confirmed_image(self): self.exercise(install=True, cleanup=True, node='ubuntu-cc-03')
    def test_changed_node_image_cannot_install(self): self.exercise(install=True, node='ubuntu-cc-02', changed_image=True)
    def test_preparation_never_switches_container(self): self.exercise()
    def test_explicit_install_uses_verified_target(self): self.exercise(install=True)
    def test_corrupt_archive_stops_before_build(self): self.exercise(corrupt=True)
    def test_cleanup_precedes_candidate_preparation(self): self.exercise(install=True, existing=True, cleanup=True)
    def test_low_space_stops_before_build_or_install(self): self.exercise(install=True, cleanup=True, low_space=True)
    def test_unknown_baseline_stops_before_download(self): self.exercise(invalid_baseline=True)
    def test_retry_reuses_candidate_and_rechecks_offline(self): self.exercise(install=True, existing=True)
    def test_wrong_candidate_base_cannot_install(self): self.exercise(install=True, existing=True, wrong_base=True)
    def test_invalid_candidate_bytes_cannot_install(self): self.exercise(install=True, existing=True, invalid_candidate=True)


class NodeProfileTests(unittest.TestCase):
    def original(self, node):
        return {
            'Id': 'original', 'Image': cutover.REBUILT_NODES[node]['image'],
            'State': {'Running': True, 'Paused': False},
            'Config': {'Entrypoint': ['/usr/bin/tini', '-g', '--', '/usr/local/bin/proxy-entrypoint'],
                       'Cmd': ['server'], 'User': 'ccdesktunnel', 'WorkingDir': '/data/workspace',
                       'Healthcheck': {'Test': ['CMD', 'healthcheck']}},
            'HostConfig': {'NetworkMode': 'bridge', 'RestartPolicy': {'Name': 'unless-stopped'}},
            'NetworkSettings': {'Networks': {'cc': {}}},
            'Mounts': [
                {'Type': 'bind', 'Source': '/srv/cc-desk-tunnel', 'Destination': '/data', 'RW': True},
                {'Type': 'bind', 'Source': cutover.REBUILT_NODES[node]['policy'],
                 'Destination': '/etc/claude-code', 'RW': False},
            ],
        }

    def configured(self, node):
        with patch.object(cutover, 'NODE', node):
            return cutover.configure_helper(SimpleNamespace(validate_runtime=bootstrap.validate_runtime))

    def test_reviewed_nodes_preserve_mounts_and_validate_real_constraints(self):
        for node in cutover.REBUILT_NODES:
            with self.subTest(node=node):
                original = self.original(node)
                before = json.dumps(original, sort_keys=True)
                b = self.configured(node)
                b.validate_runtime(original)
                self.assertEqual(b.CONTAINER, cutover.REBUILT_NODES[node]['container'])
                self.assertEqual(json.dumps(original, sort_keys=True), before)
                original['Mounts'][1]['RW'] = True
                with self.assertRaises(bootstrap.InstallError): b.validate_runtime(original)

    def test_other_node_policy_and_unknown_hosts_are_refused(self):
        b = self.configured('ubuntu-cc-02')
        with self.assertRaises(RuntimeError): b.validate_runtime(self.original('ubuntu-cc-03'))
        with self.assertRaises(RuntimeError): cutover.select_node('ubuntu-cc-04')

    @unittest.skipUnless(os.name == 'posix', 'Linux filesystem required')
    def test_force_disconnect_blocks_runs_and_restores_after_cutover_failure(self):
        for state in ('idle', 'active', 'missing', 'disconnect-fails'):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                data = root / 'data'; (data / 'state').mkdir(parents=True)
                if state != 'missing':
                    with cutover.sqlite3.connect(data / 'state/sessions.sqlite') as db:
                        db.execute('CREATE TABLE sessions(metadata TEXT)')
                        db.execute('INSERT INTO sessions VALUES (?)', (json.dumps({'activeRun': state == 'active'}),))
                (root / 'helper.py').write_text('# fixture')
                original = self.original('ubuntu-cc-03')
                calls = []
                def request(method, path, *args):
                    calls.append(path)
                    if path.startswith('/images/'): return {'Id': 'candidate'}
                    if '/top?' in path: return {'Processes': []}
                    if state == 'disconnect-fails' and '/disconnect' in path:
                        raise RuntimeError('network disconnect failed')
                    return original
                b = self.configured('ubuntu-cc-03')
                b.Engine = lambda: SimpleNamespace(request=request)
                b.runtime_and_policy = lambda _: None
                b.urllib, b.durable_json, b.busy = bootstrap.urllib, bootstrap.durable_json, bootstrap.busy
                b.endpoints = bootstrap.endpoints
                # Idle sockets must not call the old blanket TCP rejection.
                b.frozen_idle = lambda _: self.fail('legacy TCP guard used')
                with patch.object(cutover, 'ROOT', root), patch.object(cutover, 'DATA', data), patch.object(cutover, 'BASE', original['Image']), patch.object(cutover.shutil, 'disk_usage', return_value=SimpleNamespace(free=10*1024**3)), patch.object(cutover.subprocess, 'run'), patch.object(cutover.tarfile, 'open', side_effect=RuntimeError('backup failed')), patch.object(cutover, 'rollback') as restore:
                    with self.assertRaises(RuntimeError): cutover.install(b, disconnect_clients=True)
                if state in ('active', 'missing'):
                    restore.assert_not_called()
                    self.assertFalse(any('/disconnect' in p or '/stop?' in p for p in calls))
                else:
                    restore.assert_called_once()
                    self.assertIn('/networks/cc/disconnect', calls)
                    if state == 'idle':
                        self.assertLess(calls.index('/networks/cc/disconnect'), calls.index('/containers/original/unpause'))
                        self.assertLess(calls.index('/containers/original/unpause'), calls.index('/containers/original/stop?t=30'))
                self.assertIn('/containers/original/unpause', calls)

    @unittest.skipUnless(os.name == 'posix', 'Linux root filesystem and fcntl required')
    def test_generated_offline_rollback_retains_node_and_admission_failure_keeps_original(self):
        for node in cutover.REBUILT_NODES:
            with self.subTest(node=node), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                data = root / 'data'; data.mkdir()
                (root / 'helper.py').write_bytes((Path(__file__).parents[1] / 'apps/update-service/web/server-bootstrap.py').read_bytes())
                original = self.original(node)
                calls = []
                def request(method, path, *args):
                    calls.append((method, path))
                    if path.startswith('/images/'): return {'Id': 'candidate'}
                    if '/top?' in path: return {'Processes': [['claude']]}
                    return original
                b = self.configured(node)
                b.Engine = lambda: SimpleNamespace(request=request)
                b.runtime_and_policy = lambda _: None
                b.urllib = bootstrap.urllib
                b.durable_json = bootstrap.durable_json
                b.busy = bootstrap.busy
                with patch.object(cutover, 'NODE', node), patch.object(cutover, 'ROOT', root), patch.object(cutover, 'DATA', data), patch.object(cutover, 'BASE', original['Image']), patch.object(cutover.shutil, 'disk_usage', return_value=SimpleNamespace(free=10*1024**3)), patch.object(cutover.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                    with self.assertRaisesRegex(RuntimeError, 'Finish Claude tasks'):
                        cutover.install(b, disconnect_clients=True)
                self.assertIn(('POST', '/containers/original/unpause'), calls)
                self.assertFalse(any('/stop?' in path or '/rename?' in path or '/update' in path for _, path in calls))
                backup = next(root.glob('backup-*'))
                self.assertFalse(json.loads((backup / 'record.json').read_text())['dataChanged'])
                spec = importlib.util.spec_from_file_location('saved_rollback', backup / 'rollback.py')
                saved = importlib.util.module_from_spec(spec); spec.loader.exec_module(saved)
                self.assertEqual(saved.NODE, node)
                self.assertEqual(saved.ROOT, root)
                with patch.object(saved.socket, 'gethostname', return_value=node), patch('sys.argv', ['rollback', '--rollback', str(backup)]), patch.object(saved, 'rollback') as restore:
                    saved.main()
                    self.assertEqual(restore.call_args.args[0].CONTAINER, b.CONTAINER)
                    self.assertEqual(restore.call_args.args[1], backup)


if __name__ == '__main__': unittest.main()
