import importlib.util
import pathlib
import unittest
import tempfile
from unittest.mock import patch
import types
import json
import copy
import hashlib

path = pathlib.Path(__file__).parents[1] / 'web/monitor-install.py'
spec = importlib.util.spec_from_file_location('installer', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_busy_detects_cli_sdk_and_native_without_exposing_arguments(self):
        for args in ['claude --resume secret', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', '/root/.local/bin/claude', 'node /app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js']:
            self.assertTrue(installer.busy([[args]]))
        self.assertFalse(installer.busy([['node apps/server/src/main.ts'], ['docker-init -- node apps/server/src/main.ts']]))
        self.assertTrue(installer.busy([['node unknown-worker.js']]))

    def test_clone_preserves_runtime_and_adds_only_monitor_settings(self):
        original = {'Id': 'abc', 'Name': '/cc', 'Config': {'Image': 'old', 'Env': ['KEEP=secret', 'PROXY_MONITOR_TOKEN=old'],
            'Entrypoint': ['/entrypoint'], 'Cmd': ['main'], 'Labels': {'com.docker.compose.service': 'proxy'}, 'Healthcheck': {'Test': ['CMD', 'local']}},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}, 'PortBindings': {'8787/tcp': [{'HostPort': '8787'}]}, 'NetworkMode': 'stack', 'Binds': ['/srv:/data']},
            'NetworkSettings': {'Networks': {'stack': {'Aliases': ['abc', 'cc', 'proxy'], 'IPAMConfig': None}}}}
        config = installer.clone_config(original, 'new', {'PROXY_MONITOR_URL': 'https://fixture.invalid/report', 'PROXY_MONITOR_NODE_ID': 'ubuntu-cc', 'PROXY_MONITOR_TOKEN': 'newsecret'})
        self.assertEqual(config['Entrypoint'], original['Config']['Entrypoint'])
        self.assertEqual(config['HostConfig'], original['HostConfig'])
        self.assertEqual(config['Labels'], original['Config']['Labels'])
        self.assertIn('KEEP=secret', config['Env'])
        self.assertEqual([e for e in config['Env'] if e.startswith('PROXY_MONITOR_TOKEN=')], ['PROXY_MONITOR_TOKEN=newsecret'])
        self.assertEqual(config['NetworkingConfig']['EndpointsConfig']['stack']['Aliases'], ['cc', 'proxy'])
        self.assertEqual(original['Config']['Image'], 'old')

    def test_unsupported_mounts_and_modes_fail_before_downtime(self):
        base = {'Config': {}, 'State': {'Running': True}, 'HostConfig': {'NetworkMode': 'stack'}, 'Mounts': [{'Type': 'bind', 'Source': '/srv/cc-desk-tunnel', 'Destination': '/data', 'RW': True}]}
        installer.validate_runtime(base)
        for change in [{'AutoRemove': True}, {'NetworkMode': 'container:other'}, {'VolumesFrom': ['other']},
                       {'PublishAllPorts': True}, {'PortBindings': {'8787/tcp': [{'HostPort': '0'}]}}]:
            with self.assertRaises(installer.InstallError):
                installer.validate_runtime({**base, 'HostConfig': {**base['HostConfig'], **change}})
        with self.assertRaises(installer.InstallError):
            installer.validate_runtime({**base, 'Mounts': base['Mounts'] + [{'Type': 'volume', 'Destination': '/other', 'RW': True}]})

    def test_rollback_removes_only_replacement_and_restores_original_network_and_policy(self):
        class Engine:
            def __init__(self): self.calls = []
            def request(self, method, path, data=None): self.calls.append((method, path, data)); return {}
        engine = Engine()
        original = {'Id': 'oldid', 'Name': '/cc', 'HostConfig': {'RestartPolicy': {'Name': 'always'}},
            'NetworkSettings': {'Networks': {'stack': {'Aliases': ['cc', 'proxy']}}}}
        installer.restore(engine, original, 'newid')
        calls = engine.calls
        self.assertTrue(any(c[1] == '/containers/newid?force=true' for c in calls))
        self.assertFalse(any(c[1].startswith('/containers/oldid?') for c in calls))
        self.assertTrue(any(c[1] == '/networks/stack/connect' and c[2]['Container'] == 'oldid' for c in calls))
        self.assertEqual(calls[-1][1], '/containers/oldid/start')

    def test_full_install_and_failures_restore_original_without_replaying_data(self):
        for failure in (None, 'create', 'start', 'health', 'frozen-busy'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder)
                work = root / 'work'; work.mkdir()
                data = root / 'data'; data.mkdir(); (data / 'message').write_text('original')
                source = b'fixture source'
                (work / 'patch').mkdir(); (work / 'patch/a').write_bytes(source)
                manifest = {'node': installer.NODE, 'baseImage': installer.BASE, 'version': '0.3.6',
                            'before': {'a': 'before'}, 'after': {'a': hashlib.sha256(source).hexdigest()}}
                (work / 'manifest.json').write_text(json.dumps(manifest))
                (work / 'monitor.env').write_text('PROXY_MONITOR_URL=https://api.ghostapi.org/cc-updates/admin/api/monitor/report\nPROXY_MONITOR_NODE_ID=ubuntu-cc\nPROXY_MONITOR_TOKEN=' + 'x' * 43)
                original = {'Id': 'old', 'Image': installer.BASE, 'Name': '/' + installer.CONTAINER,
                    'Config': {'Image': installer.BASE, 'Env': ['KEEP=fixture'], 'Healthcheck': {'Test': ['CMD', 'local']}},
                    'HostConfig': {'NetworkMode': 'stack', 'RestartPolicy': {'Name': 'unless-stopped'}},
                    'Mounts': [{'Type': 'bind', 'Destination': '/data', 'Source': '/srv/cc-desk-tunnel', 'RW': True}],
                    'State': {'Running': True, 'Paused': False}, 'NetworkSettings': {'Networks': {'stack': {'Aliases': ['proxy']}}}}
                class Engine:
                    def __init__(self): self.calls = []; self.old = copy.deepcopy(original); self.new = None
                    def request(self, method, path, payload=None):
                        self.calls.append((method, path, payload))
                        if path.endswith('/top?ps_args=-eo%20args'): return {'Processes': [['node /app/apps/server/src/main.ts']]}
                        if path == '/containers/' + installer.CONTAINER + '/json': return self.old
                        if path == '/containers/old/json': return self.old
                        if path.startswith('/images/') and path.endswith('/json'): return {'Id': 'patched'}
                        if path.startswith('/commit?'): return {'Id': 'snapshot'}
                        if path.startswith('/containers/create'):
                            if failure == 'create': raise installer.InstallError('fixture create failure')
                            self.new = payload
                            return {'Id': 'new'}
                        if path == '/containers/new/start':
                            if failure == 'start': raise installer.InstallError('fixture start failure')
                            (data / 'message').write_text('new data must survive rollback')
                        return {}
                engine = Engine()
                def frozen(_):
                    if failure == 'frozen-busy': raise installer.InstallError('fixture pending run')
                def health(*_):
                    if failure == 'health': raise installer.InstallError('fixture health failure')
                class Reply:
                    def __enter__(self): return self
                    def __exit__(self, *_): pass
                    def read(self, _): return b'fixture bundle'
                opener = types.SimpleNamespace(open=lambda *_a, **_k: Reply())
                real_path = installer.pathlib.Path
                def paths(value, *extra):
                    return data if value == '/srv/cc-desk-tunnel' else real_path(value, *extra)
                args = types.SimpleNamespace(origin='https://api.ghostapi.org', code='x' * 43,
                    sha256=hashlib.sha256(b'fixture bundle').hexdigest())
                with patch.object(installer, 'ROOT', root), patch.object(installer.socket, 'gethostname', return_value=installer.NODE), \
                     patch.object(installer, 'checked_sources'), patch.object(installer, 'unpack'), \
                     patch.object(installer, 'command') as commands, patch.object(installer, 'frozen_idle', side_effect=frozen), \
                     patch.object(installer, 'wait_healthy', side_effect=health), patch.object(installer.urllib.request, 'build_opener', return_value=opener), \
                     patch.object(installer.pathlib, 'Path', side_effect=paths):
                    if failure:
                        with self.assertRaises(installer.InstallError): installer.install(args, engine, work)
                    else:
                        installer.install(args, engine, work)
                calls = engine.calls
                if failure == 'frozen-busy':
                    self.assertFalse(any('/kill?' in c[1] for c in calls))
                    self.assertFalse(any('/disconnect' in c[1] for c in calls))
                    self.assertEqual(calls[-1][1], '/containers/old/unpause')
                else:
                    self.assertFalse(any(c[1] == '/containers/old/unpause' for c in calls))
                    self.assertTrue(any('/kill?signal=SIGKILL' in c[1] for c in calls))
                    self.assertTrue(next(root.glob('backup-*/data.tar.gz')).is_file())
                    if failure: self.assertEqual(calls[-1][1], '/containers/old/start')
                    else:
                        self.assertTrue((root / 'installed.json').is_file())
                        self.assertIn('KEEP=fixture', engine.new['Env'])
                        self.assertIn('PROXY_MONITOR_NODE_ID=ubuntu-cc', engine.new['Env'])
                    if failure == 'health': self.assertEqual((data / 'message').read_text(), 'new data must survive rollback')
                for call in commands.call_args_list:
                    command = call.args[0]
                    self.assertIn('--network=none', command)


if __name__ == '__main__': unittest.main()
