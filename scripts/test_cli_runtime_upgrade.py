"""CLI migration pinning and baseline tests; no provider or Docker calls."""
import hashlib
import importlib.util
import io
import json
import subprocess
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
                          lock=upgrade.RUNTIME_LOCK, cli=upgrade.BASE_CLI)
            self.assertFalse(upgrade.check_baseline(before, release))
            with self.assertRaises(RuntimeError):
                upgrade.check_baseline({**before, 'cli': upgrade.CLI}, release)
        # Builds 27 and 28 already run the target CLI on the previous dependencies.
        for build in [27, 28]:
            descriptor = next(k for k, v in upgrade.BASELINES.items() if v == (build, 24))
            before = dict(descriptor=descriptor, build=build, protocol=24, node=upgrade.NODE_VERSION,
                          lock=upgrade.RUNTIME_LOCK, cli=upgrade.CLI)
            self.assertFalse(upgrade.check_baseline(before, release))
            with self.assertRaisesRegex(RuntimeError, 'Unknown original'):
                upgrade.check_baseline({**before, 'cli': upgrade.BASE_CLI}, release)
            with self.assertRaisesRegex(RuntimeError, 'Unknown original'):
                upgrade.check_baseline({**before, 'lock': upgrade.LOCK}, release)
        # Build 30 runs the target protocol, CLI and dependencies: an ordinary baseline for Build 31.
        descriptor = next(k for k, v in upgrade.BASELINES.items() if v == (30, 25))
        before = dict(descriptor=descriptor, build=30, protocol=25, node=upgrade.NODE_VERSION,
                      lock=upgrade.LOCK, cli=upgrade.CLI)
        self.assertFalse(upgrade.check_baseline(before, release))
        for change in ({'lock': upgrade.RUNTIME_LOCK}, {'cli': upgrade.BASE_CLI}, {'protocol': 24}):
            with self.assertRaisesRegex(RuntimeError, 'Unknown original'):
                upgrade.check_baseline({**before, **change}, release)
        # Build 29 already runs the target CLI and dependencies; only its protocol differs from Build 30's.
        descriptor = next(k for k, v in upgrade.BASELINES.items() if v == (29, 24))
        before = dict(descriptor=descriptor, build=29, protocol=24, node=upgrade.NODE_VERSION,
                      lock=upgrade.LOCK, cli=upgrade.CLI)
        self.assertFalse(upgrade.check_baseline(before, release))
        for change in ({'lock': upgrade.RUNTIME_LOCK}, {'cli': upgrade.BASE_CLI}, {'protocol': 25}):
            with self.assertRaisesRegex(RuntimeError, 'Unknown original'):
                upgrade.check_baseline({**before, **change}, release)
        target = dict(descriptor=release['descriptorSha256'], build=upgrade.BUILD, protocol=upgrade.PROTOCOL,
                      node=upgrade.NODE_VERSION, lock=upgrade.LOCK, cli=upgrade.CLI)
        self.assertTrue(upgrade.check_baseline(target, release))
        with self.assertRaises(RuntimeError):
            upgrade.check_baseline({**target, 'cli': upgrade.BASE_CLI}, release)

    def test_a_missing_journal_reads_as_the_supervisors_default_only_with_nothing_installed(self):
        start = upgrade.VERIFY_RUNTIME.index("const jp='/data/managed-server/journal.json'")
        end = upgrade.VERIFY_RUNTIME.index('\n', upgrade.VERIFY_RUNTIME.index('else{a(js', start))
        snippet = upgrade.VERIFY_RUNTIME[start:end]
        self.assertTrue(upgrade.settled_journal(upgrade.DEFAULT_JOURNAL))
        harness = r'''
const [snippet, fixture, fallback] = process.argv.slice(1); const files = JSON.parse(fixture);
const f = { lstatSync: (p) => { if (!(p in files.stat)) throw Object.assign(Error('missing'), { code: files.error || 'ENOENT' });
    return { isFile: () => files.stat[p] === 'file', isSymbolicLink: () => files.stat[p] === 'link', size: 10 }; },
  readdirSync: () => files.releases, readFileSync: () => '{"schema":1,"phase":"committed"}' };
const a = (ok) => { if (!ok) throw Error('assert'); }; process.argv[3] = fallback;
let result; try { eval(snippet + ';result=journal'); console.log(JSON.stringify(result)); } catch (e) { console.log('THROW ' + e.message); }'''
        def run(stat, releases, error=None):
            fixture = json.dumps({'stat': stat, 'releases': releases, 'error': error})
            out = subprocess.run(['node', '-e', harness, snippet, fixture, json.dumps(upgrade.DEFAULT_JOURNAL)],
                                 capture_output=True, text=True, check=True).stdout.strip()
            return out
        jp = '/data/managed-server/journal.json'
        self.assertEqual(json.loads(run({}, [])), upgrade.DEFAULT_JOURNAL)
        self.assertTrue(run({}, ['abc']).startswith('THROW'))
        self.assertTrue(run({}, [], error='EACCES').startswith('THROW'))
        self.assertTrue(run({jp: 'link'}, []).startswith('THROW'))
        self.assertEqual(json.loads(run({jp: 'file'}, [])), {'schema': 1, 'phase': 'committed'})

    def test_after_a_cutover_the_default_journal_is_written_but_never_over_one(self):
        calls = []
        with patch.object(upgrade.subprocess, 'run', side_effect=lambda command, **options: calls.append(command)):
            upgrade.ensure_default_journal('proxy')
        command = calls[0]
        self.assertEqual(command[:5], ['docker', 'exec', '-u', '1000:1000', 'proxy'])
        self.assertIn("flag:'wx'", command[command.index('-e') + 1])
        self.assertEqual(json.loads(command[-1]), upgrade.DEFAULT_JOURNAL)

    def test_live_server_is_probed_in_its_own_protocol(self):
        current = {'build': 28, 'protocol': 24, 'sha256': None}
        calls = []
        def run(command, **options):
            calls.append(command)
            body = {'current': current, 'check': {'current': current}}
            return SimpleNamespace(stdout=('progress\n' + __import__('json').dumps(body)).encode())
        with patch.object(upgrade.subprocess, 'run', side_effect=run):
            self.assertEqual(upgrade.live_probe('proxy', 24)['current'], current)
        script = calls[0][calls[0].index('-e') + 1]
        self.assertTrue(script.startswith('const target={"probe": true, "protocol": 24};'))
        self.assertNotEqual(upgrade.PROTOCOL, 24)
        def differing(command, **options):
            body = {'current': current, 'check': {'current': {**current, 'build': 29}}}
            return SimpleNamespace(stdout=__import__('json').dumps(body).encode())
        with patch.object(upgrade.subprocess, 'run', side_effect=differing):
            with self.assertRaisesRegex(RuntimeError, 'selection differs'):
                upgrade.live_probe('proxy', 24)

    def test_candidate_uses_pinned_lean_base_and_complete_authenticated_runtime(self):
        recipe = upgrade.dockerfile()
        self.assertTrue(recipe.startswith('FROM ubuntu:24.04@sha256:'))
        self.assertIn('COPY --chown=root:root runtime/ /opt/runtime/', recipe)
        self.assertNotIn('cc-space-runtime-base:', recipe)
        self.assertNotIn('claude --', recipe)
        self.assertEqual(fresh.CLI_RUNTIMES[upgrade.RUNTIME][2], upgrade.CLI)
        self.assertEqual(recipe, fresh.DOCKERFILE)

    def test_new_installer_pins_the_actual_recovery_helper(self):
        installer = load('cli_fresh_v6', 'apps/update-service/web/fresh-install-v6.py')
        self.assertEqual(installer.DOCKERFILE, upgrade.dockerfile())
        for relative, expected in installer.RECOVERY_SUPPORT.items():
            self.assertEqual(hashlib.sha256((ROOT/relative).read_bytes()).hexdigest(), expected)

    def test_future_build_cannot_inherit_a_previous_application_image(self):
        with self.assertRaises(TypeError):
            upgrade.dockerfile('cc-space-runtime:old-application')
        self.assertNotIn('chown -R root:root /app /opt/runtime', upgrade.dockerfile())

    def test_layer_or_size_regression_blocks_cutover(self):
        base={'RootFS':{'Layers':['pinned-ubuntu']}}
        candidate={'Size':2*1024**3,'RootFS':{'Layers':['pinned-ubuntu','new-runtime']}}
        upgrade.validate_candidate_image(candidate,base)
        with self.assertRaisesRegex(RuntimeError,'size budget'):
            upgrade.validate_candidate_image({**candidate,'Size':upgrade.IMAGE_SIZE_LIMIT+1},base)
        with self.assertRaisesRegex(RuntimeError,'base layers changed'):
            upgrade.validate_candidate_image({**candidate,'RootFS':{'Layers':['different-base']}},base)

    def test_target_verifier_uses_cli_matching_signed_runtime_identity(self):
        ops=load('cli_target_ops','apps/update-service/web/host-operations.py')
        for runtime,expected in [('node24-cli2.1.295-v4',upgrade.BASE_CLI),
                                 ('node24-cli2.1.325-v4',upgrade.CLI),
                                 (upgrade.RUNTIME,upgrade.CLI)]:
            with self.subTest(runtime=runtime),patch.object(ops,'output',return_value='authenticated-target') as output:
                self.assertTrue(ops.inspect_target('fixture',{'runtimeLevel':runtime}))
                import json
                self.assertEqual(json.loads(output.call_args.args[0][-1])['cliSha256'],expected)
        with patch.object(ops,'output') as output:
            with self.assertRaises(KeyError):ops.inspect_target('fixture',{'runtimeLevel':'unknown'})
            output.assert_not_called()


if __name__ == '__main__':
    unittest.main()
