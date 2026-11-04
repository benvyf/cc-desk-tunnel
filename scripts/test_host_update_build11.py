"""Signed Build 11 migration admission; Docker and production nodes are never contacted."""
import copy
import importlib.util
import json
import hashlib
import io
import os
import tarfile
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build11', ROOT / 'deploy/host-update/apply.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MigrationTests(unittest.TestCase):
    def baseline(self):
        return dict(descriptor=m.BASE_DESCRIPTOR, build=10, protocol=23, node=m.NODE_VERSION, lock=m.LOCK)

    def release(self):
        return dict(build=11, protocol=23, appVersion='0.3.7', runtimeLevel=m.RUNTIME,
                    packageLockSha256=m.LOCK, sha256='a'*64, descriptorSha256='b'*64)

    def test_known_build10_is_admitted_but_changed_baselines_are_rejected(self):
        self.assertFalse(m.check_baseline(self.baseline(), self.release()))
        for key in self.baseline():
            with self.subTest(key=key):
                value=self.baseline();value[key]='unknown'
                with self.assertRaises(RuntimeError):m.check_baseline(value,self.release())

    def test_installed_exact_target_is_idempotent(self):
        value=self.baseline();value.update(descriptor='b'*64,build=11)
        self.assertTrue(m.check_baseline(value,self.release()))
        value['protocol']=22
        with self.assertRaises(RuntimeError):m.check_baseline(value,self.release())

    def test_signed_target_must_match_confirmed_identity(self):
        target=self.release()
        self.assertEqual(m.verify_release(SimpleNamespace(verify_index=lambda _:target),b'index','a'*64),target)
        for key in ['build','protocol','appVersion','runtimeLevel','packageLockSha256','sha256']:
            with self.subTest(key=key):
                value=copy.copy(target);value[key]='changed'
                with self.assertRaises(RuntimeError):
                    m.verify_release(SimpleNamespace(verify_index=lambda _:value),b'index','a'*64)

    def test_runtime_is_inherited_without_downloading_or_executing_claude(self):
        recipe=m.dockerfile('sha256:'+'c'*64)
        self.assertTrue(recipe.startswith('FROM sha256:'))
        self.assertNotIn('rm -rf /app /opt/runtime/node',recipe)
        self.assertNotIn('COPY --chown=root:root runtime/node',recipe)
        self.assertIn('program/deploy/docker/entrypoint.sh',recipe)
        self.assertNotIn('claude --',recipe)

    def test_unresolved_backup_stops_before_another_cutover(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);backup=root/'backup-fixture';backup.mkdir()
            with patch.object(m,'ROOT',root):
                with self.assertRaises(RuntimeError):m.check_recovery_records()
                for phase,changed in [('starting',True),('prepared',True)]:
                    (backup/'record.json').write_text(json.dumps(dict(phase=phase,dataChanged=changed)))
                    with self.assertRaises(RuntimeError):m.check_recovery_records()
                (backup/'record.json').write_text(json.dumps(dict(phase='installed',dataChanged=True)))
                m.check_recovery_records()

    def test_support_files_resolve_inside_signed_package(self):
        for name in ['scripts/upgrade-message-review.py','scripts/install-cc-space-037.py',
                     'apps/update-service/web/server-bootstrap.py','apps/update-service/web/fresh-install.py']:
            self.assertTrue((m.PROGRAM/name).is_file(),name)

    def exercise(self,node='ubuntu-cc',install=False,failure=None):
        if os.name!='posix':self.skipTest('Migration entry requires Linux flock')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);policy=root/'old-policy';policy.mkdir()
            (policy/'managed-settings.json').write_text('{}')
            contents={name:(ROOT/name).read_bytes() for name in ['package-lock.json','deploy/docker/runtime-level','deploy/managed-server.json']}
            descriptor=dict(schema=1,product='cc-desk-tunnel-managed-server',build=11,appVersion='0.3.7',protocol=23,sourceCommit='f'*40,
                            files={p:dict(size=len(b),sha256=hashlib.sha256(b).hexdigest()) for p,b in contents.items()})
            db=json.dumps(descriptor).encode();buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w:gz',format=tarfile.USTAR_FORMAT) as archive:
                for name,body in [*contents.items(),('SERVER-RELEASE.json',db)]:
                    entry=tarfile.TarInfo(name);entry.size=len(body);archive.addfile(entry,io.BytesIO(body))
            bundle=buffer.getvalue();release=self.release()
            release.update(sourceCommit='f'*40,size=len(bundle),sha256=hashlib.sha256(bundle).hexdigest(),descriptorSha256=hashlib.sha256(db).hexdigest())
            confirmed=root/'release.json';confirmed.write_text(json.dumps(release))
            calls=[];source=dict(Id='original',Image='sha256:'+'c'*64,Mounts=[],Config={},HostConfig={})
            real_load=m.load;real_helper=real_load('real_helper',ROOT/'apps/update-service/web/server-bootstrap.py')
            def verify(_):
                if failure=='signature':raise RuntimeError('bad signature')
                return release
            def offline(*args):
                calls.append('preflight')
                if failure=='preflight':raise RuntimeError('candidate rejected')
            helper=SimpleNamespace(DATA=root/'data',KEYS=json.loads(contents['deploy/managed-server.json'])['keys'],ORIGIN='https://api.ghostapi.org',
                Engine=lambda:SimpleNamespace(request=lambda *args:copy.deepcopy(source)),validate_runtime=lambda _:None,
                download=lambda path,*_:b'index' if path.endswith('.json') else bundle,unpack=real_helper.unpack,
                offline_preflight=offline,clone_config=lambda *_:dict(HostConfig={}))
            def clone_policy(old,new,program):new.mkdir();return None
            review=SimpleNamespace(NODES={n:n for n in ['ubuntu-cc','ubuntu-cc-02','ubuntu-cc-03']},protected=lambda *_:None,
                adapt=lambda *_:policy,policy_copy=clone_policy,with_policy=lambda config,_:config,same_configuration=lambda *_:True,
                logged=lambda *_args,**_kwargs:calls.append('build'))
            def install_fake(support,**kwargs):
                self.assertTrue(kwargs['disconnect_clients']);support.validate_cutover(source)
                support.clone_config(source,'candidate');calls.append('installed')
            def idle(*_):
                if failure=='busy':raise RuntimeError('active task')
            legacy=SimpleNamespace(check_idle=idle,check_space=lambda **_:None,install=install_fake)
            def load(name,path):
                return {'message_upgrade_support':review,'runtime_bootstrap_support':helper,'runtime_signed_release':SimpleNamespace(download=lambda *_:None,verify_index=verify),'runtime_cutover':legacy}.get(name) or real_load(name,path)
            def run(args,**kwargs):
                if args[:3]==['docker','image','inspect']:
                    if len(args)==4:return SimpleNamespace(returncode=1)
                    return SimpleNamespace(returncode=0,stdout=json.dumps([dict(Id='candidate',RootFS=dict(Layers=['wrong' if failure=='layers' else 'base','new'])),dict(RootFS=dict(Layers=['base']))]).encode())
                return SimpleNamespace(returncode=0)
            with patch.object(m,'ROOT',root/'private'),patch.object(m,'load',side_effect=load),patch.object(m,'verify_runtime',return_value=self.baseline()),patch.object(m,'candidate_check'),patch.object(m,'check_docker_storage'),patch.object(m.os,'geteuid',return_value=0),patch.object(m.socket,'gethostname',return_value=node),patch.object(m.subprocess,'run',side_effect=run),patch('sys.argv',['apply','--release',str(confirmed),*(['--install'] if install else [])]):
                if failure:
                    with self.assertRaises(RuntimeError):m.main()
                else:m.main()
            self.assertEqual('installed' in calls,install and not failure)
            if failure in ['signature','busy']:self.assertNotIn('build',calls)

    def test_prepare_never_installs(self):self.exercise()

    def test_three_node_install_entries_use_paired_policy_and_idle_cutover(self):
        for node in ['ubuntu-cc','ubuntu-cc-02','ubuntu-cc-03']:
            with self.subTest(node=node):self.exercise(node=node,install=True)

    def test_admission_and_preflight_failures_never_cut_over(self):
        for failure in ['signature','busy','layers','preflight']:
            with self.subTest(failure=failure):self.exercise(install=True,failure=failure)


if __name__=='__main__':unittest.main()
