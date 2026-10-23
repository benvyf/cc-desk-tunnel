"""Exercise native cutover transactions offline; no Docker daemon, accounts or network."""
import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_cutover', Path(__file__).with_name('activate-native-terminal.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeCutoverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        state, source, data = root / 'state', root / 'source', root / 'data'
        work = state / 'activation'
        for path in (work, source / '.local', source / 'deploy/docker', data / 'config', data / 'tls',
                     data / 'home/.claude', data / 'state'):
            path.mkdir(parents=True, exist_ok=True)
        replacements = dict(STATE=state, WORK=work, BACKUP=work / 'backup', MANAGED=work / 'managed',
            DATA=data, SOURCE=source, CONFIG=source / '.local/docker.env',
            COMPOSE=source / 'deploy/docker/compose.yaml', SERVICE_ENV=data / 'config/service.env',
            NODE_CONFIG=data / 'config/moderation-node.json')
        for name, value in replacements.items():
            item = patch.object(m, name, value)
            item.start()
            self.addCleanup(item.stop)
        (data / '.cc-desk-tunnel-data').write_text('fixture')
        m.CONFIG.write_bytes(b"PROXY_IMAGE='cc-desk-tunnel:chat-fixture'\nCONTROL_PORT=8787\nOTHER=keep\n")
        self.config_before = m.CONFIG.read_bytes()
        m.SERVICE_ENV.write_bytes(b'PROXY_MODERATION_CONFIG=/data/config/moderation-node.json\n'
            b'DISABLE_TELEMETRY=1\nDISABLE_ERROR_REPORTING=1\nDISABLE_AUTOUPDATER=1\nOTHER=keep\n')
        self.env_before = m.SERVICE_ENV.read_bytes()
        m.COMPOSE.write_bytes(b'services:\n  proxy:\n    image: ${PROXY_IMAGE}\n'
            b'    volumes:\n      - "${DATA_DIR:?Run manage.sh init}:/data"\n'
            b'    restart: unless-stopped\n')
        self.compose_before = m.COMPOSE.read_bytes()
        m.NODE_CONFIG.write_text(json.dumps(dict(endpoint=m.ENDPOINT, nodeId='ubuntu-cc', token='x' * 43)))
        (data / 'config/provider.json').write_text('{"fixture":true}')
        (data / 'tls/control.crt').write_text('fixture certificate')
        (data / 'home/.claude/.credentials.json').write_text('fixture credentials, never used')
        self.image_config = dict(Env=['HOME=/data/home'], Entrypoint=['fixture-entrypoint'], Cmd=['server'],
                                 User='1000', WorkingDir='/data/workspace', Healthcheck={'Test': ['fixture']})
        self.before = dict(Id='original-container', Image=m.BASE,
            State=dict(StartedAt='fixture-start', Running=True, Health={'Status': 'healthy'}),
            Mounts=[dict(Type='bind', Source=str(data), Destination='/data', RW=True)],
            Config=dict(Env=['HOME=/data/home'], Labels={'com.docker.compose.project':m.PROJECT,
                                                       'com.docker.compose.service':'proxy'}),
            HostConfig=dict(NetworkMode='unchanged-network', RestartPolicy={'Name':'unless-stopped'},
                            Dns=[], SecurityOpt=['no-new-privileges'], CapDrop=['ALL']))
        self.current = copy.deepcopy(self.before)
        (state / 'production-before.json').write_text(json.dumps(self.before))
        accepted = dict(sourceCommit=m.COMMIT, imageId=m.IMAGE, restrictions=['direct-prompt-command-expansions-blocked'],
            inputPathAcceptancePassed=True, protectedFilesAndRuntimeUnchanged=True, productionUnchanged=True,
            nativePromptReviewed=True, nativeQuestionAnswerReviewed=True, compactInstructionsReviewed=True,
            sdkCompatible=True, queuedPromptReviewed=True, unsupportedCommandExpansionBlocked=True,
            resumedHistoryReviewed=True, permissionDenialFeedbackReviewed=True, permissionAmendFeedbackReviewed=True,
            cutoverPerformed=False, rejectedPromptReachedSimulatedModel=False,
            rejectedAnswerReachedSimulatedModel=False, rejectedCompactReachedSimulatedModel=False,
            realModelRequests=0, realJevRequests=0)
        (state / 'result.json').write_text(json.dumps(accepted))
        self.calls = []
        self.clients = 0
        self.active_runs = 0
        self.policy_invalid = False
        self.fail_new_verify = False
        self.fail_new_up = False
        self.fail_tar = False
        self.extra_compose_change = False
        for name, value in dict(run=self.command, inspect=self.inspect).items():
            item = patch.object(m, name, value)
            item.start()
            self.addCleanup(item.stop)
        self.output = io.StringIO()
        quiet = contextlib.redirect_stdout(self.output)
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)

    def inspect(self, kind, name):
        if kind == 'image':
            return dict(Id=m.IMAGE if name in (m.TAG, m.IMAGE) else m.BASE,
                        Config=copy.deepcopy(self.image_config))
        if self.current is None:
            raise subprocess.CalledProcessError(1, ['docker', 'container', 'inspect'])
        return copy.deepcopy(self.current)

    def command(self, *args, input=None, timeout=None):
        args = tuple(str(arg) for arg in args)
        self.calls.append(args)
        if args[:2] == ('docker', 'compose'):
            self.assertEqual(Path(args[args.index('--project-directory')+1]), m.COMPOSE.parent)
            config, compose = Path(args[args.index('--env-file')+1]), Path(args[args.index('-f')+1])
            command = args[args.index('-f')+2:]
            reviewed = m.env_value(config.read_bytes(), 'PROXY_IMAGE') == m.TAG
            if command[0] == 'config':
                volumes = [dict(type='bind', source=str(m.DATA), target='/data', bind={'create_host_path':True})]
                if b'/etc/claude-code' in compose.read_bytes():
                    # Compose versions may omit a false create_host_path value when normalizing.
                    addition = dict(type='bind', source=str(m.MANAGED), target='/etc/claude-code',
                                    read_only=True, bind={})
                    volumes.append(addition)
                service = dict(image=m.TAG if reviewed else 'cc-desk-tunnel:chat-fixture', volumes=volumes,
                               restart='unless-stopped', build={'context':str(m.SOURCE)})
                if self.extra_compose_change and reviewed:
                    service['dns'] = ['unrequested-route-change']
                return json.dumps({'name':m.PROJECT, 'services':{'proxy':service}})
            if command[0] == 'stop':
                if self.current is not None:
                    self.current['State']['Running'] = False
                return ''
            if command[0] == 'up':
                self.assertIn('--no-build', command)
                self.assertEqual(command[command.index('--pull')+1], 'never')
                if reviewed and self.fail_new_up:
                    self.current = None  # Compose removed old container before failing to recreate it.
                    raise RuntimeError('fixture recreate failure')
                self.current = copy.deepcopy(self.before)
                self.current['Image'] = m.IMAGE if reviewed else m.BASE
                self.current['Id'] = 'native-container' if reviewed else 'restored-container'
                if b'/etc/claude-code' in compose.read_bytes():
                    self.current['Mounts'].append(dict(Type='bind', Source=str(m.MANAGED),
                        Destination=m.POLICY_TARGET, RW=False))
                return ''
        if args[:2] == ('docker', 'run'):
            self.assertIn('--network=none', args)
            self.assertIn('--read-only', args)
            if args[args.index('--entrypoint')+1] == 'cat':
                return json.dumps({} if self.policy_invalid else m.POLICY)
            self.assertIn('type=bind,src='+str(m.MANAGED)+',dst='+m.POLICY_TARGET+',readonly', args)
            self.assertFalse(any(str(m.DATA)+':' in arg for arg in args))
            self.assertEqual((m.MANAGED / 'moderation-node.json').read_bytes(), m.NODE_CONFIG.read_bytes())
            return 'OFFLINE_POLICY_OK'
        if args[:3] == ('docker', 'exec', '-i'):
            if input == m.IDLE_JS:
                return 'NATIVE_ACTIVATION_RESULT '+json.dumps({'activeRuns':self.active_runs,
                                                             'controlConnections':self.clients})
            enabled = 'const enabled=true;' in input
            if enabled and self.fail_new_verify:
                raise RuntimeError('fixture policy/health verification failure')
            self.assertEqual(enabled, m.env_value(m.SERVICE_ENV.read_bytes(), m.ENV_KEY) == '1')
            self.assertEqual(self.current['Image'], m.IMAGE if enabled else m.BASE)
            self.assertEqual(m.env_value(m.SERVICE_ENV.read_bytes(),'PROXY_MODERATION_CONFIG'),
                             '/data/config/moderation-node.json')
            return 'NATIVE_ACTIVATION_RESULT '+json.dumps(dict(protocol=20, controlAuthenticated=True,
                tlsUnchanged=True, chatModerationEnabled=True, nativeTerminalReviewEnabled=enabled,
                managedPolicyVerified=enabled, realModelRequests=0, realJevRequests=0, realTerminalOpened=False))
        if args[:3] == ('docker', 'container', 'ls'):
            return 'fixture-container' if self.current is not None else ''
        if args[:2] == ('docker', 'start'):
            self.current['State']['Running'] = True
            return ''
        if args[0] == 'du':
            return '1024 fixture'
        if args[0] == 'tar':
            if '-cpf' in args:
                if self.fail_tar:
                    raise RuntimeError('fixture archive failure')
                with tarfile.open(args[args.index('-cpf')+1], 'w') as archive:
                    archive.add(m.DATA, arcname='data')
            return ''
        raise AssertionError('Unexpected command: '+repr(args))

    def stopped(self):
        return any(args[:2] == ('docker','compose') and 'stop' in args for args in self.calls)

    def test_activation_archives_before_changing_only_intended_settings(self):
        m.activate()
        self.assertEqual(self.current['Image'], m.IMAGE)
        self.assertEqual(m.SERVICE_ENV.read_bytes(), self.env_before+b'PROXY_NATIVE_TERMINAL_REVIEW=1\n')
        self.assertEqual(m.COMPOSE.read_bytes(), self.compose_before.replace(
            b'      - "${DATA_DIR:?Run manage.sh init}:/data"\n',
            b'      - "${DATA_DIR:?Run manage.sh init}:/data"\n'+m.mount_block()))
        self.assertEqual(m.NODE_CONFIG.read_bytes(), (m.MANAGED / 'moderation-node.json').read_bytes())
        with tarfile.open(m.BACKUP / 'data.tar') as archive:
            self.assertEqual(archive.extractfile('data/config/service.env').read(), self.env_before)
        manifest = json.loads((m.BACKUP / 'manifest.json').read_text())
        self.assertTrue(manifest['backupComplete'])
        self.assertEqual(m.digest(m.BACKUP/'data.tar'), manifest['files']['data.tar'])
        result = json.loads((m.WORK / 'activation-result.json').read_text())
        self.assertTrue(result['cutoverPerformed'])
        self.assertTrue(result['readOnlyPolicyMountVerified'])
        self.assertFalse(result['realTerminalOpened'])
        self.assertEqual(result['realModelRequests'], result['realJevRequests'])
        self.assertNotIn('x'*43, self.output.getvalue())

    def test_rejected_candidate_stops_before_any_production_mutation(self):
        result = json.loads((m.STATE/'result.json').read_text())
        result['permissionAmendFeedbackReviewed'] = False
        (m.STATE/'result.json').write_text(json.dumps(result))
        with self.assertRaisesRegex(RuntimeError, 'acceptance is incomplete'):
            m.activate()
        self.assertFalse(self.stopped())
        self.assertFalse(m.BACKUP.exists())

    def test_incorrect_official_policy_never_stops_production(self):
        self.policy_invalid = True
        with self.assertRaisesRegex(RuntimeError, 'policy differs'):
            m.activate()
        self.assertFalse(self.stopped())
        self.assertEqual(m.SERVICE_ENV.read_bytes(), self.env_before)

    def test_unrelated_staged_compose_change_is_rejected_before_stop(self):
        self.extra_compose_change = True
        with self.assertRaisesRegex(RuntimeError, 'changes more than'):
            m.activate()
        self.assertFalse(self.stopped())

    def test_connected_client_prevents_cutover(self):
        self.clients = 1
        with self.assertRaisesRegex(RuntimeError, 'client is still connected'):
            m.activate()
        self.assertFalse(self.stopped())
        self.assertFalse(m.BACKUP.exists())

    def test_active_run_prevents_cutover(self):
        self.active_runs = 1
        with self.assertRaisesRegex(RuntimeError, 'Node is busy'):
            m.activate()
        self.assertFalse(self.stopped())

    def test_read_only_preflight_does_not_require_disconnected_clients(self):
        self.clients = 2
        m.preflight()
        self.assertFalse(self.stopped())
        self.assertEqual(m.CONFIG.read_bytes(), self.config_before)
        self.assertEqual(m.SERVICE_ENV.read_bytes(), self.env_before)
        self.assertEqual(m.COMPOSE.read_bytes(), self.compose_before)

    def test_archive_failure_restarts_original_container_without_configuration_changes(self):
        self.fail_tar = True
        with self.assertRaisesRegex(RuntimeError, 'archive failure'):
            m.activate()
        self.assertTrue(self.current['State']['Running'])
        self.assertEqual(self.current['Image'],m.BASE)
        self.assertEqual(m.CONFIG.read_bytes(),self.config_before)
        self.assertEqual(m.SERVICE_ENV.read_bytes(),self.env_before)

    def test_partial_file_update_is_automatically_rolled_back(self):
        real_replace = m.replace_file
        failed = False
        def replace(path, value):
            nonlocal failed
            if path == m.SERVICE_ENV and m.ENV_KEY.encode()+b'=1' in value and not failed:
                failed = True
                raise RuntimeError('fixture partial write failure')
            return real_replace(path,value)
        with patch.object(m,'replace_file',replace):
            with self.assertRaisesRegex(RuntimeError,'partial write failure'):
                m.activate()
        self.assertEqual(self.current['Image'],m.BASE)
        self.assertEqual(m.CONFIG.read_bytes(),self.config_before)
        self.assertEqual(m.COMPOSE.read_bytes(),self.compose_before)
        self.assertEqual(m.SERVICE_ENV.read_bytes(),self.env_before)

    def test_failed_recreation_with_no_container_recovers_original_image(self):
        self.fail_new_up = True
        with self.assertRaisesRegex(RuntimeError,'recreate failure'):
            m.activate()
        self.assertEqual(self.current['Image'],m.BASE)
        self.assertTrue(self.current['State']['Running'])
        self.assertEqual(m.COMPOSE.read_bytes(),self.compose_before)

    def test_failed_new_verification_rolls_back_and_keeps_chat_gate(self):
        self.fail_new_verify = True
        with self.assertRaisesRegex(RuntimeError,'verification failure'):
            m.activate()
        self.assertEqual(self.current['Image'],m.BASE)
        self.assertEqual(m.SERVICE_ENV.read_bytes(),self.env_before)
        self.assertEqual(m.NODE_CONFIG.read_bytes(),(m.MANAGED/'moderation-node.json').read_bytes())
        result = json.loads((m.WORK/'activation-result.json').read_text())
        self.assertTrue(result['rolledBack'])
        self.assertTrue(result['rollbackAutomatic'])
        self.assertFalse(result['dataRestored'])

    def test_later_rollback_preserves_new_data_credentials_and_unrelated_settings(self):
        m.activate()
        (m.DATA/'new-session').write_text('new user data must survive')
        m.NODE_CONFIG.write_text('{"updated":"new node credential must survive"}')
        m.SERVICE_ENV.write_bytes(m.SERVICE_ENV.read_bytes()+b'NEW_USER_SETTING=keep\n')
        m.CONFIG.write_bytes(m.CONFIG.read_bytes().replace(b'OTHER=keep',b'OTHER=updated'))
        m.COMPOSE.write_bytes(m.COMPOSE.read_bytes()+b'    stop_grace_period: 45s\n')
        m.rollback()
        self.assertEqual((m.DATA/'new-session').read_text(),'new user data must survive')
        self.assertIn('new node credential',m.NODE_CONFIG.read_text())
        self.assertEqual(m.SERVICE_ENV.read_bytes(),self.env_before+b'NEW_USER_SETTING=keep\n')
        self.assertEqual(m.CONFIG.read_bytes(),self.config_before.replace(b'OTHER=keep',b'OTHER=updated'))
        self.assertEqual(m.COMPOSE.read_bytes(),self.compose_before+b'    stop_grace_period: 45s\n')
        self.assertEqual(self.current['Image'],m.BASE)

    def test_backup_corruption_refuses_rollback_before_stopping_active_service(self):
        m.activate()
        (m.BACKUP/'service.env').write_text('corrupted backup')
        self.calls.clear()
        with self.assertRaisesRegex(RuntimeError,'checksum mismatch'):
            m.rollback()
        self.assertFalse(self.stopped())
        self.assertEqual(self.current['Image'],m.IMAGE)

    def test_edited_native_flag_conflict_refuses_rollback_without_partial_restore(self):
        m.activate()
        m.SERVICE_ENV.write_bytes(m.SERVICE_ENV.read_bytes().replace(b'PROXY_NATIVE_TERMINAL_REVIEW=1',
                                                                  b'PROXY_NATIVE_TERMINAL_REVIEW=custom'))
        self.calls.clear()
        config = m.CONFIG.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'Managed setting changed'):
            m.rollback()
        self.assertFalse(self.stopped())
        self.assertEqual(m.CONFIG.read_bytes(),config)

    def test_changed_mount_conflict_refuses_rollback_without_partial_restore(self):
        m.activate()
        m.COMPOSE.write_bytes(m.COMPOSE.read_bytes().replace(str(m.MANAGED).encode(),b'/unexpected/location'))
        self.calls.clear()
        config = m.CONFIG.read_bytes()
        with self.assertRaisesRegex(RuntimeError,'Policy mount was modified'):
            m.rollback()
        self.assertFalse(self.stopped())
        self.assertEqual(m.CONFIG.read_bytes(),config)

    def test_rollback_can_be_repeated_without_replacing_user_data(self):
        m.activate()
        m.rollback()
        (m.DATA/'later-file').write_text('keep')
        m.rollback()
        self.assertEqual((m.DATA/'later-file').read_text(),'keep')
        self.assertEqual(self.current['Image'],m.BASE)


class VerificationContractTest(unittest.TestCase):
    def test_real_node_verifier_handles_old_config_and_requires_new_opt_in(self):
        node = os.environ.get('CC_NATIVE_TEST_NODE') or shutil.which('node')
        if not node:
            self.skipTest('Node 24 required for verification-contract execution')
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.mjs'
            for flag, enabled, success in ((None, False, True), (None, True, False),
                                          (True, True, True), (False, True, False)):
                options = {'moderation':{'nodeId':'ubuntu-cc','endpoint':m.ENDPOINT}}
                if flag is not None:
                    options['nativeTerminalReview'] = flag
                config.write_text('export function environmentConfig(){return '+
                                  json.dumps({'options':options})+';}')
                script = m.VERIFY_JS.split('let managedPolicyVerified=false;')[0]
                script = script.replace('/app/apps/server/src/config.ts', config.as_uri())
                script = script.replace('__ENABLED__', str(enabled).lower())
                result = subprocess.run([node,'--input-type=module','-'],input=script,
                                        text=True,capture_output=True,timeout=15)
                self.assertEqual(result.returncode == 0, success, result.stderr)


class ParsingTest(unittest.TestCase):
    def test_report_parser_tolerates_node_warnings_but_refuses_ambiguous_reports(self):
        self.assertEqual(m.parse_report('warning\nNATIVE_ACTIVATION_RESULT {"ok":true}\nwarning'),{'ok':True})
        with self.assertRaisesRegex(RuntimeError,'ambiguous'):
            m.parse_report('NATIVE_ACTIVATION_RESULT {}\nNATIVE_ACTIVATION_RESULT {}')

    def test_assignment_restoration_does_not_touch_other_values(self):
        before = b'OTHER=keep'
        after = m.set_assignment(before,m.ENV_KEY,b'PROXY_NATIVE_TERMINAL_REVIEW=1')
        self.assertEqual(after,b'OTHER=keep\nPROXY_NATIVE_TERMINAL_REVIEW=1\n')
        self.assertIsNone(m.assignment(before,m.ENV_KEY))
        with self.assertRaisesRegex(RuntimeError,'Duplicate'):
            m.assignment(b'PROXY_IMAGE=a\nexport PROXY_IMAGE=b\n','PROXY_IMAGE')


if __name__ == '__main__':
    unittest.main()
