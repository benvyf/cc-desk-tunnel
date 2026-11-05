import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).parents[1] / 'deploy/host-update/cleanup.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CleanupTests(unittest.TestCase):
    def test_only_unreferenced_candidates_and_unpacked_files_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['build12-abcdefgh', 'build11-abcdefgh', 'build10-abcdefgh', 'build13-abcdefgh']:
                work=root/name;(work/'program').mkdir(parents=True)
                (work/'program/code').write_text('disposable')
                (work/'policy').mkdir();(work/'build.log').write_text('keep')
            backup=root/'backup-test';backup.mkdir()
            (backup/'original.json').write_text(json.dumps({'Image':'sha256:backup','Mounts':[{'Source':str(root/'build11-abcdefgh/policy')}]}))
            (backup/'data.tar.gz').write_bytes(b'backup')
            tags={n:f'cc-space-runtime:build{n}-'+('a'*12)+'-'+('b'*12) for n in [10,11,12,13,14]}
            removed=[];calls=[]
            def command(args):
                calls.append(args)
                if args[:3]==['docker','ps','-aq']:return 'container'
                if args[:2]==['docker','inspect']:
                    return json.dumps([{'Image':'sha256:10','Mounts':[{'Source':str(root/'build10-abcdefgh/policy')}]}])
                if args[:3]==['docker','image','ls']:
                    return '\n'.join(json.dumps({'Repository':'cc-space-runtime','Tag':tag.split(':',1)[1]}) for tag in tags.values())
                if args[:3]==['docker','image','inspect']:
                    number=next(n for n,tag in tags.items() if tag==args[3])
                    return json.dumps([{'Id':'sha256:backup' if number==11 else f'sha256:{number}',
                        'RepoTags':[tags[number]]+(['custom:keep'] if number==14 else [])}])
                if args[:3]==['docker','image','rm']:removed.append(args[3])
                return ''
            with patch.object(m,'command',side_effect=command),patch.object(m.shutil,'which',return_value='/usr/bin/apt-get'),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=1024)):
                m.clean(root,root/'build13-abcdefgh/program',tags[13])
            self.assertEqual(removed,[tags[12]])
            self.assertFalse((root/'build12-abcdefgh/program').exists())
            for name in ['build10-abcdefgh','build11-abcdefgh','build13-abcdefgh']:
                self.assertTrue((root/name/'program/code').exists())
            self.assertTrue((root/'build12-abcdefgh/build.log').exists())
            self.assertTrue((root/'build12-abcdefgh/policy').is_dir())
            self.assertEqual((backup/'data.tar.gz').read_bytes(),b'backup')
            self.assertIn(['apt-get','clean'],calls)
            self.assertFalse(any('system' in call or 'volume' in call or '--force' in call and 'builder' not in call for call in calls))

    def test_unreadable_rollback_record_stops_candidate_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'backup-test').mkdir();(root/'backup-test/original.json').write_text('invalid')
            calls=[]
            def command(args):
                calls.append(args)
                return ''
            with patch.object(m,'command',side_effect=command),patch.object(m.shutil,'which',return_value=None),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=1024)):
                with self.assertRaises(json.JSONDecodeError):m.clean(root,root/'current/program','keep')
            self.assertFalse(any(call[:3]==['docker','image','rm'] for call in calls))


if __name__=='__main__':unittest.main()
