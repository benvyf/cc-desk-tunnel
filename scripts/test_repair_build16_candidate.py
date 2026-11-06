import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('repair', Path(__file__).with_name('repair-build16-candidate.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RepairTests(unittest.TestCase):
    def test_context_is_pinned_and_only_restores_the_selected_asset_without_running_commands(self):
        image = 'sha256:' + 'a' * 64
        with tarfile.open(fileobj=io.BytesIO(m.context(image, b'asset'))) as archive:
            self.assertEqual(archive.getnames(), ['Dockerfile', 'replacement'])
            recipe = archive.extractfile('Dockerfile').read().decode()
            self.assertEqual(recipe, 'FROM cc-space-repair-base:' + image[7:] + '\nCOPY --chown=0:0 replacement /app/' + m.ASSET + '\n')
            self.assertEqual(archive.extractfile('replacement').read(), b'asset')
            self.assertEqual(archive.getmember('replacement').mode, 0o644)
        with self.assertRaises(RuntimeError): m.context('untrusted:latest', b'asset')

    def test_wrong_descriptor_and_corrupt_staged_asset_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            program = Path(directory).resolve()
            path = program / m.ASSET
            path.parent.mkdir(parents=True)
            path.write_bytes(b'asset')
            descriptor = json.dumps({'files': {m.ASSET: {'size': 5, 'sha256': hashlib.sha256(b'asset').hexdigest()}}}).encode()
            (program / 'SERVER-RELEASE.json').write_bytes(descriptor)
            with self.assertRaises(RuntimeError): m.build_context(program)
            with patch.object(m, 'DESCRIPTOR', hashlib.sha256(descriptor).hexdigest()):
                self.assertEqual(m.build_context(program), b'asset')
                path.write_bytes(b'wrong')
                with self.assertRaises(RuntimeError): m.build_context(program)

    def test_running_and_stopped_container_references_both_prevent_repair(self):
        for state in ('running', 'exited'):
            with self.subTest(state=state), patch.object(m, 'docker', side_effect=[b'container', json.dumps([{'Image': 'image', 'State': {'Status': state}}]).encode()]):
                with self.assertRaises(RuntimeError): m.unused('image')

    def test_check_uses_network_disabled_read_only_container_and_never_executes_claude(self):
        with patch.object(m, 'docker', return_value=b'[]') as docker:
            self.assertEqual(m.check('image'), [])
        args = docker.call_args.args
        self.assertIn('--network=none', args)
        self.assertIn('--read-only', args)
        self.assertIn('--pull=never', args)
        self.assertEqual(args[args.index('--entrypoint') + 1], '/opt/runtime/node/bin/node')

    @unittest.skipUnless(os.name == 'posix', 'Requires real flock')
    def test_main_revalidates_all_files_and_restores_original_tag_when_postcheck_fails(self):
        for failure in (False, True):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                program = root / 'build16-fixture/program'; program.mkdir(parents=True)
                asset = program / m.ASSET; asset.parent.mkdir(parents=True); asset.write_bytes(b'asset')
                descriptor = json.dumps({'files': {m.ASSET: {'size': 5, 'sha256': hashlib.sha256(b'asset').hexdigest()}}}).encode()
                (program / 'SERVER-RELEASE.json').write_bytes(descriptor)
                before, after = 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64
                built, calls = [], []
                def docker(*args, **kwargs):
                    calls.append(args)
                    if args[:2] == ('image', 'inspect'):
                        value = after if built and args[2] == m.TAG else before
                        return json.dumps([{'Id': value}]).encode()
                    if args[0] == 'build':
                        self.assertIn('--network=none', args)
                        self.assertIn('--pull=false', args)
                        self.assertTrue(kwargs['input'])
                        built.append(True)
                    return b''
                with patch.object(m, 'ROOT', root), patch.object(m, 'DESCRIPTOR', hashlib.sha256(descriptor).hexdigest()), \
                     patch.object(m, 'docker', side_effect=docker), patch.object(m, 'check', side_effect=[[m.ASSET], [m.ASSET] if failure else []]), \
                     patch.object(m.socket, 'gethostname', return_value='ubuntu-cc'), \
                     patch.object(m.os, 'geteuid', return_value=0), patch('sys.argv', ['repair', '--program', str(program)]):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, 'full validation'): m.main()
                    else:
                        m.main()
                report = json.loads(next(root.glob('candidate-repair-*.json')).read_text())
                self.assertEqual(report['state'], 'failed' if failure else 'validated')
                self.assertEqual(('tag', before, m.TAG) in calls, failure)


if __name__ == '__main__':
    unittest.main()
