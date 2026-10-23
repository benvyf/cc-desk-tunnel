"""Core cutover/rollback tests. Docker, SSH, health checks and network calls are mocked."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('activate-moderation-pilot.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CutoverTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        state, data, source = root / 'state', root / 'data', root / 'source'
        for path in (state, data / 'config', source / '.local'):
            path.mkdir(parents=True)
        values = dict(STATE=state, DATA=data, SOURCE=source, BACKUP=state / 'activation-backup',
                      CONFIG=source / '.local/docker.env', SERVICE_ENV=data / 'config/service.env',
                      NODE_CONFIG=data / 'config/moderation-node.json')
        for key, value in values.items():
            item = patch.object(module, key, value)
            item.start()
            self.addCleanup(item.stop)
        module.CONFIG.write_bytes(b"PROXY_IMAGE='original-tag'\nOTHER=unchanged\n")
        module.SERVICE_ENV.write_bytes(b'DISABLE_AUTOUPDATER=1\nNETWORK_FIXTURE=unchanged\n\n')
        self.config_before = module.CONFIG.read_bytes()
        self.env_before = module.SERVICE_ENV.read_bytes()
        (data / '.cc-desk-tunnel-data').touch()
        (data / 'config/provider.json').write_text('{"fixture":true}')
        self.credential = state / 'received-node.json'
        self.credential.write_text('{"nodeId":"ubuntu-cc","token":"fixture-never-used"}')
        self.before = dict(Id='original-container', Image=module.BASE, State=dict(StartedAt='fixture-time', Running=True),
                           Mounts=[dict(Source=str(data), Destination='/data', Type='bind', RW=True)],
                           Config=dict(Env=['HOME=/data/home']), HostConfig=dict(NetworkMode='unchanged-network'))
        self.current = copy.deepcopy(self.before)
        (state / 'production-before.json').write_text(json.dumps(self.before))
        (state / 'result.json').write_text(json.dumps(dict(imageId=module.IMAGE, protectedImageFilesEqual=True, modelRequests=0)))
        self.commands = []

        def inspect(kind, _name):
            return {'Id': module.IMAGE} if kind == 'image' else copy.deepcopy(self.current)

        def dc(*args):
            self.commands.append(('compose', *args))
            if args[0] == 'stop': self.current['State']['Running'] = False
            if args[0] == 'config':
                tag = re.search(r"^PROXY_IMAGE='([^']+)'", module.CONFIG.read_text()).group(1)
                return json.dumps({'services': {'proxy': {'image': tag}}})
            if args[0] == 'up':
                self.current['Image'] = module.IMAGE if module.IMAGE_TAG in module.CONFIG.read_text() else module.BASE
                self.current['State']['Running'] = True
            return ''

        def run(*args, **_kwargs):
            args = tuple(str(arg) for arg in args)
            self.commands.append(args)
            if args[0] == 'du': return '1024 fixture'
            if args[:2] == ('docker', 'start'): self.current['State']['Running'] = True
            if args[0] == 'tar' and '-cpf' in args:
                output = Path(args[args.index('-cpf') + 1])
                with tarfile.open(output, 'w') as archive: archive.add(data, arcname='data')
            return ''

        def verify(image, enabled):
            self.assertEqual(self.current['Image'], image)
            return dict(protocol=20, authenticated=True, moderationEnabled=enabled, modelRequests=0)

        for name, replacement in dict(inspect=inspect, dc=dc, run=run, idle=lambda: None,
                                      receive_config=lambda: self.credential, verify=verify).items():
            item = patch.object(module, name, replacement)
            item.start()
            self.addCleanup(item.stop)
        self.silent = contextlib.redirect_stdout(io.StringIO())
        self.silent.__enter__()
        self.addCleanup(self.silent.__exit__, None, None, None)

    def test_activation_keeps_existing_settings_and_takes_consistent_backup(self):
        module.activate()
        self.assertEqual(module.SERVICE_ENV.read_bytes(), self.env_before + b'PROXY_MODERATION_CONFIG=/data/config/moderation-node.json\n')
        self.assertTrue(module.NODE_CONFIG.exists())
        self.assertEqual(module.NODE_CONFIG.stat().st_mode & 0o777, 0o600)
        self.assertTrue((module.BACKUP / 'data.tar').is_file())
        result = json.loads((module.STATE / 'activation-result.json').read_text())
        self.assertTrue(result['cutoverPerformed'])
        self.assertEqual(result['modelRequests'], 0)
        self.assertNotIn('fixture-never-used', json.dumps(result))

    def test_failed_start_verification_restores_image_env_and_keeps_data(self):
        original_verify = module.verify

        def fail_new(image, enabled):
            if enabled: raise RuntimeError('simulated health failure')
            return original_verify(image, enabled)

        with patch.object(module, 'verify', fail_new):
            with self.assertRaisesRegex(RuntimeError, 'simulated health failure'): module.activate()
        self.assertEqual(self.current['Image'], module.BASE)
        self.assertEqual(module.CONFIG.read_bytes(), self.config_before)
        self.assertEqual(module.SERVICE_ENV.read_bytes(), self.env_before)
        self.assertFalse(module.NODE_CONFIG.exists())
        self.assertEqual((module.DATA / 'config/provider.json').read_text(), '{"fixture":true}')
        self.assertTrue(json.loads((module.STATE / 'activation-result.json').read_text())['rolledBack'])

    def test_failed_credential_preflight_never_stops_production(self):
        with patch.object(module, 'receive_config', side_effect=RuntimeError('fixture auth failure')):
            with self.assertRaisesRegex(RuntimeError, 'fixture auth failure'): module.activate()
        self.assertFalse(module.BACKUP.exists())
        self.assertNotIn(('compose', 'stop', 'proxy'), self.commands)
        self.assertEqual(module.SERVICE_ENV.read_bytes(), self.env_before)

    def test_later_rollback_preserves_new_user_data(self):
        module.activate()
        newer = module.DATA / 'new-user-file'
        newer.write_text('keep this')
        module.rollback()
        self.assertEqual(newer.read_text(), 'keep this')
        self.assertEqual(module.SERVICE_ENV.read_bytes(), self.env_before)


if __name__ == '__main__': unittest.main()
