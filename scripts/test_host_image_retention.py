"""Reference and recovery protection for bounded image retention; Docker is simulated."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT/path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
m = load('images', 'deploy/host-update/images.py')
r = load('image_retirement_support', 'scripts/retire-ubuntu-cc-backups.py')


class ImageRetentionTests(unittest.TestCase):
    def fixture(self, base):
        root = base/'cc-runtime-upgrade'; root.mkdir()
        def container(identifier, name, running=False):
            return dict(Id=identifier, Image='sha256:'+identifier, Name='/'+name,
                State=dict(Running=running, Status='running' if running else 'exited',
                           StartedAt='start', Health={'Status':'healthy'}),
                Config={'Env':['HOME=/data/home']},
                Mounts=[dict(Type='bind',Source=str(base/'history'),Destination='/data',RW=True)])
        current = container('current', 'production', True)
        previous = container('previous', 'production-before-required')
        obsolete = container('obsolete', 'production-before-obsolete')
        unrelated = container('unrelated', 'other-stopped-container')
        containers = [current, previous, obsolete, unrelated]
        keep = root/'backup-current'; keep.mkdir()
        for name in ('rollback.py', 'helper.py'): (keep/name).write_text('required')
        (keep/'data.tar.gz').write_bytes(b'verified cold backup')
        (keep/'original.json').write_text(json.dumps(previous))
        (keep/'record.json').write_text(json.dumps(dict(phase='installed', containerId='current',
            imageId=current['Image'], archiveSha256=hashlib.sha256(b'verified cold backup').hexdigest())))
        old = root/'backup-obsolete'; old.mkdir()
        (old/'original.json').write_text(json.dumps(obsolete))
        (old/'record.json').write_text(json.dumps({'phase':'installed'}))
        (old/'RETIRED-BACKUP.json').write_text(json.dumps({'keptRollback':str(keep)}))
        tags = {f'cc-space-runtime-base:{name}':dict(Id='sha256:'+name,RepoTags=[f'cc-space-runtime-base:{name}'])
                for name in ['current','previous','obsolete','unrelated','unused']}
        tags['custom:keep'] = dict(Id='sha256:custom', RepoTags=['custom:keep'])
        calls = []
        def docker(*args):
            calls.append(args)
            if args[:2] == ('image','ls'):
                return '\n'.join(json.dumps(dict(Repository=t.split(':')[0],Tag=t.split(':')[1])) for t in tags)
            if args[:2] == ('image','inspect'): return json.dumps([tags[args[2]]])
            if args[0] == 'rm':
                containers[:] = [c for c in containers if c['Id'] != args[1]]
            if args[:2] == ('image','rm'): del tags[args[2]]
            return ''
        return root, keep, old, containers, tags, calls, docker

    def run_rotation(self, root, containers, docker, **kwargs):
        with patch.object(r,'inventory',side_effect=lambda:copy.deepcopy(containers)), \
             patch.object(r,'docker',side_effect=docker), \
             patch.object(r,'LEGACY',[('cc-runtime-upgrade','backup-*')]):
            return m.rotate(r,root,'production','cc-space-runtime-base:unused',base=root.parent,**kwargs)

    def test_only_proven_obsolete_container_and_unreferenced_images_are_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root, keep, old, containers, tags, calls, docker = self.fixture(Path(directory).resolve())
            result = self.run_rotation(root,containers,docker)
            self.assertEqual(result['removedContainers'], ['obsolete'])
            self.assertEqual(result['removedImages'], ['cc-space-runtime-base:obsolete'])
            self.assertEqual({c['Id'] for c in containers}, {'current','previous','unrelated'})
            self.assertTrue((keep/'data.tar.gz').exists())
            self.assertTrue((old/'original.json').exists())
            self.assertIn('custom:keep',tags)
            self.assertIn('cc-space-runtime-base:unused',tags)
            self.assertFalse(any('--force' in c or '--volumes' in c or 'prune' in c for c in calls))
            # A second invocation is idempotent and cannot rotate the required previous generation.
            self.assertEqual(self.run_rotation(root,containers,docker)['removedContainers'], [])

    def test_unretired_backup_reference_retains_image_even_without_a_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, old, containers, tags, _, docker = self.fixture(Path(directory).resolve())
            (old/'RETIRED-BACKUP.json').unlink()
            containers[:] = [c for c in containers if c['Id'] != 'obsolete']
            self.assertEqual(self.run_rotation(root,containers,docker)['removedImages'], [])
            self.assertIn('cc-space-runtime-base:obsolete',tags)

    def test_second_clean_install_releases_previous_generation_but_keeps_new_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root, keep, _, containers, tags, _, docker = self.fixture(Path(directory).resolve())
            self.run_rotation(root,containers,docker)
            old_current=next(c for c in containers if c['Id']=='current')
            next_current=copy.deepcopy(old_current)
            next_current.update(Id='next',Image='sha256:next')
            old_current['Name']='/production-before-next'
            old_current['State'].update(Running=False,Status='exited')
            containers.append(next_current)
            tags['cc-space-runtime-base:next']=dict(Id='sha256:next',RepoTags=['cc-space-runtime-base:next'])
            new=root/'backup-next';new.mkdir()
            for name in ['helper.py','rollback.py']:(new/name).write_text('required')
            (new/'data.tar.gz').write_bytes(b'new verified backup')
            (new/'original.json').write_text(json.dumps(old_current))
            (new/'record.json').write_text(json.dumps(dict(phase='installed',containerId='next',imageId='sha256:next',
                archiveSha256=hashlib.sha256(b'new verified backup').hexdigest())))
            (keep/'RETIRED-BACKUP.json').write_text(json.dumps({'keptRollback':str(new)}))
            (keep/'data.tar.gz').unlink()
            result=self.run_rotation(root,containers,docker)
            self.assertEqual(result['removedContainers'],['previous'])
            self.assertEqual(result['removedImages'],['cc-space-runtime-base:previous'])
            self.assertTrue((new/'data.tar.gz').exists())
            self.assertIn('cc-space-runtime-base:current',tags)
            self.assertIn('cc-space-runtime-base:next',tags)

    def test_snapshot_tag_in_unretired_metadata_is_protected(self):
        with tempfile.TemporaryDirectory() as directory:
            root, keep, _, containers, tags, _, docker = self.fixture(Path(directory).resolve())
            tag='cc-bootstrap-snapshot:required-snapshot'
            tags[tag]=dict(Id='sha256:snapshot',RepoTags=[tag])
            (keep/'snapshot.json').write_text(json.dumps({'snapshotImage':tag}))
            self.run_rotation(root,containers,docker)
            self.assertIn(tag,tags)

    def test_unmapped_backup_payload_blocks_resource_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, _, containers, _, calls, docker = self.fixture(Path(directory).resolve())
            unknown=root.parent/'legacy/production-backup';unknown.mkdir(parents=True)
            (unknown/'data.tar').write_bytes(b'unknown rollback payload')
            with patch.object(r,'inventory',side_effect=lambda:copy.deepcopy(containers)), \
                 patch.object(r,'docker',side_effect=docker), \
                 patch.object(r,'LEGACY',[('cc-runtime-upgrade','backup-*'),('legacy','production-backup')]):
                with self.assertRaisesRegex(RuntimeError,'Unmapped rollback'):
                    m.rotate(r,root,'production',None,base=root.parent)
            self.assertEqual(calls,[])

    def test_partial_retirement_running_container_and_independent_data_are_preserved(self):
        for reason in ['payload','running','independent-data','outside-home','foreign-name']:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                root, _, old, containers, _, _, docker = self.fixture(Path(directory).resolve())
                target=next(c for c in containers if c['Id']=='obsolete')
                if reason=='payload': (old/'data.tar.gz').write_bytes(b'unretired')
                elif reason=='running': target['State'].update(Status='running',Running=True)
                elif reason=='independent-data': target['Mounts'][0]['Source'] += '-private-history'
                elif reason=='outside-home': target['Config']['Env']=['HOME=/home/account']
                else: target['Name']='/unrelated-old-container'
                result=self.run_rotation(root,containers,docker)
                self.assertEqual(result['removedContainers'],[])
                self.assertEqual(result['removedImages'],[])

    def test_damaged_required_backup_blocks_all_resource_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            root, keep, _, containers, _, calls, docker = self.fixture(Path(directory).resolve())
            (keep/'data.tar.gz').write_bytes(b'damaged')
            with self.assertRaisesRegex(RuntimeError,'checksum'):
                self.run_rotation(root,containers,docker)
            self.assertEqual(calls,[])

    def test_foreign_alias_and_dry_run_prevent_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, _, containers, tags, calls, docker = self.fixture(Path(directory).resolve())
            tags['cc-space-runtime-base:obsolete']['RepoTags'].append('user:custom')
            result=self.run_rotation(root,containers,docker,apply=False)
            self.assertEqual(result['removedContainers'],[])
            self.assertEqual(result['removedImages'],[])
            self.assertFalse(any(c[0]=='rm' or c[:2]==('image','rm') for c in calls))

    def test_reference_changes_abort_container_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _, _, containers, _, calls, docker = self.fixture(Path(directory).resolve())
            changed=copy.deepcopy(containers);changed[2]['State']['Status']='running'
            with patch.object(r,'inventory',side_effect=[copy.deepcopy(containers),changed]), \
                 patch.object(r,'docker',side_effect=docker), \
                 patch.object(r,'LEGACY',[('cc-runtime-upgrade','backup-*')]):
                with self.assertRaisesRegex(RuntimeError,'references changed'):
                    m.rotate(r,root,'production',None,base=root.parent)
            self.assertFalse(any(c[0]=='rm' for c in calls))


if __name__=='__main__': unittest.main()
