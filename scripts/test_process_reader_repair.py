"""Pre-adoption process-reader repair; no Docker, network or production state."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('process_repair_apply','deploy/host-update/apply.py')
boot=load('process_repair_boot','apps/update-service/web/host-bootstrap.py')

class ProcessReaderTests(unittest.TestCase):
    def test_real_table_output_preserves_arguments_and_rejects_malformed_tables(self):
        tree=ast.parse((ROOT/'apps/update-service/web/host-operations.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name=='inspect_original')
        start=next(i for i,n in enumerate(fn.body)if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='rows'for t in n.targets))
        code=compile(ast.Module(body=fn.body[start:start+4],type_ignores=[]),'process-table','exec')
        for text,valid in [('PID COMMAND\n12 node app --flag with spaces',True),('PID CMD\n23 claude --resume id',True),('PID COMMAND',False),('garbage',False),('PID COMMAND\nnotpid node',False)]:
            with self.subTest(text=text):
                scope={'output':lambda *_:text,'container':'fixture'}
                if valid:exec(code,scope);self.assertEqual(scope['processes'][0],text.splitlines()[1].split(None,1))
                else:
                    with self.assertRaises(ValueError):exec(code,scope)

    def test_six_nodes_original_and_already_repaired_readers_are_migrated_with_audit(self):
        for node in ['ubuntu-cc','ubuntu-cc-02','ubuntu-cc-03','ubuntu-cc-04','ubuntu-cc-05','ubuntu-cc-06']:
            for repaired in [False,True]:
                with self.subTest(node=node,repaired=repaired):self.exercise(node,repaired)

    def test_unknown_core_or_other_changed_sources_or_active_platform_remain_blocked(self):
        for damaged in ['reader','other','inventory','active']:
            with self.subTest(damaged=damaged):self.exercise('ubuntu-cc-03',False,damaged)

    def test_build25_target_verifier_is_migrated_before_initial_activation(self):
        self.exercise('ubuntu-cc',False,original_ref='67a7a91280aaa0a899471e9bf4a123cbbc928930')

    def test_build27_reader_staged_by_a_failed_adoption_is_migrated(self):
        # ubuntu-cc's 2026-11-16 Build 27 attempt staged signed Build 27's host-operations.py.
        self.exercise('ubuntu-cc',False,original_ref='53e7b53a44940dd9b5a6335d00a55f3aeb04e34e')

    def exercise(self,node,repaired,damaged=None,original_ref='d671527e'):
        digest=lambda raw:hashlib.sha256(raw).hexdigest()
        sources={name:(ROOT/'apps/update-service/web'/name).read_bytes()for name in boot.SOURCE_FILES}
        hashes={name:digest(raw)for name,raw in sources.items()};keys={'fixture':'public'}
        original=subprocess.check_output(['git','show',original_ref+':apps/update-service/web/host-operations.py'],cwd=ROOT)
        with tempfile.TemporaryDirectory()as directory:
            root=Path(directory);program=root/'program';program.mkdir();data=root/'data';(data/'agent-platform').mkdir(parents=True)
            for name,raw in sources.items():(program/name).write_bytes(raw)
            reader=program/'host-operations.py';reader.write_bytes(sources['host-operations.py']if repaired else original)
            old=dict(hashes);old['host-operations.py']=digest(original)
            (program/'source-hashes.json').write_text(json.dumps(old));(program/'trusted-keys.json').write_text(json.dumps(keys))
            if damaged=='reader':reader.write_bytes(b'unknown')
            if damaged=='other':(program/'host-platform.py').write_bytes(b'unknown')
            if damaged=='inventory':(program/'source-hashes.json').write_text('{}')
            before={p.name:p.read_bytes()for p in program.iterdir()}
            core=SimpleNamespace(_protect=lambda *_:None,_digest=digest,_json=json.loads,_canonical=lambda v:json.dumps(v,sort_keys=True,separators=(',',':')).encode(),_state=lambda _:dict(current={'version':1}if damaged=='active'else None,floor=0),_directory=lambda p:p.mkdir(exist_ok=True),_write=lambda p,b:p.write_bytes(b))
            if damaged:
                with self.assertRaises(RuntimeError):m.repair_process_reader(core,boot,program,data,sources,hashes,keys)
                self.assertEqual(before,{p.name:p.read_bytes()for p in program.iterdir()});return
            m.repair_process_reader(core,boot,program,data,sources,hashes,keys)
            self.assertEqual(reader.read_bytes(),sources['host-operations.py'])
            self.assertEqual(json.loads((program/'source-hashes.json').read_bytes()),hashes)
            self.assertEqual(len(list((data/'agent-platform/process-reader-repair').iterdir())),2)
            m.repair_process_reader(core,boot,program,data,sources,hashes,keys)

if __name__=='__main__':unittest.main()
