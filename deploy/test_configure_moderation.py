"""Credential import/rollback tests use temporary files and disposable keys; never a network."""
import copy
import base64
import hashlib
import shutil
import subprocess
import sys
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('review_config', Path(__file__).with_name('configure-moderation.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        (self.data / 'config').mkdir(parents=True)
        (self.data / '.cc-desk-tunnel-data').write_text('fixture')
        self.service = self.data / 'config/service.env'
        self.before = b"PROXY_TOKEN='fixture-service'\nDISABLE_TELEMETRY='1'\nDISABLE_ERROR_REPORTING='1'\nDISABLE_AUTOUPDATER='1'\nHTTPS_PROXY='keep'\n"
        self.service.write_bytes(self.before)
        self.config = self.root / 'docker.env'
        self.config.write_bytes(b"DATA_DIR='fixture'\nPROXY_IMAGE='do-not-change'\n")
        self.before_config = self.config.read_bytes()
        self.node = self.root / 'node.json'
        self.node_data = dict(endpoint='https://127.0.0.1/cc-updates/v1/moderation/check',
                              nodeId='independent-node-fixture', token='x'*43)
        self.node.write_text(json.dumps(self.node_data))
        self.provider = self.data / 'config/provider.json'
        self.provider.write_text('{"account":"preserve"}')
        if os.name != 'posix':
            # Windows has no POSIX ownership/modes; Linux CI exercises the actual metadata guard.
            item = patch.object(m, 'protected', lambda path: None)
            item.start()
            self.addCleanup(item.stop)
            real_metadata = m.metadata
            def windows_metadata(path):
                mode, owner = real_metadata(path)
                return (0o644, owner) if path.parent.name == 'claude-code' else (mode, owner)
            item = patch.object(m, 'metadata', windows_metadata)
            item.start()
            self.addCleanup(item.stop)
        elif os.geteuid() != 0:
            self.skipTest('Run Linux configuration tests as root')

    def configure(self):
        return m.configure(self.data,self.config,self.node)

    def test_import_preserves_service_account_transport_and_original_credential(self):
        result = self.configure()
        self.assertTrue(result['changed'])
        self.assertEqual(self.node.read_text(),json.dumps(self.node_data))
        managed = self.data / '.managed/claude-code'
        self.assertEqual((managed/'moderation-node.json').read_bytes(),self.node.read_bytes())
        self.assertEqual(json.loads((managed/'managed-settings.json').read_text()),m.EXPECTED_POLICY)
        self.assertEqual(self.provider.read_text(),'{"account":"preserve"}')
        self.assertIn(self.before,self.service.read_bytes())
        self.assertEqual(m.value(self.service.read_bytes(),'PROXY_MODERATION_CONFIG'),m.NODE_PATH)
        self.assertEqual(m.value(self.service.read_bytes(),'PROXY_NATIVE_TERMINAL_REVIEW'),'1')
        self.assertEqual(m.value(self.config.read_bytes(),'PROXY_IMAGE'),'do-not-change')
        m.check(self.data,self.config)

    def test_same_input_is_idempotent_and_does_not_create_another_backup(self):
        self.configure()
        backups = list((self.data/'.managed/backups').iterdir())
        result = self.configure()
        self.assertFalse(result['changed'])
        self.assertEqual(list((self.data/'.managed/backups').iterdir()),backups)

    def test_invalid_nodes_fail_before_creating_managed_state(self):
        for node in [{}, {**self.node_data,'token':'short'},
                     {**self.node_data,'endpoint':'http://127.0.0.1/cc-updates/v1/moderation/check'},
                     {**self.node_data,'endpoint':'https://u:p@127.0.0.1/cc-updates/v1/moderation/check'},
                     {**self.node_data,'endpoint':'https://127.0.0.1/cc-updates/v1/moderation/check?q=1'},
                     {**self.node_data,'nodeId':'space not allowed'}]:
            self.node.write_text(json.dumps(node))
            with self.assertRaises(RuntimeError):
                self.configure()
            self.assertFalse((self.data/'.managed').exists())
            self.assertEqual(self.service.read_bytes(),self.before)

    def test_duplicate_gate_settings_fail_before_mutation(self):
        self.service.write_bytes(self.before+b'PROXY_NATIVE_TERMINAL_REVIEW=0\nPROXY_NATIVE_TERMINAL_REVIEW=1\n')
        with self.assertRaisesRegex(RuntimeError,'Duplicate'):
            self.configure()
        self.assertFalse((self.data/'.managed').exists())

    def test_partial_write_restores_original_files_without_removing_user_data(self):
        real_atomic = m.atomic
        def fail(path, content, mode=None, owner=None):
            if path == self.config and b'MANAGED_CONFIG_DIR' in content:
                raise RuntimeError('fixture disk write failure')
            return real_atomic(path,content,mode,owner)
        with patch.object(m,'atomic',fail):
            with self.assertRaisesRegex(RuntimeError,'disk write'):
                self.configure()
        self.assertEqual(self.service.read_bytes(),self.before)
        self.assertEqual(self.config.read_bytes(),self.before_config)
        self.assertEqual(self.provider.read_text(),'{"account":"preserve"}')
        self.assertFalse((self.data/'.managed/claude-code/moderation-node.json').exists())

    def test_reconfiguration_failure_keeps_previous_issued_credential(self):
        self.configure()
        old = (self.data/'.managed/claude-code/moderation-node.json').read_bytes()
        self.node.write_text(json.dumps({**self.node_data,'token':'y'*43}))
        real_atomic = m.atomic
        failed = False
        def fail(path, content, mode=None, owner=None):
            nonlocal failed
            if path == self.service and not failed:
                failed = True
                raise RuntimeError('fixture failure')
            return real_atomic(path,content,mode,owner)
        with patch.object(m,'atomic',fail):
            with self.assertRaises(RuntimeError):
                self.configure()
        self.assertEqual((self.data/'.managed/claude-code/moderation-node.json').read_bytes(),old)

    def test_policy_with_disabled_or_missing_hook_is_rejected_before_mutation(self):
        policy = self.root/'bad-policy.json'
        changed = copy.deepcopy(m.EXPECTED_POLICY)
        changed['hooks']['PostToolBatch'][0]['hooks'][0]['onFailure'] = 'ignore'
        policy.write_text(json.dumps(changed))
        with self.assertRaisesRegex(RuntimeError,'policy'):
            m.configure(self.data,self.config,self.node,policy)
        self.assertFalse((self.data/'.managed').exists())

    def test_restore_can_reimport_its_own_saved_node_and_reassert_flags(self):
        self.configure()
        saved = self.data/'.managed/claude-code/moderation-node.json'
        self.service.write_bytes(self.before+b'PROXY_NATIVE_TERMINAL_REVIEW=0\n')
        m.configure(self.data,self.config,saved)
        self.assertEqual(saved.read_bytes(),self.node.read_bytes())
        m.check(self.data,self.config)

    def test_removed_review_setting_is_rejected_by_read_only_check(self):
        self.configure()
        self.service.write_bytes(self.before)
        with self.assertRaisesRegex(RuntimeError,'incomplete'):
            m.check(self.data,self.config)
        self.assertEqual(self.service.read_bytes(),self.before)

    @unittest.skipUnless(os.name=='posix','requires Linux root CLI')
    def test_root_cli_configure_and_check_succeed(self):
        command = [sys.executable,str(Path(m.__file__)),'configure','--data',str(self.data),
                   '--deploy-config',str(self.config),'--node-config',str(self.node)]
        result = subprocess.run(command,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(json.loads(result.stdout)['configured'])
        check = subprocess.run([*command[:2],'check',*command[3:-2]],capture_output=True,text=True,timeout=10)
        self.assertEqual(check.returncode,0,check.stderr)
        self.assertNotIn('x'*43,result.stdout+result.stderr+check.stdout+check.stderr)

    @unittest.skipUnless(os.name=='posix','requires POSIX symlinks')
    def test_root_cli_rejects_symlink_lock_without_mutating_node_files(self):
        private = self.data/'.managed'
        private.mkdir()
        outside = self.root/'keep-private'
        outside.write_text('keep this unchanged')
        (private/'configuration.lock').symlink_to(outside)
        command = [sys.executable,str(Path(m.__file__)),'configure','--data',str(self.data),
                   '--deploy-config',str(self.config),'--node-config',str(self.node)]
        result = subprocess.run(command,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(outside.read_text(),'keep this unchanged')
        self.assertFalse((private/'claude-code/moderation-node.json').exists())

    @unittest.skipUnless(os.name=='posix','requires POSIX file ownership')
    def test_unprivileged_modification_is_rejected(self):
        self.configure()
        target = self.data/'.managed/claude-code/moderation-node.json'
        os.chown(target,1000,1000)
        with self.assertRaisesRegex(RuntimeError,'root owned'):
            m.check(self.data,self.config)


class InstallerIntegrityTest(unittest.TestCase):
    def verify_archive(self, valid):
        node = os.environ.get('CC_NATIVE_TEST_NODE') or shutil.which('node')
        if not node:
            self.skipTest('Node required to execute the real archive verifier')
        installer = Path(__file__).parents[1] / 'scripts/install-linux.sh'
        code = installer.read_text().split("node --input-type=module -e '",1)[1].split("\n  '",1)[0]
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'fixture-archive'
            archive.write_bytes(b'disposable fixture, never an executable')
            expected = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
            if not valid:
                archive.write_bytes(b'tampered fixture')
            result = subprocess.run([node,'--input-type=module','-e',code,str(archive),expected],
                                    capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode == 0,valid,result.stderr if valid else '')
    def test_verified_archive_bytes_are_accepted(self):
        self.verify_archive(True)
    def test_tampered_archive_is_rejected_before_installation(self):
        self.verify_archive(False)


if __name__ == '__main__':
    unittest.main()
