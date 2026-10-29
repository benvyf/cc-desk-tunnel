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


@unittest.skipUnless(os.name == 'posix', 'Linux root filesystem and fcntl required')
class UpgradeTests(unittest.TestCase):
    def exercise(self, install=False, corrupt=False, invalid_baseline=False, existing=False, wrong_base=False, invalid_candidate=False, cleanup=False, low_space=False):
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
            current = {'Id': 'original', 'Image': 'sha256:' + 'b' * 64, 'State': {'Running': True}}
            def offline_preflight(*args):
                bootstrap.offline_preflight(*args)
                calls.append('offline')
            helper = SimpleNamespace(CONTAINER='fixture', PROFILE={'files': {}}, Engine=lambda: SimpleNamespace(request=lambda *args: current), validate_runtime=lambda _: None, runtime_and_policy=lambda _: None, verify_index=lambda *args: {'release': release}, offline_preflight=offline_preflight)
            legacy = SimpleNamespace(DATA=root / 'data', helper=lambda *args, **kwargs: helper, install=lambda _: calls.append('install'))
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
            with patch.object(upgrade.shutil, 'disk_usage', return_value=SimpleNamespace(free=0 if low_space else 10 * 1024**3)), patch.object(upgrade, 'ROOT', root / 'private'), patch.object(upgrade.os, 'geteuid', create=True, return_value=0), patch.object(upgrade.socket, 'gethostname', return_value='ubuntu-cc'), patch.object(upgrade, 'load', return_value=legacy), patch.object(upgrade, 'download', side_effect=download), patch.object(upgrade.subprocess, 'run', side_effect=command), patch.object(upgrade.tempfile, 'mkdtemp', side_effect=lambda **_: create_temp(dir=root)), patch('sys.argv', ['upgrade', *(['--install'] if install else []), *(['--cleanup'] if cleanup else [])]):
                if corrupt or invalid_baseline or wrong_base or invalid_candidate or low_space:
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
                        self.assertEqual(legacy.TARGET, {'build': upgrade.TARGET_BUILD, 'protocol': 22})
                        self.assertEqual(legacy.BASE, current['Image'])

    def test_preparation_never_switches_container(self): self.exercise()
    def test_explicit_install_uses_verified_target(self): self.exercise(install=True)
    def test_corrupt_archive_stops_before_build(self): self.exercise(corrupt=True)
    def test_cleanup_precedes_candidate_preparation(self): self.exercise(install=True, existing=True, cleanup=True)
    def test_low_space_stops_before_build_or_install(self): self.exercise(install=True, cleanup=True, low_space=True)
    def test_unknown_baseline_stops_before_download(self): self.exercise(invalid_baseline=True)
    def test_retry_reuses_candidate_and_rechecks_offline(self): self.exercise(install=True, existing=True)
    def test_wrong_candidate_base_cannot_install(self): self.exercise(install=True, existing=True, wrong_base=True)
    def test_invalid_candidate_bytes_cannot_install(self): self.exercise(install=True, existing=True, invalid_candidate=True)


if __name__ == '__main__': unittest.main()
