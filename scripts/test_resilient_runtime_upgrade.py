"""Regression checks without Docker, live accounts or filesystem mutation outside fixtures."""
import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import http.client
import hashlib
import os
import shutil


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cutover = load('resilient_cutover', 'install-cc-space-037.py')
runtime = load('resilient_runtime', 'upgrade-runtime-base.py')
GIB = 1024 ** 3


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.data / 'file').write_bytes(b'x' * 100)

    def test_same_filesystem_reports_exact_deficit_before_cutover(self):
        with patch.object(cutover, 'DATA', self.data), patch.object(cutover, 'ROOT', self.root), patch.object(cutover.shutil, 'disk_usage', return_value=SimpleNamespace(free=299)):
            with self.assertRaisesRegex(RuntimeError, r'required=300.*available=299.*missing=1.*no cutover'):
                cutover.check_space(reserve=100)

    def test_separate_filesystems_each_need_one_copy_and_reserve(self):
        backup=self.root/'backup';backup.mkdir()
        actual_stat = Path.stat
        def stat(path, **kwargs):
            value = actual_stat(path, **kwargs)
            if path in (self.root, self.data,backup):
                return SimpleNamespace(st_dev=1 if path == backup else 2, st_mode=value.st_mode,st_ino=value.st_ino)
            return value
        with patch.object(cutover, 'DATA', self.data), patch.object(cutover, 'ROOT', backup), patch.object(Path, 'stat', stat), patch.object(cutover.shutil, 'disk_usage', return_value=SimpleNamespace(free=200)):
            cutover.check_space(reserve=100)
        def free(path):
            return SimpleNamespace(free=200 if path == backup else 199)
        with patch.object(cutover, 'DATA', self.data), patch.object(cutover, 'ROOT', backup), patch.object(Path, 'stat', stat), patch.object(cutover.shutil, 'disk_usage', side_effect=free):
            with self.assertRaisesRegex(RuntimeError, 'recovery.*missing=1'):
                cutover.check_space(reserve=100)

    def test_data_mountpoint_is_rejected_before_pause_or_stop(self):
        with patch.object(cutover,'DATA',self.data),patch.object(Path,'is_mount',return_value=True),self.assertRaisesRegex(RuntimeError,'mountpoint.*no cutover'):
            cutover.check_space()

    def test_data_growth_is_remeasured_and_symlinks_are_excluded(self):
        with patch.object(cutover, 'DATA', self.data), patch.object(cutover, 'ROOT', self.root), patch.object(cutover.shutil, 'disk_usage', return_value=SimpleNamespace(free=300)):
            cutover.check_space(reserve=100)
            (self.data / 'file').write_bytes(b'x' * 101)
            with self.assertRaisesRegex(RuntimeError, 'missing=2'):
                cutover.check_space(reserve=100)

    def test_cold_backup_is_read_back_and_matched_to_source_before_cutover(self):
        archive=self.root/'data.tar.gz'
        with tarfile.open(archive,'w:gz') as tar:tar.add(self.data,arcname='data')
        with patch.object(cutover,'DATA',self.data):
            cutover.verify_cold_backup(archive)
            (self.data/'file').write_bytes(b'wrong bytes')
            with self.assertRaisesRegex(RuntimeError,'Cold backup'):
                cutover.verify_cold_backup(archive)

    def test_incomplete_but_readable_cold_backup_is_rejected(self):
        archive=self.root/'missing.tar.gz'
        with tarfile.open(archive,'w:gz') as tar:tar.add(self.data,arcname='data',recursive=False)
        with patch.object(cutover,'DATA',self.data),self.assertRaisesRegex(RuntimeError,'Cold backup'):
            cutover.verify_cold_backup(archive)


class PreparationTests(unittest.TestCase):
    @unittest.skipUnless(os.name=='posix','Real main entry uses Linux flock')
    def test_real_entry_reuses_candidate_and_rechecks_after_cleanup_before_install(self):
        for low_final_space in (False,True):
            with self.subTest(low_final_space=low_final_space),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);support=root/'support';support.mkdir()
                helper=support/'server-bootstrap.py';helper.write_bytes(b'# fixture helper')
                data=root/'data';data.mkdir();source=root/'policy';source.mkdir();(source/'policy.json').write_text('{}')
                events=[]
                original={'Id':'original','Image':'sha256:base','Config':{},'HostConfig':{},'Mounts':[]}
                release={'build':10,'protocol':23,'sha256':'a'*64,'descriptorSha256':'b'*64}
                b=SimpleNamespace(DATA=data,CONTAINER='container',KEYS={},ORIGIN='https://fixture.invalid',Engine=lambda:SimpleNamespace(request=lambda *a:original),validate_runtime=lambda value:None,download=lambda *a:b'archive',clone_config=lambda *a:{},offline_preflight=lambda *a:events.append('preflight'))
                def unpack(archive,program,value):
                    (program/'deploy').mkdir(parents=True)
                    (program/'package-lock.json').write_bytes(b'lock')
                    (program/'deploy/runtime-unused').write_text('fixture')
                    (program/'deploy/docker').mkdir()
                    (program/'deploy/docker/runtime-level').write_text('2')
                    (program/'deploy/managed-server.json').write_text(json.dumps({'runtimeLevel':runtime.RUNTIME,'keys':{},'origin':b.ORIGIN}))
                b.unpack=unpack
                review=SimpleNamespace(NODES={'ubuntu-cc':'container'},protected=lambda *a:None,adapt=lambda *a:source,policy_copy=lambda src,dst,program:shutil.copytree(src,dst))
                def space(**kwargs):
                    events.append('space-pre' if kwargs else 'space-final')
                    if not kwargs and low_final_space:raise RuntimeError('final space insufficient')
                legacy=SimpleNamespace(check_idle=lambda *a:events.append('idle'),check_space=space,install=lambda *a,**kw:events.append('install'))
                modules={'message_upgrade_support':review,'runtime_bootstrap_support':b,'runtime_signed_release':SimpleNamespace(download=lambda *a:b'node'),'runtime_cutover':legacy}
                def command(args,**kwargs):
                    if args[:3]==['docker','builder','prune']:events.append('prune')
                    if args[:3]==['docker','image','inspect'] and len(args)==5:
                        return SimpleNamespace(returncode=0,stdout=json.dumps([{'Id':'candidate','RootFS':{'Layers':['base','new']}},{'RootFS':{'Layers':['base']}}]).encode())
                    return SimpleNamespace(returncode=0,stdout=b'')
                baseline={'descriptor':next(k for k,v in runtime.BASELINES.items() if v==9),'build':9,'node':'24.21.0','lock':runtime.OLD_LOCK}
                with patch.object(runtime,'ROOT',root/'private'),patch.object(runtime,'__file__',str(support/'upgrade-runtime-base.py')),patch.object(runtime,'HELPER_SHA',hashlib.sha256(helper.read_bytes()).hexdigest()),patch.object(runtime,'LOCK',hashlib.sha256(b'lock').hexdigest()),patch.object(runtime,'load',side_effect=lambda name,path:modules[name]),patch.object(runtime,'verify_runtime',return_value=baseline),patch.object(runtime,'verify_release',return_value=release),patch.object(runtime,'candidate_check',side_effect=lambda *a:events.append('candidate')),patch.object(runtime.socket,'gethostname',return_value='ubuntu-cc'),patch.object(runtime.os,'geteuid',return_value=0),patch.object(runtime.subprocess,'run',side_effect=command),patch('sys.argv',['upgrade','--sha256','a'*64,'--cleanup','--install']):
                    if low_final_space:
                        with self.assertRaisesRegex(RuntimeError,'final space insufficient'):runtime.main()
                    else:runtime.main()
                self.assertEqual(events,['idle','prune','space-pre','candidate','preflight','prune','space-final']+([] if low_final_space else ['install']))

    def test_post_build_cleanup_happens_before_final_capacity_check(self):
        events = []
        with patch.object(runtime, 'ROOT', Path(__file__).parent), patch.object(runtime.subprocess, 'run', side_effect=lambda args, **kw: events.append(args)):
            legacy = SimpleNamespace(check_space=lambda **kw: events.append('space'))
            runtime.finish_preparation(legacy, cleanup=True)
        self.assertEqual(events, [['docker', 'builder', 'prune', '--all', '--force'], 'space'])

    def test_cleanup_failure_never_proceeds_to_capacity_or_stop(self):
        legacy = SimpleNamespace(check_space=lambda **kw: self.fail('continued after cleanup failed'))
        with patch.object(runtime, 'ROOT', Path(__file__).parent), patch.object(runtime.subprocess, 'run', side_effect=RuntimeError('prune failed')):
            with self.assertRaisesRegex(RuntimeError, 'prune failed'):
                runtime.finish_preparation(legacy, cleanup=True)

    def test_transient_download_retries_but_integrity_errors_do_not(self):
        calls = []
        def download():
            calls.append(1)
            if len(calls) < 3:
                raise urllib.error.URLError('temporary')
            return b'checked later'
        with patch.object(runtime.time, 'sleep'):
            self.assertEqual(runtime.retry_download(download), b'checked later')
        self.assertEqual(len(calls), 3)
        calls.clear()
        def partial():
            calls.append(1)
            if len(calls)==1:raise http.client.IncompleteRead(b'part',10)
            return b'complete'
        with patch.object(runtime.time,'sleep'):
            self.assertEqual(runtime.retry_download(partial),b'complete')
        self.assertEqual(len(calls),2)
        for error in (RuntimeError('checksum mismatch'), urllib.error.HTTPError('https://example.invalid', 403, 'forbidden', {}, None)):
            calls.clear()
            def refused():
                calls.append(1)
                raise error
            with self.assertRaises(type(error)), patch.object(runtime.time, 'sleep'):
                runtime.retry_download(refused)
            if isinstance(error, urllib.error.HTTPError):
                error.close()
            self.assertEqual(len(calls), 1)

    def test_pending_cutover_blocks_a_new_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory) / 'backup-example'
            backup.mkdir()
            (backup / 'record.json').write_text(json.dumps({'phase': 'starting', 'dataChanged': True}))
            with patch.object(runtime, 'ROOT', Path(directory)), self.assertRaisesRegex(RuntimeError, 'backup-example'):
                runtime.check_recovery_records()

    def test_docker_storage_on_an_unbudgeted_filesystem_stops_before_build(self):
        with patch.object(runtime.subprocess,'run',return_value=SimpleNamespace(stdout=str(Path(__file__).absolute())+'\n')),patch.object(runtime,'ROOT',Path('/backup')),patch.object(runtime.Path,'stat',side_effect=[SimpleNamespace(st_dev=2),SimpleNamespace(st_dev=1)]):
            with self.assertRaisesRegex(RuntimeError,'Docker storage.*filesystem'):
                runtime.check_docker_storage()

    def test_early_idle_probe_never_pauses_or_disconnects(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            (data / 'state').mkdir()
            with closing(sqlite3.connect(data / 'state/sessions.sqlite')) as db:
                db.execute('CREATE TABLE sessions(metadata TEXT)')
                db.execute('INSERT INTO sessions VALUES (?)', (json.dumps({'activeRun': 'run-id'}),))
                db.commit()
            events = []
            engine = SimpleNamespace(request=lambda method, path: events.append(path) or {'Processes': []})
            b = SimpleNamespace(Engine=lambda: engine, busy=lambda _: False)
            with patch.object(cutover, 'DATA', data), self.assertRaisesRegex(RuntimeError, 'waiting runs'):
                cutover.check_idle(b, {'Id': 'original'})
            self.assertEqual(events, ['/containers/original/top?ps_args=-eo%20pid,args'])


if __name__ == '__main__':
    unittest.main()
