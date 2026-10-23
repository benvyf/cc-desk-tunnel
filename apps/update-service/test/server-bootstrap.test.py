import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import tarfile
import tempfile
import unittest
import subprocess
from unittest.mock import patch

path = pathlib.Path(__file__).parents[1] / 'web/server-bootstrap.py'
spec = importlib.util.spec_from_file_location('bootstrap', path)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BootstrapTests(unittest.TestCase):
    def original(self):
        return {'Id': 'old', 'Image': 'sha256:' + 'a' * 64, 'Name': '/' + b.CONTAINER,
                'Config': {'Entrypoint': ['/usr/bin/tini', '-g', '--', '/usr/local/bin/proxy-entrypoint'], 'Cmd': ['server'], 'Env': ['KEEP=unchanged'], 'User': 'ccdesktunnel', 'WorkingDir': '/data/workspace', 'Healthcheck': {'Test': ['CMD', 'node', '/app/healthcheck.mjs']}},
                'HostConfig': {'NetworkMode': 'stack', 'RestartPolicy': {'Name': 'unless-stopped'}, 'PortBindings': {'8787/tcp': [{'HostPort': '8787'}]}},
                'Mounts': [{'Type': 'bind', 'Source': '/srv/cc-desk-tunnel', 'Destination': '/data', 'RW': True}, {'Type': 'bind', 'Source': '/etc/claude-code', 'Destination': '/etc/claude-code', 'RW': False}],
                'State': {'Running': True, 'Paused': False, 'Pid': 123}, 'NetworkSettings': {'Networks': {'stack': {'Aliases': ['proxy']}}}}

    def test_only_known_container_startup_and_mount_profile_is_accepted(self):
        original = self.original()
        b.validate_runtime(original)
        cloned = b.clone_config(original, 'new-image')
        self.assertEqual(cloned['Env'], original['Config']['Env'])
        self.assertEqual(cloned['HostConfig'], original['HostConfig'])
        for mutation in ('entrypoint', 'write', 'runtime', 'port', 'policy', 'restart'):
            bad = copy.deepcopy(original)
            if mutation == 'entrypoint': bad['Config']['Entrypoint'] = ['custom']
            if mutation == 'write': bad['Mounts'].append({'Type': 'bind', 'Source': '/x', 'Destination': '/extra', 'RW': True})
            if mutation == 'runtime': bad['Mounts'].append({'Type': 'bind', 'Source': '/x', 'Destination': '/opt/runtime/cli', 'RW': False})
            if mutation == 'port': bad['HostConfig']['PortBindings']['8787/tcp'][0]['HostPort'] = '0'
            if mutation == 'policy': bad['Mounts'][1]['RW'] = True
            if mutation == 'restart': bad['HostConfig']['RestartPolicy']['Name'] = 'no'
            with self.assertRaises(b.InstallError): b.validate_runtime(bad)

    def test_bootstrap_profile_matches_reviewed_source_and_docker_allowlist(self):
        root = pathlib.Path(__file__).parents[3]
        self.assertEqual(b.PROFILE, json.loads((root / 'deploy/server-bootstrap-profile.json').read_text()))
        self.assertIn('!deploy/server-bootstrap-profile.json', (root / '.dockerignore').read_text())

    def test_bootstrap_rejects_changed_serializers_even_when_signed_compatibility_matches(self):
        root = pathlib.Path(__file__).parents[3]
        closure = ['apps/server/src/' + name + '.ts' for name in ('store', 'usage', 'web-access', 'native-settings', 'native-onboarding', 'native-instructions', 'native-moderation-hook', 'moderation', 'errors', 'native-deployment', 'native-terminal-policy', 'web-certificate', 'web-totp', 'device-terms', 'claude', 'legacy', 'native-account')] + ['packages/protocol/src/index.ts', 'packages/protocol/src/web.ts', 'packages/protocol/src/web-certificate.ts']
        pinned = ['apps/server/src/claude.ts', 'apps/server/src/legacy.ts', 'packages/protocol/src/index.ts', 'packages/protocol/src/web.ts', 'packages/protocol/src/web-certificate.ts']
        def compatibility(content, path):
            if path == 'packages/protocol/src/index.ts':
                content = re.sub(rb'(?m)^export const PROTOCOL_VERSION = [0-9]+;(?=\r?$)', b'export const PROTOCOL_VERSION = 0;', content)
            return hashlib.sha256(content).hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            program = pathlib.Path(folder)
            for path in closure + ['package-lock.json', 'deploy/managed-server.json', 'deploy/docker/runtime-level']:
                target = program / path; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(subprocess.check_output(['git', 'show', 'HEAD:' + path], cwd=root))
            release = {'build': json.loads((program / 'deploy/managed-server.json').read_text())['build'],
                       'packageLockSha256': hashlib.sha256((program / 'package-lock.json').read_bytes()).hexdigest(),
                       'compatibility': {path: compatibility((program / path).read_bytes(), path) for path in closure}}
            b.validate_target(program, release)
            identity = json.loads((program / 'deploy/managed-server.json').read_text())
            identity['build'] = 2
            (program / 'deploy/managed-server.json').write_text(json.dumps(identity))
            release['build'] = 2
            b.validate_target(program, release)
            with self.assertRaises(b.InstallError):
                b.validate_target(program, {**release, 'build': 3})
            with patch.object(b, 'command') as docker:
                for path in pinned:
                    with self.subTest(path=path):
                        original = (program / path).read_bytes()
                        changed = original + b'\n// changed persisted schema fixture\n'
                        (program / path).write_bytes(changed)
                        altered = copy.deepcopy(release)
                        altered['compatibility'][path] = compatibility(changed, path)
                        try:
                            with self.assertRaisesRegex(b.InstallError, 'Persistence compatibility changed'):
                                b.validate_target(program, altered)
                        finally:
                            (program / path).write_bytes(original)
                docker.assert_not_called()

    def test_strict_archive_inventory_rejects_links_pax_extras_and_missing_files(self):
        with tempfile.TemporaryDirectory() as d:
            files = {'package-lock.json': b'lock', 'apps/server/src/store.ts': b'store'}
            descriptor = {'schema': 1, 'product': b.PRODUCT, 'build': 1, 'appVersion': '0.3.6', 'protocol': 20, 'sourceCommit': 'a' * 40,
                          'files': {p: {'size': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for p, v in files.items()}}
            db = json.dumps(descriptor).encode()
            release = {k: descriptor[k] for k in ('build', 'appVersion', 'protocol', 'sourceCommit')}
            release['descriptorSha256'] = hashlib.sha256(db).hexdigest()
            for bad in (None, 'extra', 'link', 'pax', 'missing'):
                stream = io.BytesIO()
                with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.USTAR_FORMAT) as tar:
                    for name, content in {**files, 'SERVER-RELEASE.json': db}.items():
                        if bad == 'missing' and name == 'package-lock.json': continue
                        member = tarfile.TarInfo(name); member.size = len(content)
                        tar.addfile(member, io.BytesIO(content))
                    if bad in ('extra', 'link', 'pax'):
                        m = tarfile.TarInfo('extra'); m.size = 0
                        if bad == 'link': m.type = tarfile.SYMTYPE; m.linkname = '/etc/shadow'
                        if bad == 'pax': m.type = tarfile.XHDTYPE
                        tar.addfile(m, io.BytesIO())
                archive = stream.getvalue()
                release.update(size=len(archive), sha256=hashlib.sha256(archive).hexdigest())
                target = pathlib.Path(d) / str(bad)
                if bad:
                    with self.assertRaises(b.InstallError): b.unpack(archive, target, release)
                    self.assertFalse(target.exists())
                else:
                    b.unpack(archive, target, release)
                    self.assertEqual((target / 'package-lock.json').read_bytes(), b'lock')

    def test_build_overlay_updates_real_entrypoint_and_runtime_without_dependencies(self):
        content = b.dockerfile('cc-bootstrap-snapshot:fixture')
        self.assertIn('FROM cc-bootstrap-snapshot:fixture', content)
        self.assertIn('/usr/local/bin/proxy-entrypoint', content)
        self.assertIn('/opt/runtime/level', content)
        self.assertIn('COPY --chown=root:root program/ /app/', content)
        self.assertNotRegex(content, r'(?i)(npm |apt |curl |wget )')

    @unittest.skipUnless(os.name == 'posix', 'Requires POSIX directory permissions and umask')
    def test_unpack_is_traversable_after_private_umask_without_opening_private_ancestors(self):
        files = {'apps/server/src/deep/main.ts': b'program', 'deploy/docker/runtime-level': b'1'}
        descriptor = {'schema': 1, 'product': b.PRODUCT, 'build': 1, 'appVersion': '0.3.6', 'protocol': 20,
                      'sourceCommit': 'a' * 40, 'files': {p: {'size': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for p, v in files.items()}}
        db = json.dumps(descriptor).encode()
        release = {k: descriptor[k] for k in ('build', 'appVersion', 'protocol', 'sourceCommit')}
        release['descriptorSha256'] = hashlib.sha256(db).hexdigest()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.USTAR_FORMAT) as tar:
            for name, content in {**files, 'SERVER-RELEASE.json': db}.items():
                member = tarfile.TarInfo(name); member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
        archive = stream.getvalue()
        release.update(size=len(archive), sha256=hashlib.sha256(archive).hexdigest())
        with tempfile.TemporaryDirectory() as folder:
            old_umask = os.umask(0o077)
            try:
                private = pathlib.Path(folder)
                work = private / 'work'; work.mkdir(mode=0o700)
                backup = private / 'backup'; backup.mkdir(mode=0o700)
                program = work / 'program'
                b.unpack(archive, program, release)
            finally:
                os.umask(old_umask)
            for directory in [program] + [p for p in program.rglob('*') if p.is_dir()]:
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755, str(directory.relative_to(program)))
            for file in (p for p in program.rglob('*') if p.is_file()):
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644)
            for directory in (private, work, backup):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)

    def test_reviewed_pilot_cli_is_pinned_by_bytes_without_stamp_or_execution(self):
        with patch.object(b.subprocess, 'run') as run:
            run.return_value.returncode = 0
            b.runtime_and_policy('fixture-container')
            argv = run.call_args.args[0]
            program = argv[-1]
            self.assertIn('4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358', program)
            self.assertNotIn('.sha256', program)
            self.assertNotIn('--version', program)
            self.assertEqual(argv[:4], ['docker', 'exec', 'fixture-container', '/opt/runtime/node/bin/node'])

    def test_real_ed25519_and_pinned_identity_reject_tamper_expiry_redirected_identity(self):
        node = os.environ.get('CC_TEST_NODE', 'node')
        release = {'build': 1, 'appVersion': '0.3.6', 'protocol': 20, 'sourceCommit': 'a' * 40, 'size': 123,
                   'sha256': 'a' * 64, 'descriptorSha256': 'b' * 64, 'packageLockSha256': b.PROFILE['files']['package-lock.json'], 'runtimeLevel': 'node24-cli2.1.295-v1', 'compatibility': {}}
        payload = {'schema': 1, 'product': b.PRODUCT, 'channel': 'pilot', 'platform': 'linux', 'arch': 'x64', 'revision': 1,
                   'issuedAt': '2026-10-24T00:00:00.000Z', 'expiresAt': '2026-11-01T00:00:00.000Z', 'release': release}
        signer = "const c=require('crypto'),p=require('fs').readFileSync(0),k=c.generateKeyPairSync('ed25519');console.log(JSON.stringify({key:k.publicKey.export({type:'spki',format:'pem'}),envelope:{keyId:'test',payload:p.toString('base64url'),signature:c.sign(null,p,k.privateKey).toString('base64url')}}))"
        signed = json.loads(subprocess.run([node, '-e', signer], input=json.dumps(payload).encode(), capture_output=True, check=True).stdout)
        real_run = subprocess.run
        def verify(argv, **kwargs):
            self.assertIn('--network=none', argv); self.assertIn('--read-only', argv)
            self.assertNotIn('--mount', argv)
            return real_run([node, '-e', argv[-1]], **kwargs)
        with patch.object(b, 'KEYS', {'test': signed['key']}), patch.object(b.subprocess, 'run', side_effect=verify), patch.object(b.time, 'time', return_value=1792886400):
            good = json.dumps(signed['envelope']).encode()
            self.assertEqual(b.verify_index(good, 'local-fixture', 1, 'a' * 64)['release'], release)
            with self.assertRaises(b.InstallError): b.verify_index(good, 'local-fixture', 2, 'a' * 64)
            tampered = copy.deepcopy(signed['envelope']); tampered['signature'] = 'A' * 86
            with self.assertRaises(b.InstallError): b.verify_index(json.dumps(tampered).encode(), 'local-fixture', 1, 'a' * 64)
            with patch.object(b.time, 'time', return_value=1892886400):
                with self.assertRaises(b.InstallError): b.verify_index(good, 'local-fixture', 1, 'a' * 64)

    def test_restore_removes_only_exact_replacement_and_never_restores_business_data(self):
        original = self.original()
        class Engine:
            def __init__(self): self.calls = []
            def request(self, method, path, data=None):
                self.calls.append((method, path, data))
                return {**original, 'Name': '/backup', 'State': {'Running': False}, 'NetworkSettings': {'Networks': {}}} if path.endswith('/json') else {}
        engine = Engine()
        b.restore(engine, original, 'replacement')
        self.assertIn(('DELETE', '/containers/replacement?force=true', None), engine.calls)
        self.assertEqual(engine.calls[-1][1], '/containers/old/start')
        self.assertFalse(any(call[0] == 'DELETE' and '/old' in call[1] for call in engine.calls))

    def test_restore_reconnects_running_original_without_starting_it_again(self):
        original = self.original()
        class Engine:
            def __init__(self): self.calls = []
            def request(self, method, path, data=None):
                self.calls.append((method, path, data))
                if path == '/containers/old/start': raise b.EngineError(304)
                return {**original, 'NetworkSettings': {'Networks': {}}} if path.endswith('/json') else {}
        engine = Engine()
        b.restore(engine, original)
        self.assertTrue(any(c[1] == '/networks/stack/connect' for c in engine.calls))
        self.assertIn(('POST', '/containers/old/update', {'RestartPolicy': original['HostConfig']['RestartPolicy']}), engine.calls)
        self.assertFalse(any(c[1] == '/containers/old/start' for c in engine.calls))

    def test_offline_rollback_recovers_interrupted_install_before_replacement_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); backup=root/'backup-interrupted';backup.mkdir()
            original=self.original(); (backup/'original.json').write_text(json.dumps(original))
            class Engine:
                def __init__(self): self.calls=[]
                def request(self,method,path,data=None):
                    self.calls.append((method,path,data))
                    if path=='/containers/'+b.CONTAINER+'/json': raise b.EngineError(404)
                    if path=='/containers/old/json': return {**original,'Name':'/old-backup','State':{'Running':False},'NetworkSettings':{'Networks':{}}}
                    return {}
            engine=Engine()
            with patch.object(b,'ROOT',root): b.rollback(engine,str(backup))
            self.assertEqual(engine.calls[-1][1],'/containers/old/start')
            self.assertFalse(any(c[0]=='DELETE' for c in engine.calls))

    def test_idempotent_marker_accepts_a_later_managed_program_without_reinstalling(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder);original=self.original(); release={'build':1,'protocol':20,'descriptorSha256':'a'*64}
            (root/'installed.json').write_text(json.dumps({'containerId':original['Id'],'imageId':original['Image'],'release':release}))
            class Engine:
                def request(self,*_): return original
            with patch.object(b,'ROOT',root),patch.object(b.socket,'gethostname',return_value=b.PROFILE['node']),patch.object(b,'live_status') as status,patch.object(b,'download') as download:
                b.install(None,Engine(),root)
                status.assert_called_once_with(b.CONTAINER,release,allow_newer=True)
                download.assert_not_called()

    def test_rollback_recovers_create_response_loss_only_with_durable_matching_intent(self):
        for mismatch in (None, 'nonce', 'image', 'originalId'):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder); backup = root / 'backup-interrupted'; backup.mkdir()
                original = self.original()
                (backup / 'original.json').write_text(json.dumps(original))
                intent = {'image': 'sha256:' + 'b' * 64, 'nonce': 'c' * 32, 'originalId': original['Id']}
                replacement = {**original, 'Id': 'new', 'Image': intent['image'], 'State': {'Running': False},
                               'Config': {**original['Config'], 'Labels': {'org.cc-desk-tunnel.bootstrap': intent['nonce']}}}
                if mismatch: intent[mismatch] = 'unknown'
                (backup / 'replacement-intent.json').write_text(json.dumps(intent))
                class Engine:
                    def __init__(self): self.calls = []
                    def request(self, method, path, data=None):
                        self.calls.append((method, path, data))
                        if path == '/containers/' + b.CONTAINER + '/json': return replacement
                        if path == '/containers/old/json':
                            return {**original, 'Name': '/backup', 'State': {'Running': False}, 'NetworkSettings': {'Networks': {}}}
                        return {}
                engine = Engine()
                with patch.object(b, 'ROOT', root):
                    if mismatch is None:
                        b.rollback(engine, str(backup))
                        self.assertIn(('DELETE', '/containers/new?force=true', None), engine.calls)
                        self.assertEqual(engine.calls[-1][1], '/containers/old/start')
                    else:
                        with self.assertRaisesRegex(b.InstallError, 'changed|unknown|Unknown'):
                            b.rollback(engine, str(backup))
                        self.assertFalse(any(c[0] != 'GET' for c in engine.calls))

    def test_live_status_retry_accepts_only_healthy_settled_programs_and_original_descriptor(self):
        node = os.environ.get('CC_TEST_NODE', 'node')
        real_run = subprocess.run
        fixture = r"""import fixtureHttp from'node:http';
        const fixtureStatus=JSON.parse(process.env.CC_FIXTURE_STATUS);
        const fixtureServer=fixtureHttp.createServer((request,response)=>{
          if(request.headers.authorization!=='Bearer synthetic-test-token'){response.writeHead(401);response.end();return}
          if(request.url==='/cc-managed/server/v1/status'){response.writeHead(200);response.end(JSON.stringify(fixtureStatus))}
          else if(request.url==='/health'){response.writeHead(Number(process.env.CC_FIXTURE_HEALTH));response.end('ok')}
          else{response.writeHead(500);response.end('Unexpected fixture path')}
        });await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
        process.env.PROXY_PORT=String(fixtureServer.address().port);
        const fixtureTimer=globalThis.setTimeout;globalThis.setTimeout=(fn)=>fixtureTimer(fn,0);
        """
        with tempfile.TemporaryDirectory() as folder:
            descriptor = pathlib.Path(folder) / 'SERVER-RELEASE.json'
            descriptor.write_bytes(b'original base descriptor')
            release = {'build': 1, 'protocol': 20, 'descriptorSha256': hashlib.sha256(descriptor.read_bytes()).hexdigest()}
            status = {'phase': 'idle', 'current': {'build': 2, 'protocol': 21}}
            health = 200
            def docker_fixture(argv, **kwargs):
                self.assertEqual(argv[:3], ['docker', 'exec', 'fixture'])
                if '--input-type=module' in argv:
                    env = {**os.environ, 'PROXY_TLS_MODE': 'reverse-proxy', 'PROXY_TOKEN': 'synthetic-test-token',
                           'CC_FIXTURE_STATUS': json.dumps(status), 'CC_FIXTURE_HEALTH': str(health)}
                    return real_run([node, '--input-type=module', '-e', fixture + argv[-4] + '\nfixtureServer.close();', *argv[-3:]], env=env, **kwargs)
                self.assertIn("'/app/'", argv[-2])
                program = argv[-2].replace("'/app/'", json.dumps(folder + os.sep))
                return real_run([node, '-e', program, argv[-1]], **kwargs)
            with patch.object(b.subprocess, 'run', side_effect=docker_fixture):
                for phase in ('idle', 'committed', 'rolled-back'):
                    status['phase'] = phase
                    with self.subTest(phase=phase):
                        b.live_status('fixture', release, allow_newer=True)
                for phase in ('staging', 'stopping', 'backup', 'switching', 'probing', 'failed'):
                    status['phase'] = phase
                    with self.assertRaises(b.InstallError): b.live_status('fixture', release, allow_newer=True)
                status['phase'] = 'committed'
                with self.assertRaises(b.InstallError): b.live_status('fixture', release)
                status['current']['build'] = 0
                with self.assertRaises(b.InstallError): b.live_status('fixture', release, allow_newer=True)
                status['current'] = {'build': 2, 'protocol': 0}
                with self.assertRaises(b.InstallError): b.live_status('fixture', release, allow_newer=True)
                status['current']['protocol'] = 21
                health = 500
                with self.assertRaises(b.InstallError): b.live_status('fixture', release, allow_newer=True)
                health = 200
                descriptor.write_bytes(b'tampered base descriptor')
                with self.assertRaises(b.InstallError): b.live_status('fixture', release, allow_newer=True)

    def test_transaction_preserves_config_snapshot_and_cold_data_and_rolls_back_failures(self):
        for failure in (None, 'create', 'create-response', 'start', 'health', 'frozen'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder); work = root / 'work'; work.mkdir()
                data = root / 'data'; data.mkdir(); (data / 'message').write_text('original')
                original = self.original()
                class Engine:
                    def __init__(self): self.calls = []; self.old = copy.deepcopy(original)
                    def request(self, method, path, payload=None):
                        self.calls.append((method, path, payload))
                        if path == '/containers/' + b.CONTAINER + '/json' and failure == 'create-response':
                            return {**original, 'Id': 'replacement', 'Image': 'final-image', 'Config': self.created, 'State': {'Running': False}}
                        if path.endswith('/json') and path.startswith('/containers/'): return copy.deepcopy(self.old)
                        if '/top?' in path:
                            assert path.endswith('/top?ps_args=-eo%20pid,args')
                            return {'Processes': [['1', 'node /app/apps/server/src/main.ts']]}
                        if path.startswith('/commit?'): return {'Id': 'snapshot'}
                        if path.startswith('/images/') and path.endswith('/json'): return {'Id': 'final-image'}
                        if path.startswith('/containers/create'):
                            if failure == 'create': raise b.InstallError('create failed')
                            self.created = payload
                            if failure == 'create-response': raise b.EngineError(500)
                            return {'Id': 'replacement'}
                        if path.endswith('/pause'): self.old['State']['Paused'] = True
                        if path.endswith('/kill?signal=SIGKILL'): self.old['State']['Running'] = False; self.old['State']['Paused'] = False
                        if path == '/containers/replacement/start':
                            (data / 'message').write_text('new data')
                            if failure == 'start': raise b.InstallError('start failed')
                        return {}
                engine = Engine()
                def idle(_):
                    if failure == 'frozen': raise b.InstallError('pending run')
                def health(*_):
                    if failure == 'health': raise b.InstallError('unhealthy')
                real_tar_open = tarfile.open
                def cold_archive(*args, **kwargs):
                    calls = [c[1] for c in engine.calls]
                    kill = calls.index('/containers/old/kill?signal=SIGKILL')
                    updates = [i for i,c in enumerate(engine.calls) if c[1] == '/containers/old/update' and c[2] == {'RestartPolicy': {'Name': 'no'}}]
                    self.assertTrue(updates and updates[0] < kill, 'disable restart before kill')
                    self.assertIn('/containers/old/json', calls[kill+1:], 'confirm exit before cold backup')
                    return real_tar_open(*args, **kwargs)
                release = {'build': 1, 'sha256': 'a' * 64, 'descriptorSha256': 'b' * 64}
                with patch.object(b, 'ROOT', root), patch.object(b, 'DATA', data), patch.object(b, 'frozen_idle', side_effect=idle), patch.object(b, 'command'), patch.object(b, 'offline_preflight'), patch.object(b, 'checked_sources'), patch.object(b, 'wait_healthy', side_effect=health), patch.object(b, 'live_status'), patch.object(b.tarfile, 'open', side_effect=cold_archive):
                    if failure:
                        with self.assertRaises((b.InstallError, b.EngineError)): b.replace(engine, original, work, release)
                        self.assertTrue(any(c[1] == '/containers/old/start' for c in engine.calls) if failure != 'frozen' else any(c[1] == '/containers/old/unpause' for c in engine.calls))
                        if failure == 'create-response':
                            self.assertIn(('DELETE', '/containers/replacement?force=true', None), engine.calls)
                            self.assertTrue((next(root.glob('backup-*')) / 'replacement-record.json').exists())
                    else:
                        b.replace(engine, original, work, release)
                        self.assertEqual(engine.created['Env'], original['Config']['Env'])
                        self.assertEqual(engine.created['HostConfig'], original['HostConfig'])
                        backup = next(root.glob('backup-*'))
                        self.assertTrue((backup / 'rollback.py').is_file())
                        self.assertTrue((backup / 'original.json').is_file())
                        self.assertTrue((backup / 'data.tar.gz').is_file())
                        self.assertEqual((backup / 'snapshot-id').read_text(), 'snapshot')
                    self.assertEqual((data / 'message').read_text(), 'new data' if failure in (None, 'start', 'health') else 'original')

if __name__ == '__main__': unittest.main()
