"""Message-only image upgrade checks; no Docker or model requests."""
import copy
import hashlib
import io
import importlib.util
import json
import os
import shutil
from pathlib import Path
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('upgrade_message_review', Path(__file__).with_name('upgrade-message-review.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class UpgradeTests(unittest.TestCase):
    def test_new_policy_binding_does_not_modify_old_container_configuration(self):
        original = {'HostConfig': {'Binds': ['/srv/cc-desk-tunnel:/data:rw','/old-policy:/etc/claude-code:ro']}}
        result = m.with_policy(original, Path('/new-policy'))
        self.assertEqual(original['HostConfig']['Binds'][1], '/old-policy:/etc/claude-code:ro')
        self.assertEqual(result['HostConfig']['Binds'][0], original['HostConfig']['Binds'][0])
        self.assertEqual(result['HostConfig']['Binds'][1], str(Path('/new-policy'))+':/etc/claude-code:ro')
        mounted = {'HostConfig': {'Mounts':[{'Type':'bind','ReadOnly':True,'Source':'/old','Target':'/etc/claude-code'}]}}
        self.assertEqual(m.with_policy(mounted,Path('/new'))['HostConfig']['Mounts'][0]['Source'],str(Path('/new')))

    def test_writable_missing_or_duplicate_policy_bindings_are_refused(self):
        for bindings in [[],['/old:/etc/claude-code:rw'],['/one:/etc/claude-code:ro','/two:/etc/claude-code:ro']]:
            with self.assertRaises(RuntimeError): m.with_policy({'HostConfig':{'Binds':bindings}},Path('/new'))

    def test_adaptation_preserves_structural_validation_and_container_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory)
            for name in ['managed-settings.json','moderation-node.json']:(policy/name).write_text('{}')
            original = {'Id':'original','Image':'image','Mounts':[
                {'Type':'bind','Destination':'/data','Source':'/srv/cc-desk-tunnel','RW':True},
                {'Type':'bind','Destination':'/etc/claude-code','Source':str(policy),'RW':False}]}
            calls=[]
            helper=SimpleNamespace(validate_runtime=lambda value:calls.append(value))
            with patch.object(m,'protected'):
                self.assertEqual(m.adapt(helper,original),policy)
                helper.validate_runtime(original)
                self.assertEqual(calls[0]['Mounts'][1]['Source'],'/etc/claude-code')
                changed=copy.deepcopy(original);changed['Image']='different'
                with self.assertRaises(RuntimeError):helper.validate_runtime(changed)
                self.assertEqual(original['Mounts'][1]['Source'],str(policy))

    def test_policy_migration_copies_credentials_and_preserves_independent_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'old';source.mkdir()
            command='/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts'
            independent={'type':'command','command':'/administrator/independent'}
            old={'env':{'KEEP':'yes'},'hooks':{'PostToolBatch':[{'matcher':'old','hooks':[
                {'type':'command','command':command},independent]}]}}
            (source/'managed-settings.json').write_text(json.dumps(old))
            (source/'moderation-node.json').write_bytes(b'unchanged-node-credential-fixture')
            with patch.object(m,'protected'):
                m.policy_copy(source,root/'new',ROOT)
            result=json.loads((root/'new/managed-settings.json').read_bytes())
            self.assertEqual(result['env'],old['env'])
            self.assertEqual(result['hooks']['PostToolBatch'],[{'matcher':'old','hooks':[independent]}])
            self.assertIn('UserPromptSubmit',result['hooks'])
            self.assertEqual((source/'managed-settings.json').read_text(),json.dumps(old))
            self.assertEqual((root/'new/moderation-node.json').read_bytes(),(source/'moderation-node.json').read_bytes())

    def test_runtime_hash_checks_do_not_execute_claude_or_output_credentials(self):
        with patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=b'{"descriptor":"fixture","build":8}')) as run:
            self.assertEqual(m.verify_runtime('container','ubuntu-cc-02')['build'],8)
            args=run.call_args.args[0]
            self.assertEqual(args[:3],['docker','exec','container'])
            self.assertNotIn('--version',args)
            self.assertNotIn('console.log(m)',m.VERIFY_RUNTIME)

    def test_unsupported_nodes_stop_before_filesystem_or_docker_changes(self):
        for node in ['ubuntu-cc-04','ubuntu-cc-05','ubuntu-cc-06','unknown']:
            with patch.object(m.socket,'gethostname',return_value=node),patch.object(m.os,'geteuid',create=True,return_value=0),patch('sys.argv',['upgrade','--sha256','a'*64]),patch.object(m.subprocess,'run') as run:
                with self.assertRaises(RuntimeError):m.main()
                run.assert_not_called()

    def exercise(self, node='ubuntu-cc-02', already=False, bad_signature=False, bad_layers=False, install=False):
        if os.name != 'posix':self.skipTest('Requires Linux flock for the real command entry')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);data=root/'data';data.mkdir();policy=root/'old-policy';policy.mkdir()
            (policy/'managed-settings.json').write_text('{"hooks":{}}')
            (policy/'moderation-node.json').write_text('{"token":"fixture"}')
            content=(ROOT/'deploy/configure-moderation.py').read_bytes()
            inventory={'deploy/configure-moderation.py':{'size':len(content),'sha256':hashlib.sha256(content).hexdigest()}}
            descriptor=json.dumps({'schema':1,'product':'cc-desk-tunnel-managed-server','build':9,
                'appVersion':'0.3.7','protocol':22,'sourceCommit':'f'*40,'files':inventory}).encode()
            buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w:gz',format=tarfile.USTAR_FORMAT) as archive:
                for name,body in [('deploy/configure-moderation.py',content),('SERVER-RELEASE.json',descriptor)]:
                    entry=tarfile.TarInfo(name);entry.size=len(body);archive.addfile(entry,io.BytesIO(body))
            bundle=buffer.getvalue()
            release={'build':9,'protocol':22,'appVersion':'0.3.7','sourceCommit':'f'*40,'size':len(bundle),
                'sha256':hashlib.sha256(bundle).hexdigest(),'descriptorSha256':hashlib.sha256(descriptor).hexdigest()}
            source={'Id':'original','Image':'sha256:'+'c'*64,'Config':{},'HostConfig':{
                'Binds':[str(policy)+':/etc/claude-code:ro']},'Mounts':[],'State':{'Running':True}}
            calls=[]
            def verify(*args):
                calls.append('signature')
                if bad_signature:raise RuntimeError('bad signature')
                return {'release':release}
            # Exercise the real helper contract, including its requirement that
            # the destination must not already exist. Docker remains simulated.
            real_helper=m.load('real_unpack_helper',ROOT/'apps/update-service/web/server-bootstrap.py')
            def engine(*args):return copy.deepcopy(source)
            helper=SimpleNamespace(CONTAINER='',PROFILE={'files':{}},DATA=data,Engine=lambda:SimpleNamespace(request=engine),
                validate_runtime=lambda _:None,download=lambda path,*args:b'fixture' if path.endswith('.json') else bundle,
                verify_index=verify,unpack=real_helper.unpack,
                runtime_and_policy=lambda _:calls.append('runtime-policy'),command=lambda *args:calls.append('build'),
                offline_preflight=lambda *args:calls.append('offline'),clone_config=lambda original,image:{'HostConfig':original['HostConfig']},
                live_status=lambda *args,**kwargs:calls.append('already-status'))
            def install_fake(support,**kwargs):
                current=copy.deepcopy(source);current['State']['NewHealthLog']='normal runtime progress'
                cloned=support.clone_config(current,'candidate')
                self.assertNotEqual(cloned['HostConfig']['Binds'][0],source['HostConfig']['Binds'][0])
                self.assertTrue(kwargs['disconnect_clients']);calls.append('installed')
            legacy=SimpleNamespace(install=install_fake)
            baseline={'descriptor':release['descriptorSha256'] if already else next(k for k,v in m.BASELINES.items() if v==8),'build':8}
            real_load=m.load
            def load(name,path):
                if name=='bootstrap_support':return helper
                if name=='message_cutover':return legacy
                return real_load(name,path)
            def command(args,**kwargs):
                if args[:3]==['docker','image','inspect']:
                    return SimpleNamespace(returncode=0,stdout=json.dumps([
                      {'Id':'candidate','RootFS':{'Layers':['wrong' if bad_layers else 'base','new']}},
                      {'RootFS':{'Layers':['base']}}]).encode())
                return SimpleNamespace(returncode=0)
            # Use the real pinned helper's bytes without placing files in the repository.
            script=root/'upgrade-message-review.py';script.write_text('fixture')
            shutil.copyfile(ROOT/'apps/update-service/web/server-bootstrap.py',root/'server-bootstrap.py')
            with patch.object(m,'ROOT',root/'private'),patch.object(m,'__file__',str(script)),patch.object(m,'protected'),patch.object(m,'adapt',return_value=policy),patch.object(m,'load',side_effect=load),patch.object(m,'verify_runtime',return_value=baseline),patch.object(m,'candidate_check'),patch.object(m.os,'geteuid',create=True,return_value=0),patch.object(m.socket,'gethostname',return_value=node),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)),patch.object(m.subprocess,'run',side_effect=command),patch('sys.argv',['upgrade','--sha256','a'*64,*(['--install'] if install else [])]):
                if bad_signature or bad_layers:
                    with self.assertRaises(RuntimeError):m.main()
                    self.assertNotIn('installed',calls)
                else:m.main()
            if not bad_signature and not bad_layers:
                self.assertEqual('installed' in calls,install and not already)
                self.assertEqual('offline' in calls,not already)
            if bad_signature:self.assertNotIn('build',calls)

    def test_preparation_never_switches_service(self):self.exercise()
    def test_all_three_nodes_can_install_the_new_paired_policy(self):
        for node in m.NODES:
            with self.subTest(node=node):self.exercise(node=node,install=True)
    def test_same_target_is_idempotent(self):self.exercise(already=True,install=True)
    def test_bad_signature_stops_before_image_preparation(self):self.exercise(bad_signature=True,install=True)
    def test_wrong_candidate_base_stops_before_cutover(self):self.exercise(bad_layers=True,install=True)


if __name__ == '__main__':unittest.main()
