import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import http.client

spec=importlib.util.spec_from_file_location('host_agent',Path(__file__).parents[1]/'web/host-updater-agent.py')
agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    release={'build':11,'protocol':23,'sha256':'a'*64}

    def test_new_job_never_inherits_the_previous_targets_success_proof(self):
        state={'target':self.release,'floor':11}
        agent.begin_job(state,'new-job')
        self.assertNotIn('target',state)
        self.assertEqual(state['lastJob'],'new-job')
        self.assertEqual(state['report']['state'],'running')

    def test_ordinary_update_requests_host_admission_only_when_supported(self):
        for supported in (True,False):
            with self.subTest(supported=supported), tempfile.TemporaryDirectory() as directory:
                status={'current':{'build':10},'phase':'committed','check':{'compatible':True,'reason':'available'},'hostMaintenance':supported}
                with patch.object(agent,'verify_index',return_value=self.release),patch.object(agent,'request',return_value=b'{}'),patch.object(agent,'probe',return_value=status),patch.object(agent,'container',return_value='container'),patch.object(agent,'node_command',side_effect=lambda identity,target:target):
                    args,release=agent.command_for({},dict(build=11,sha256='a'*64,index={}),Path(directory),10)
                self.assertEqual(args.get('host',False),supported)
                self.assertEqual(release,self.release)

    def test_interrupted_job_success_requires_exact_persisted_target_and_committed_identity(self):
        for actual_hash,phase,serving,expected in [('a'*64,'committed',True,'succeeded'),('b'*64,'committed',True,'failed'),('a'*64,'staging',True,'failed'),('a'*64,'committed',False,'failed'),('a'*64,'committed',None,'failed')]:
            state={'floor':10,'target':self.release,'report':{'id':'job','state':'running'}}
            status={'current':self.release|{'sha256':actual_hash},'phase':phase,'serving':serving}
            with patch.object(agent,'probe',return_value=status),patch.object(agent,'progress',return_value='local log'):
                agent.reconcile_interrupted(state,{'token':'fixture'})
            self.assertEqual(state['report']['state'],expected)
            self.assertEqual(state['floor'],11 if expected=='succeeded' else 10)

    def test_same_build_and_protocol_without_hash_is_not_success(self):
        with patch.object(agent,'probe',return_value={'current':{'build':11,'protocol':23},'phase':'committed'}):
            self.assertFalse(agent.target_ready(self.release))

    def test_read_download_retries_transient_error_but_poll_mutation_does_not(self):
        response=SimpleNamespace(read=lambda limit:b'{}',__enter__=lambda self:self,__exit__=lambda *a:None)
        class Response:
            def __enter__(self):return response
            def __exit__(self,*a):pass
        for mutation,count in ((False,3),(True,1)):
            opener=SimpleNamespace(open=unittest.mock.Mock(side_effect=[urllib.error.URLError('offline'),urllib.error.URLError('offline'),Response()]))
            with patch.object(agent.urllib.request,'build_opener',return_value=opener),patch.object(agent.time,'sleep'):
                if mutation:
                    with self.assertRaises(urllib.error.URLError):agent.request({'origin':'https://example.invalid','token':'fixture'},'/poll',value={})
                else:self.assertEqual(agent.request({'origin':'https://example.invalid'},'/download',authenticated=False),b'{}')
            self.assertEqual(opener.open.call_count,count)

    def test_truncated_response_body_retries_the_read_only_download(self):
        class Response:
            attempts=0
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,limit):
                Response.attempts+=1
                if Response.attempts==1:raise http.client.IncompleteRead(b'partial',20)
                return b'complete'
        with patch.object(agent.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda *a,**k:Response())),patch.object(agent.time,'sleep'):
            self.assertEqual(agent.request({'origin':'https://example.invalid'},'/artifact',authenticated=False),b'complete')
        self.assertEqual(Response.attempts,2)


if __name__=='__main__':unittest.main()
