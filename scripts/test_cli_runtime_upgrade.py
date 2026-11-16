"""CLI migration pinning and baseline tests; no provider or Docker calls."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fresh = load('cli_fresh', 'apps/update-service/web/fresh-install.py')
upgrade = load('cli_upgrade', 'deploy/host-update/apply.py')


class CliUpgradeTests(unittest.TestCase):
    def test_build_is_cancelled_before_operating_space_is_exhausted(self):
        process = Mock()
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory, patch.object(upgrade.subprocess, 'Popen', return_value=process), patch.object(upgrade.shutil, 'disk_usage', return_value=SimpleNamespace(free=upgrade.OPERATING_RESERVE-1)):
            with self.assertRaisesRegex(RuntimeError, 'retain operating space'):
                upgrade.build_candidate(['fixture-builder'], Path(directory)/'build.log')
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=30)

    def test_build_budget_accounts_for_runtime_already_staged(self):
        with patch.object(upgrade.shutil, 'disk_usage', return_value=SimpleNamespace(free=upgrade.BUILD_SPACE-1)):
            with self.assertRaisesRegex(RuntimeError, 'Insufficient image build space'):
                upgrade.check_build_space()
            upgrade.check_build_space(staged=1024)

    def test_pinned_archive_and_binary_are_both_verified_before_install(self):
        binary = b'fixture-cli'
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            info = tarfile.TarInfo('package/claude')
            info.size = len(binary)
            archive.addfile(info, io.BytesIO(binary))
        packed = buffer.getvalue()
        pin = ('2.1.325', hashlib.sha256(packed).hexdigest(), hashlib.sha256(binary).hexdigest())
        with tempfile.TemporaryDirectory() as directory, patch.object(fresh, 'download', return_value=packed) as download:
            work = Path(directory)
            for damaged, message in [(('2.1.325', '0'*64, pin[2]), 'archive digest'),
                                     (('2.1.325', pin[1], '0'*64), 'binary digest')]:
                with patch.dict(fresh.CLI_RUNTIMES, {upgrade.RUNTIME: damaged}):
                    with self.assertRaisesRegex(fresh.InstallError, message):
                        fresh.provision_cli(work, upgrade.RUNTIME)
                    self.assertFalse((work / 'runtime/cli/bin/claude').exists())
            with patch.dict(fresh.CLI_RUNTIMES, {upgrade.RUNTIME: pin}):
                fresh.provision_cli(work, upgrade.RUNTIME)
            self.assertEqual((work / 'runtime/cli/bin/claude').read_bytes(), binary)
            self.assertIn('2.1.325.tgz', download.call_args.args[0])

    def test_old_and_target_cli_cannot_be_relabelled(self):
        release = {'descriptorSha256': 'a'*64}
        for build in [21, 22]:
            descriptor = next(k for k, v in upgrade.BASELINES.items() if v == (build, 24))
            before = dict(descriptor=descriptor, build=build, protocol=24, node=upgrade.NODE_VERSION,
                          lock=upgrade.LOCK, cli=upgrade.BASE_CLI)
            self.assertFalse(upgrade.check_baseline(before, release))
            with self.assertRaises(RuntimeError):
                upgrade.check_baseline({**before, 'cli': upgrade.CLI}, release)
        target = dict(descriptor=release['descriptorSha256'], build=upgrade.BUILD, protocol=24,
                      node=upgrade.NODE_VERSION, lock=upgrade.LOCK, cli=upgrade.CLI)
        self.assertTrue(upgrade.check_baseline(target, release))
        with self.assertRaises(RuntimeError):
            upgrade.check_baseline({**target, 'cli': upgrade.BASE_CLI}, release)

    def test_candidate_uses_pinned_lean_base_and_complete_authenticated_runtime(self):
        recipe = upgrade.dockerfile(upgrade.BASE_IMAGE)
        self.assertTrue(recipe.startswith('FROM ubuntu:24.04@sha256:'))
        self.assertIn('COPY --chown=root:root runtime/ /opt/runtime/', recipe)
        self.assertNotIn('cc-space-runtime-base:', recipe)
        self.assertNotIn('claude --', recipe)
        self.assertEqual(fresh.CLI_RUNTIMES[upgrade.RUNTIME][2], upgrade.CLI)


if __name__ == '__main__':
    unittest.main()
