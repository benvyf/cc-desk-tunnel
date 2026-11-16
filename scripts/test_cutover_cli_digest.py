"""Exercise the cutover's actual Node integrity check before any service mutation."""
import ast
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cutover', ROOT/'scripts/install-cc-space-037.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
real_run = subprocess.run


class Admitted(Exception):
    pass


class CutoverDigestTests(unittest.TestCase):
    def check(self, expected_cli, actual_cli, descriptor_ok=True):
        descriptor = b'test signed descriptor'
        descriptor_sha = hashlib.sha256(descriptor).hexdigest()
        # Only replace the two filesystem reads. The actual JavaScript assertions
        # and digest computation from install() run in a real Node process.
        prefix = "const fs=require('fs');fs.readFileSync=p=>Buffer.from(p==='/app/SERVER-RELEASE.json'?process.env.TEST_DESCRIPTOR:process.env.TEST_CLI);"
        import os
        def run(args, **kwargs):
            self.assertIn('--network=none', args)
            self.assertIn('--read-only', args)
            index = args.index('-e')
            return real_run(['node', '-e', prefix + args[index+1], *args[index+2:]],
                env={**os.environ, 'TEST_DESCRIPTOR': descriptor.decode(), 'TEST_CLI': actual_cli},
                **kwargs)
        original = {'Image': m.BASE}
        class Engine:
            def request(self, method, path):
                if method != 'GET':
                    raise AssertionError('Service mutation before integrity admission')
                return original if path.startswith('/containers/') else {'Id': 'candidate'}
        b = SimpleNamespace(Engine=Engine, CONTAINER='production',
            validate_runtime=lambda value: None, runtime_and_policy=lambda value: None,
            urllib=SimpleNamespace(parse=SimpleNamespace(quote=lambda value, **kw: value)))
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(m, 'DATA', Path(directory)), \
                 patch.object(m, 'DESCRIPTOR', descriptor_sha if descriptor_ok else '0'*64), \
                 patch.object(m, 'CLI_SHA256', expected_cli, create=True), \
                 patch.object(m, 'check_space', side_effect=Admitted), \
                 patch.object(m.subprocess, 'run', side_effect=run):
                m.install(b, disconnect_clients=True)

    def test_configured_new_cli_passes_before_service_changes(self):
        with self.assertRaises(Admitted):
            self.check(hashlib.sha256(b'new CLI').hexdigest(), 'new CLI')

    def test_configured_old_cli_still_passes(self):
        with self.assertRaises(Admitted):
            self.check(hashlib.sha256(b'old CLI').hexdigest(), 'old CLI')

    def test_changed_cli_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'before cold backup or service changes'):
            self.check(hashlib.sha256(b'new CLI').hexdigest(), 'changed CLI')

    def test_changed_descriptor_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'before cold backup or service changes'):
            self.check(hashlib.sha256(b'new CLI').hexdigest(), 'new CLI', False)

    def test_host_entrypoint_supplies_its_authenticated_cli(self):
        tree = ast.parse((ROOT/'deploy/host-update/apply.py').read_text(encoding='utf-8'))
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        assignments = [n for n in ast.walk(main) if isinstance(n, ast.Assign)
            and any(isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name)
                and t.value.id == 'legacy' and t.attr == 'CLI_SHA256' for t in n.targets)]
        legacy = SimpleNamespace()
        exec(compile(ast.Module(body=assignments, type_ignores=[]), '<handoff>', 'exec'),
             {'legacy': legacy, 'CLI': 'authenticated target digest'})
        self.assertEqual(legacy.CLI_SHA256, 'authenticated target digest')


if __name__ == '__main__':
    unittest.main()
