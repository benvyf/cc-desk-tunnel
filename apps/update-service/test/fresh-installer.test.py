"""Isolated installer tests: synthetic releases, no apt/Docker/provider requests."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

WEB = pathlib.Path(__file__).resolve().parents[1] / 'web'
spec = importlib.util.spec_from_file_location('fresh', WEB / 'fresh-install.py')
fresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fresh)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cc-fresh-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(fresh, 'ROOT', self.root))
        self.stack.enter_context(patch.object(fresh, 'DATA', self.root / 'data'))
        self.stack.enter_context(patch.object(fresh, 'LOGIN', self.root / 'login-helper'))

    def signed_index(self):
        key, pub = self.root / 'fixture.key', self.root / 'fixture.pub'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)], check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(pub)], check=True, capture_output=True)
        self.stack.enter_context(patch.object(fresh, 'KEYS', {'fixture': pub.read_text()}))
        now = fresh.datetime.datetime.now(fresh.datetime.timezone.utc)
        release = {'build': 3, 'protocol': 20, 'appVersion': '0.3.6', 'size': 100,
                   'runtimeLevel': 'node24-cli2.1.295-v1'}
        payload = json.dumps({'schema': 1, 'product': 'cc-desk-tunnel-managed-server',
            'channel': 'pilot', 'platform': 'linux', 'arch': 'x64', 'revision': 1,
            'issuedAt': (now - fresh.datetime.timedelta(seconds=1)).isoformat(),
            'expiresAt': (now + fresh.datetime.timedelta(hours=1)).isoformat(), 'release': release}).encode()
        (self.root / 'fixture.payload').write_bytes(payload)
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin',
                        '-in', str(self.root / 'fixture.payload'), '-out', str(self.root / 'fixture.sig')], check=True, capture_output=True)
        encode = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
        return {'keyId': 'fixture', 'payload': encode(payload),
                'signature': encode((self.root / 'fixture.sig').read_bytes())}, release

    @unittest.skipUnless(os.name == 'posix', 'Ubuntu OpenSSL verification')
    def test_real_ed25519_accepts_valid_and_rejects_modified_release(self):
        index, release = self.signed_index()
        self.assertEqual(fresh.verify_index(json.dumps(index)), release)
        payload = base64.urlsafe_b64decode(index['payload'] + '===')
        index['payload'] = base64.urlsafe_b64encode(payload.replace(b'0.3.6', b'9.9.9')).decode().rstrip('=')
        with self.assertRaises(fresh.InstallError): fresh.verify_index(json.dumps(index))

    def test_pinned_helper_is_the_exact_existing_extraction_and_offline_smoke_code(self):
        content = (WEB / 'server-bootstrap.py').read_bytes()
        self.assertEqual(hashlib.sha256(content).hexdigest(), fresh.SUPPORT_SHA)
        with patch.object(fresh, 'download', return_value=content):
            helper = fresh.support_module()
        self.assertTrue(callable(helper.unpack))
        with patch.object(fresh, 'download', return_value=content + b'\n'):
            with self.assertRaises(fresh.InstallError): fresh.support_module()

    def test_existing_data_refused_without_consuming_code_or_running_commands(self):
        fresh.DATA.mkdir()
        with patch.object(fresh, 'download') as download, patch.object(fresh, 'run') as run:
            with self.assertRaisesRegex(fresh.InstallError, 'Existing /srv'):
                fresh.check_empty_machine()
            download.assert_not_called()
            run.assert_not_called()

    @unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'isolated Linux root fixture')
    def test_full_install_orchestration_and_retry_use_cached_credentials_without_reset(self):
        import types
        release = {'build': 3, 'protocol': 20, 'appVersion': '0.3.6', 'sha256': 'b' * 64,
                   'packageLockSha256': hashlib.sha256(b'fixture lock').hexdigest()}
        bundle = {'nodeId': 'fixture-2', 'origin': fresh.ORIGIN, 'index': 'synthetic index',
                  'monitorToken': 'm' * 43, 'moderationToken': 'r' * 43}
        def unpack(data, program, target):
            (program / 'deploy/docker').mkdir(parents=True)
            (program / 'deploy/docker/managed-settings.json').write_bytes(b'{}')
            (program / 'deploy/managed-server.json').write_text(json.dumps({'keys': fresh.KEYS, 'origin': fresh.ORIGIN, 'build': 3}))
            (program / 'package-lock.json').write_bytes(b'fixture lock')
        def runtime(work): (work / 'runtime').mkdir(exist_ok=True)
        commands = []
        containers = []
        def run(args, **kwargs):
            commands.append(args)
            if args[:2] == ['apt-get', 'update']: return ''
            if args[0] == 'openssl': return actual_run(args, **kwargs)
            if args == ['hostname', '-I']: return '192.168.1.42 172.17.0.1'
            if args[:3] == ['docker', 'ps', '-a']: return '\n'.join(containers)
            if args[:2] == ['docker', 'run']: containers.append(fresh.CONTAINER)
            if args[:2] == ['docker', 'inspect']: return bundle['nodeId']
            return ''
        actual_run = fresh.run
        helper = types.SimpleNamespace(unpack=unpack, offline_preflight=unittest.mock.Mock(), live_status=unittest.mock.Mock())
        args = types.SimpleNamespace(node='fixture-2', origin=fresh.ORIGIN, code='x' * 43)
        with patch.object(fresh.platform, 'freedesktop_os_release', return_value={'ID': 'ubuntu', 'VERSION_ID': '24.04'}), \
             patch.object(fresh.platform, 'machine', return_value='x86_64'), \
             patch.object(fresh, 'check_empty_machine'), \
             patch.object(fresh, 'download', side_effect=[json.dumps(bundle).encode(), b'fixture archive']), \
             patch.object(fresh, 'verify_index', return_value=release), \
             patch.object(fresh, 'support_module', return_value=helper), \
             patch.object(fresh, 'provision_runtime', side_effect=runtime), \
             patch.object(fresh, 'run', side_effect=run), \
             patch.object(fresh.shutil, 'disk_usage', return_value=types.SimpleNamespace(free=10 * 1024 ** 3)), \
             contextlib.redirect_stdout(io.StringIO()):
            fresh.install(args)
            credentials = (fresh.DATA / 'config/service.env').read_bytes()
            self.assertIn(b'PROXY_MONITOR_TOKEN=' + b'm' * 43, credentials)
            self.assertIn(b'192.168.1.42', (fresh.ROOT / 'connection.txt').read_bytes())
            self.assertEqual(fresh.DATA.stat().st_uid, 1000)
            self.assertEqual((fresh.ROOT / 'policy').stat().st_mode & 0o777, 0o755)
            self.assertEqual((fresh.DATA / 'config/service.env').stat().st_mode & 0o777, 0o600)
            self.assertIn('readonly', next(arg for cmd in commands for arg in cmd if arg.endswith('/etc/claude-code,readonly')))
            helper.offline_preflight.assert_called_once()
            helper.live_status.assert_called_once()
            self.assertNotIn('claude" --version', fresh.DOCKERFILE)
            count = len(commands)
            fresh.install(args)
            self.assertEqual(len(commands), count)
            self.assertEqual((fresh.DATA / 'config/service.env').read_bytes(), credentials)
        self.assertTrue(fresh.LOGIN.exists())
        # Writing the helper does not execute it, including on a repeated install.
        self.assertFalse(any('/opt/runtime/cli/bin/claude' in cmd for cmd in commands))


if __name__ == '__main__': unittest.main()
