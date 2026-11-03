"""Exercise the actual offline rollback with real temporary archives and simulated Docker."""
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.parse

spec=importlib.util.spec_from_file_location('resumable_cutover',Path(__file__).with_name('install-cc-space-037.py'))
cutover=importlib.util.module_from_spec(spec);spec.loader.exec_module(cutover)


@contextmanager
def fixture(candidate=False,free=10*1024**3):
    with tempfile.TemporaryDirectory() as directory:
        root=Path(directory);data=root/'data';data.mkdir();(data/'session').write_text('original')
        backup=root/'backup-fixture';backup.mkdir()
        archive=backup/'data.tar.gz'
        with tarfile.open(archive,'w:gz') as tar:tar.add(data,arcname='data')
        (data/'session').write_text('candidate')
        record={'phase':'starting','dataChanged':True,'archiveSha256':cutover.digest(archive)}
        original={'Id':'old','State':{'Running':False,'Paused':False}}
        (backup/'record.json').write_text(json.dumps(record));(backup/'original.json').write_text(json.dumps(original))
        calls=[];extractions=[]
        replacement={'Id':'new','State':{'Running':True},'NetworkSettings':{'Networks':{'network':{}}}}
        def request(method,path,*args):
            calls.append((method,path))
            if '/top?' in path:return {'Processes':[]}
            return replacement if path=='/containers/new/json' else original
        def extract(args,backup):
            extractions.append(args[-1])
            with tarfile.open(archive,'r:gz') as tar:tar.extractall(args[-1],filter='data')
        def save(path,value):path.write_text(json.dumps(value))
        b=SimpleNamespace(CONTAINER='service',Engine=lambda:SimpleNamespace(request=request),recovery_container=lambda *a:('new',replacement) if candidate else (None,None),restore=lambda *a:calls.append(('RESTORE','old')),wait_healthy=lambda *a:None,durable_json=save,busy=lambda *a:False,frozen_idle=lambda *a:None,urllib=SimpleNamespace(parse=urllib.parse))
        with patch.object(cutover,'DATA',data),patch.object(cutover,'ROOT',root),patch.object(cutover,'private_command',side_effect=extract),patch.object(cutover.shutil,'disk_usage',return_value=SimpleNamespace(free=free)):
            yield SimpleNamespace(root=root,data=data,backup=backup,b=b,calls=calls,extractions=extractions)


class RollbackTests(unittest.TestCase):
    def test_rollback_resumes_an_already_paused_candidate_after_lost_pause_reply(self):
        with fixture(candidate=True) as f:
            request=f.b.Engine().request
            paused=[False];pause_calls=[]
            def interrupted(method,path,*args):
                if path=='/containers/new/pause':
                    pause_calls.append(path)
                    if paused[0]:raise RuntimeError('Docker 409: already paused')
                    paused[0]=True
                    raise KeyboardInterrupt('pause response lost')
                result=request(method,path,*args)
                if path=='/containers/new/json':result['State']['Paused']=paused[0]
                if path=='/containers/new/unpause':paused[0]=False
                return result
            f.b.Engine=lambda:SimpleNamespace(request=interrupted)
            with self.assertRaises(KeyboardInterrupt):cutover.rollback(f.b,f.backup)
            cutover.rollback(f.b,f.backup)
            self.assertEqual(len(pause_calls),1)
            self.assertFalse(paused[0])
            self.assertEqual((f.data/'session').read_text(),'original')
            self.assertIn(('RESTORE','old'),f.calls)

    def test_busy_candidate_that_was_already_paused_stays_paused(self):
        with fixture(candidate=True) as f:
            request=f.b.Engine().request
            def paused(method,path,*args):
                result=request(method,path,*args)
                if path=='/containers/new/json':result['State']['Paused']=True
                return result
            f.b.Engine=lambda:SimpleNamespace(request=paused)
            f.b.busy=lambda *args:True
            with self.assertRaisesRegex(RuntimeError,'Finish Claude tasks'):
                cutover.rollback(f.b,f.backup)
            self.assertNotIn(('POST','/containers/new/unpause'),f.calls)

    def test_repeating_rollback_after_each_directory_move_restores_old_data_and_retains_candidate(self):
        for interrupt in ('preserve','restore'):
            with self.subTest(interrupt=interrupt),fixture() as f:
                rename=Path.rename
                def interrupted(path,target):
                    result=rename(path,target)
                    if (interrupt=='preserve' and path==f.data) or (interrupt=='restore' and Path(target)==f.data):
                        raise KeyboardInterrupt('injected hard interruption after rename')
                    return result
                with patch.object(Path,'rename',interrupted),self.assertRaises(KeyboardInterrupt):
                    cutover.rollback(f.b,f.backup)
                self.assertNotIn(('RESTORE','old'),f.calls)
                cutover.rollback(f.b,f.backup)
                self.assertEqual((f.data/'session').read_text(),'original')
                record=json.loads((f.backup/'record.json').read_text())
                self.assertEqual((Path(record['preservedNewData'])/'session').read_text(),'candidate')
                self.assertEqual(record['phase'],'rolled-back')
                self.assertFalse(record['dataChanged'])
                self.assertEqual(len(f.extractions),1)

    def test_unknown_preserved_directory_is_never_overwritten(self):
        with fixture() as f:
            preserved=f.data.with_name(f.data.name+'.after-'+f.backup.name)
            preserved.mkdir();(preserved/'keep').write_text('unrelated')
            with self.assertRaisesRegex(RuntimeError,'preserved|Preserved'):
                cutover.rollback(f.b,f.backup)
            self.assertEqual((preserved/'keep').read_text(),'unrelated')
            self.assertEqual((f.data/'session').read_text(),'candidate')
            self.assertEqual(len(f.extractions),0)

    def test_recovery_space_is_checked_before_stopping_the_candidate(self):
        with fixture(candidate=True,free=0) as f:
            with self.assertRaisesRegex(RuntimeError,'recovery space'):
                cutover.rollback(f.b,f.backup)
            self.assertFalse(any(method=='POST' for method,path in f.calls))
            self.assertEqual((f.data/'session').read_text(),'candidate')

    def test_candidate_network_admission_closes_before_unpause_and_stop(self):
        with fixture(candidate=True) as f:
            cutover.rollback(f.b,f.backup)
            paths=[path for method,path in f.calls if method=='POST']
            self.assertLess(paths.index('/networks/network/disconnect'),paths.index('/containers/new/unpause'))
            self.assertLess(paths.index('/containers/new/unpause'),paths.index('/containers/new/stop?t=30'))

    def test_unknown_current_tree_is_refused_without_directory_renames(self):
        with fixture() as f:
            record=json.loads((f.backup/'record.json').read_text())
            cutover.prepare_restore(f.b,f.backup,record)
            f.data.rename(f.root/'candidate-moved-by-admin')
            f.data.mkdir();(f.data/'unrelated').write_text('do not change')
            with patch.object(Path,'rename',side_effect=AssertionError('unexpected rename')):
                with self.assertRaisesRegex(RuntimeError,'Unknown current data'):
                    cutover.rollback(f.b,f.backup)
            self.assertEqual((f.data/'unrelated').read_text(),'do not change')

    def test_interrupted_extraction_resumes_only_the_recorded_private_stage(self):
        with fixture() as f:
            extract=cutover.private_command.side_effect
            def partial(args,backup):extract(args,backup);raise KeyboardInterrupt('after extraction')
            with patch.object(cutover,'private_command',side_effect=partial),self.assertRaises(KeyboardInterrupt):
                cutover.rollback(f.b,f.backup)
            cutover.rollback(f.b,f.backup)
            self.assertEqual(len(set(f.extractions)),1)
            self.assertEqual((f.data/'session').read_text(),'original')


if __name__=='__main__':unittest.main()
