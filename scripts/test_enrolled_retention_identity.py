"""Wire enrolled Docker selection into the real rollback identity verifier."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('enrolled_identity_apply','deploy/host-update/apply.py')
r=load('enrolled_identity_retirement','scripts/retire-ubuntu-cc-backups.py')

class EnrolledIdentityTests(unittest.TestCase):
    def fixture(self,root):
        current={'Id':'a'*64,'Image':'sha256:current','Name':'/cc-desk-tunnel-test-proxy-1',
                 'Config':{'Labels':{'com.docker.compose.project':'cc-desk-tunnel-test'}},
                 'State':{'Running':True,'Paused':False,'Health':{'Status':'healthy'}}}
        previous={'Id':'b'*64,'Image':'sha256:previous','Name':'/old-required',
                  'State':{'Status':'exited'}}
        backup=root/'backup-current';backup.mkdir()
        for name in ['rollback.py','helper.py']:(backup/name).write_bytes(b'required')
        (backup/'data.tar.gz').write_bytes(b'valid cold backup')
        (backup/'original.json').write_text(json.dumps(previous))
        (backup/'record.json').write_text(json.dumps({'phase':'installed','containerId':current['Id'],
            'imageId':current['Image'],'archiveSha256':hashlib.sha256(b'valid cold backup').hexdigest()}))
        return current,previous,backup

    def test_short_id_selection_reaches_retention_with_canonical_name_and_verified_rollback(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();current,previous,backup=self.fixture(root)
            helper=SimpleNamespace(Engine=lambda:SimpleNamespace(request=lambda *_:current))
            with patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout='a'*12+'\n')):
                selected=m.selected_container(helper,None,'fixture',{})
            retired=[];rotated=[]
            def retire(path,container_name,apply):
                self.assertTrue(apply)
                verified,kept=r.preserved_rollback([current,previous],path,container_name)
                self.assertEqual(verified['Id'],current['Id']);self.assertEqual(kept,backup)
                retired.append(container_name)
            support=SimpleNamespace(retire=retire)
            images=SimpleNamespace(rotate=lambda *args:rotated.append(args))
            with patch.object(m,'ROOT',root),patch.object(m,'load',side_effect=[support,images]):
                m.retain_previous_backup(selected,'cc-space-runtime:keep')
            self.assertEqual(selected,'cc-desk-tunnel-test-proxy-1')
            self.assertEqual(retired,[selected])
            self.assertEqual(rotated[0][2:],(selected,'cc-space-runtime:keep'))

    def test_selector_still_refuses_zero_or_multiple_owned_proxies(self):
        helper=SimpleNamespace(Engine=lambda:SimpleNamespace(request=lambda *_:{'Name':'/owned',
            'Config':{'Labels':{'com.docker.compose.project':'cc-desk-tunnel-test'}}}))
        for output in ['','a'*12+'\n'+'b'*12+'\n']:
            with self.subTest(output=output),patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=output)):
                with self.assertRaisesRegex(RuntimeError,'exactly one'):m.selected_container(helper,None,'fixture',{})

    def test_pending_failure_names_exception_class_even_without_message(self):
        output=io.StringIO()
        with patch.object(m,'load',side_effect=StopIteration),contextlib.redirect_stdout(output):
            m.retain_previous_backup('missing')
        self.assertIn('StopIteration:',output.getvalue())

    def test_manual_reviewed_node_selection_stays_unchanged(self):
        self.assertEqual(m.selected_container(None,SimpleNamespace(NODES={'fixture':'named-container'}),'fixture',None),'named-container')

if __name__=='__main__':unittest.main()
