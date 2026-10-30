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

    def test_policy_migration_keeps_independent_hooks_settings_and_a_backup(self):
        self.configure()
        target = self.data/'.managed/claude-code/managed-settings.json'
        original = copy.deepcopy(m.EXPECTED_POLICY)
        own = copy.deepcopy(original['hooks']['UserPromptSubmit'][0]['hooks'][0])
        independent = {'type':'command','command':'/administrator/independent-hook'}
        original['env'] = {'EXAMPLE_SETTING':'preserved'}
        original['hooks']['UserPromptSubmit'][0]['hooks'].append(independent)
        for event in ('PostToolBatch','UserPromptExpansion','PreCompact','Stop'):
            original['hooks'][event] = [{'matcher':'fixture','hooks':[own,independent]}]
        before = json.dumps(original).encode()
        target.write_bytes(before)
        result = self.configure()
        migrated = json.loads(target.read_bytes())
        self.assertEqual(migrated['env'],original['env'])
        self.assertIn(m.EXPECTED_POLICY['hooks']['UserPromptSubmit'][0],
                      migrated['hooks']['UserPromptSubmit'])
        for event in ('UserPromptSubmit','PostToolBatch','UserPromptExpansion','PreCompact','Stop'):
            self.assertTrue(any(independent in group['hooks'] for group in migrated['hooks'][event]))
        for event in ('PostToolBatch','UserPromptExpansion','PreCompact','Stop'):
            self.assertEqual(migrated['hooks'][event],[{'matcher':'fixture','hooks':[independent]}])
        self.assertEqual((Path(result['backupDirectory'])/'0-managed-settings.json').read_bytes(),before)
        m.check(self.data,self.config)
        self.assertFalse(self.configure()['changed'])

    def test_policy_migration_reads_the_configured_mount_and_leaves_it_intact(self):
        external = self.root/'original-policy'
        external.mkdir()
        policy = copy.deepcopy(m.EXPECTED_POLICY)
        policy['hooks']['PreCompact'] = [{'hooks':[{'type':'command','command':'/administrator/independent-hook'}]}]
        before = json.dumps(policy).encode()
        (external/'managed-settings.json').write_bytes(before)
        self.config.write_bytes(self.before_config + ("MANAGED_CONFIG_DIR='"+str(external)+"'\n").encode())
        self.configure()
        migrated = json.loads((self.data/'.managed/claude-code/managed-settings.json').read_bytes())
        self.assertEqual(migrated['hooks']['PreCompact'],policy['hooks']['PreCompact'])
        self.assertEqual((external/'managed-settings.json').read_bytes(),before)

    def test_migration_does_not_reenable_globally_disabled_independent_hooks(self):
        self.configure()
        target = self.data/'.managed/claude-code/managed-settings.json'
        policy = copy.deepcopy(m.EXPECTED_POLICY)
        policy['disableAllHooks'] = True
        policy['hooks']['Stop'] = [{'hooks':[{'type':'command','command':'/administrator/independent-hook'}]}]
        before = json.dumps(policy).encode()
        target.write_bytes(before)
        service = self.service.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'disables all hooks'):
            self.configure()
        self.assertEqual(target.read_bytes(),before)
        self.assertEqual(self.service.read_bytes(),service)

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
        policy_path = self.data/'.managed/claude-code/managed-settings.json'
        original_policy = copy.deepcopy(m.EXPECTED_POLICY)
        original_policy['hooks']['PreCompact'] = [{'hooks':[{'type':'command','command':'/administrator/independent-hook'}]}]
        old_policy = json.dumps(original_policy).encode()
        policy_path.write_bytes(old_policy)
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
        self.assertEqual(policy_path.read_bytes(),old_policy)

    def test_policy_with_disabled_or_missing_hook_is_rejected_before_mutation(self):
        policy = self.root/'bad-policy.json'
        changed = copy.deepcopy(m.EXPECTED_POLICY)
        changed['hooks']['UserPromptSubmit'][0]['hooks'][0]['onFailure'] = 'ignore'
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

    @unittest.skipUnless(sys.platform == 'linux', 'requires Linux ownership and Bash')
    def test_restore_ownership_keeps_admin_policy_protected_before_reimport(self):
        self.configure()
        managed = self.data/'.managed/claude-code'
        previous_policy = copy.deepcopy(m.EXPECTED_POLICY)
        previous_policy['hooks']['PostToolBatch'] = copy.deepcopy(previous_policy['hooks']['UserPromptSubmit'])
        independent = {'hooks':[{'type':'command','command':'/administrator/independent-hook'}]}
        previous_policy['hooks']['PreCompact'] = [independent]
        (managed/'managed-settings.json').write_text(json.dumps(previous_policy))
        workspace = self.data/'workspace'
        workspace.mkdir()
        user_file = workspace/'keep.txt'
        user_file.write_text('preserve user data')
        outside = self.root/'outside.txt'
        outside.write_text('do not change ownership')
        (workspace/'outside-link').symlink_to(outside)
        script = Path(__file__).with_name('manage.sh').read_text()
        start = script.index('restore_ownership() {')
        function = script[start:script.index('\n}',start)+2]
        result = subprocess.run(['bash','-eu','-c',function+'\nrestore_ownership "$1"',
                                 'restore-test',str(self.data)],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        m.configure(self.data,self.config,managed/'moderation-node.json')
        m.check(self.data,self.config)
        self.assertEqual(user_file.stat().st_uid,1000)
        self.assertEqual(outside.stat().st_uid,0)
        self.assertEqual((managed/'managed-settings.json').stat().st_uid,0)
        self.assertEqual(json.loads((managed/'managed-settings.json').read_bytes())['hooks']['PreCompact'],[independent])

    @unittest.skipUnless(sys.platform == 'linux', 'requires Linux uid isolation and Bash')
    def test_nonroot_restore_stops_before_extracting_data(self):
        script = Path(__file__).with_name('manage.sh').read_text()
        branch = script.split('\n  restore)\n',1)[1].split('    running &&',1)[0]
        code = 'fail() { echo "$*" >&2; exit 1; }\n'+branch+'\nprintf RESTORE_WOULD_CONTINUE'
        result = subprocess.run(['bash','-eu','-c',code,'restore-test','/unused-backup'],
                                preexec_fn=lambda: os.setuid(1000),capture_output=True,text=True,timeout=10)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Use sudo',result.stderr)
        self.assertNotIn('RESTORE_WOULD_CONTINUE',result.stdout)

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
