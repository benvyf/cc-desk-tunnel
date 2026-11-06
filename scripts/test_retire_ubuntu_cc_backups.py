import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('retire', Path(__file__).with_name('retire-ubuntu-cc-backups.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RetirementTests(unittest.TestCase):
    def test_only_named_payloads_retire_and_current_rollback_mounts_logs_and_unknown_files_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / 'cc-runtime-upgrade'
            keep = root / 'backup-current'
            keep.mkdir(parents=True)
            old = root / 'backup-old'; old.mkdir()
            mounted = root / 'backup-mounted'; mounted.mkdir()
            for backup in (keep, old, mounted):
                for name in (*m.PAYLOADS, 'original.json', 'notes.log', 'account.txt'):
                    (backup / name).write_text('{}')
            unrelated = root / 'live-data'; unrelated.mkdir()
            (unrelated / 'data.tar.gz').write_text('live')
            targets, skipped = m.plan([{'Mounts': [{'Source': str(mounted / 'policy')}]}], keep, base)
            self.assertEqual({Path(t['path']) for t in targets}, {old / name for name in m.PAYLOADS})
            self.assertEqual(skipped, [str(mounted)])
            self.assertTrue((old / 'notes.log').exists())
            self.assertTrue((unrelated / 'data.tar.gz').exists())

    def test_links_and_unresolved_cutovers_stop_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            backup = base / 'cc-runtime-upgrade/backup-old'; backup.mkdir(parents=True)
            (backup / 'record.json').write_text(json.dumps({'phase': 'restoring'}))
            with self.assertRaisesRegex(RuntimeError, 'Unresolved'):
                m.plan([], base / 'keep', base)
            (backup / 'record.json').unlink()
            external = base / 'external'; external.write_text('data')
            try:
                (backup / 'data.tar').symlink_to(external)
            except OSError:
                self.skipTest('symlink privilege unavailable')
            with self.assertRaisesRegex(RuntimeError, 'Linked'):
                m.plan([], base / 'keep', base)
            self.assertEqual(external.read_text(), 'data')

    def fixture(self, root):
        current = {'Id': 'current', 'Image': 'current-image', 'Name': '/' + m.CONTAINER,
                   'State': {'Running': True, 'Status': 'running', 'StartedAt': 'start',
                             'Health': {'Status': 'healthy'}}}
        previous = {'Id': 'previous', 'Image': 'previous-image', 'Name': '/rollback',
                    'State': {'Status': 'exited', 'StartedAt': 'old'}}
        backup = root / 'backup-current'; backup.mkdir()
        for name in ('rollback.py', 'helper.py'): (backup / name).write_text('keep')
        (backup / 'data.tar.gz').write_bytes(b'cold backup')
        (backup / 'original.json').write_text(json.dumps(previous))
        (backup / 'record.json').write_text(json.dumps({'phase': 'installed', 'containerId': 'current',
            'imageId': 'current-image', 'archiveSha256': hashlib.sha256(b'cold backup').hexdigest()}))
        return [current, previous], backup

    def test_verified_current_rollback_required_and_corruption_missing_container_or_unhealthy_service_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            containers, backup = self.fixture(root)
            self.assertEqual(m.preserved_rollback(containers, root)[1], backup)
            with self.assertRaises(RuntimeError): m.preserved_rollback(containers[:1], root)
            unhealthy = copy.deepcopy(containers)
            unhealthy[0]['State']['Health']['Status'] = 'unhealthy'
            with self.assertRaises(RuntimeError): m.preserved_rollback(unhealthy, root)
            (backup / 'data.tar.gz').write_bytes(b'damaged')
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                m.preserved_rollback(containers, root)

    def test_health_probe_timestamps_do_not_mask_actual_resource_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            containers, _ = self.fixture(Path(directory).resolve())
            observed = copy.deepcopy(containers)
            observed[0]['State']['Health']['Log'] = ['new probe']
            self.assertEqual(m.references(containers), m.references(observed))
            observed[0]['Image'] = 'different'
            self.assertNotEqual(m.references(containers), m.references(observed))

    @unittest.skipUnless(os.name == 'posix', 'Requires real Linux flock')
    def test_real_apply_deletes_only_plan_and_leaves_audit_and_required_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            root = base / 'cc-runtime-upgrade'; root.mkdir()
            containers, kept = self.fixture(root)
            old = root / 'backup-old'; old.mkdir()
            (old / 'record.json').write_text(json.dumps({'phase': 'installed'}))
            (old / 'data.tar.gz').write_bytes(b'obsolete')
            (old / 'helper.py').write_text('historical diagnostic')
            original_plan = m.plan
            with patch.object(m, 'UPGRADE', root), patch.object(m, 'inventory', return_value=containers), \
                 patch.object(m, 'plan', side_effect=lambda c, k: original_plan(c, k, base)), \
                 patch.object(m.socket, 'gethostname', return_value='ubuntu-cc'), \
                 patch.object(m.os, 'geteuid', return_value=0), \
                 patch.object(m.subprocess, 'run') as run, patch('sys.argv', ['retire', '--apply']):
                m.main()
            self.assertFalse((old / 'data.tar.gz').exists())
            self.assertTrue((kept / 'data.tar.gz').exists())
            self.assertTrue((old / 'record.json').exists())
            self.assertTrue((old / 'helper.py').exists())
            self.assertTrue((old / 'RETIRED-BACKUP.json').exists())
            report = json.loads(next(root.glob('retirement-*.json')).read_text())
            self.assertEqual(report['state'], 'completed')
            self.assertEqual(report['removed'], [str(old / 'data.tar.gz')])
            run.assert_called_once_with(['df', '-h', '/'], check=True)


if __name__ == '__main__':
    unittest.main()
