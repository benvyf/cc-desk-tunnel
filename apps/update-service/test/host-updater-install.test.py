import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import base64
import subprocess
import sys
from contextlib import nullcontext

spec=importlib.util.spec_from_file_location('host_install',Path(__file__).parents[1]/'web/host-updater-install.py')
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    @staticmethod
    def exchange_fixture(left,right):
        temporary=left.with_name(left.name+'.exchange-fixture')
        left.rename(temporary);right.rename(left);temporary.rename(right)

    @unittest.skipUnless(os.name=='posix','Linux atomic directory exchange required')
    def test_atomic_program_exchange_retains_canonical_tree_after_hard_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);live=root/'live';candidate=root/'candidate'
            live.mkdir();candidate.mkdir();(live/'agent.py').write_text('old complete');(candidate/'agent.py').write_text('new complete')
            script="import importlib.util,os,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.exchange_program(Path(sys.argv[2]),Path(sys.argv[3]));m.sync_directory(Path(sys.argv[2]).parent);os._exit(77)"
            result=subprocess.run([sys.executable,'-c',script,str(Path(__file__).parents[1]/'web/host-updater-install.py'),str(live),str(candidate)],capture_output=True,text=True)
            self.assertEqual(result.returncode,77,result.stderr)
            self.assertEqual((live/'agent.py').read_text(),'new complete')
            self.assertEqual((candidate/'agent.py').read_text(),'old complete')
    @unittest.skipUnless(os.name=='posix','Linux flock required')
    def test_two_enrollments_cannot_overlap_or_share_agent_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with installer.enrollment_lock(root):
                with self.assertRaisesRegex(RuntimeError,'Another host channel enrollment'):
                    with installer.enrollment_lock(root):self.fail('overlapping enrollment entered')
                self.assertTrue((root/'enrollment.lock').exists())
                self.assertFalse((root/'agent.lock').exists())
    def test_new_agent_start_failure_restores_old_program_with_new_enrolled_credentials(self):
        self.failure_case(False)

    def test_directory_sync_failure_after_exchange_restores_old_program(self):
        self.failure_case(False,True)

    def test_consumed_grant_with_config_persistence_failure_requires_reenrollment(self):
        self.failure_case(True)

    def failure_case(self,credential_failure,fail_exchange_sync=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            paths={'/var/lib/cc-host-updater':root/'state','/opt/cc-host-updater':root/'program','/etc/systemd/system/cc-host-updater.service':root/'unit.service'}
            for key in ('/var/lib/cc-host-updater','/opt/cc-host-updater'):paths[key].mkdir()
            config=paths['/var/lib/cc-host-updater']/'config.json';config.write_text('{"token":"old"}')
            agent=paths['/opt/cc-host-updater']/'agent.py';agent.write_text('old program')
            paths['/etc/systemd/system/cc-host-updater.service'].write_text('old unit')
            commands=[]
            def run(args,**kwargs):
                commands.append(args)
                if args==['systemctl','enable','--now','cc-host-updater.service']:raise subprocess.CalledProcessError(1,args)
                return SimpleNamespace(returncode=0)
            class Response:
                def __enter__(self):return self
                def __exit__(self,*args):pass
                def read(self,limit):return json.dumps({'token':'n'*43}).encode()
            actual_stat=Path.stat
            actual_sync=installer.sync_directory
            exchanged=[0];sync_failed=[False]
            def exchange(left,right):
                self.exchange_fixture(left,right)
                if left==paths['/opt/cc-host-updater']:exchanged[0]+=1
            def sync(path):
                if fail_exchange_sync and exchanged[0]==1 and path==paths['/opt/cc-host-updater'].parent and not sync_failed[0]:
                    sync_failed[0]=True
                    raise OSError('simulated directory sync failure after exchange')
                actual_sync(path)
            original_replace=Path.replace
            def replace(path,target):
                if credential_failure and path.name.startswith('config.next-'):raise OSError('simulated config persistence error')
                return original_replace(path,target)
            def stat(path,**kwargs):
                result=actual_stat(path,**kwargs)
                if path in (paths['/var/lib/cc-host-updater'],paths['/opt/cc-host-updater']):return SimpleNamespace(st_uid=0,st_mode=result.st_mode&~0o022)
                return result
            with patch.object(installer,'sync_directory',side_effect=sync),patch.object(installer,'exchange_program',side_effect=exchange),patch.object(installer,'enrollment_lock',return_value=nullcontext()),patch.object(installer,'Path',side_effect=lambda value:paths.get(str(value),Path(value))),patch.object(installer.os,'geteuid',create=True,return_value=0),patch.object(installer.socket,'gethostname',return_value='ubuntu-cc'),patch.object(installer.subprocess,'run',side_effect=run),patch.object(installer.urllib.request,'build_opener',return_value=SimpleNamespace(open=lambda *a,**k:Response())),patch.object(Path,'stat',stat),patch.object(Path,'replace',replace):
                with self.assertRaisesRegex(RuntimeError,'reenrollment required' if credential_failure else 'previous program restored'):
                    installer.install('ubuntu-cc','x'*43,{'origin':'https://example.invalid','keys':{},'files':{'agent.py':base64.b64encode(b'print("new")').decode()}})
            self.assertEqual(agent.read_text(),'old program')
            self.assertEqual(json.loads(config.read_text())['token'],'old' if credential_failure else 'n'*43)
            self.assertEqual(paths['/etc/systemd/system/cc-host-updater.service'].read_text(),'old unit')
            self.assertEqual(['systemctl','start','cc-host-updater.service'] in commands,not credential_failure)

    def test_rejected_reenrollment_preserves_old_files_and_restarts_old_agent(self):
        self.enrollment_failure_case(False)

    def test_lost_enrollment_response_requires_reenrollment_instead_of_claiming_recovery(self):
        self.enrollment_failure_case(True)

    def test_existing_inactive_unit_with_failed_stop_cannot_consume_enrollment(self):
        self.enrollment_failure_case(False,stop_fails=True)

    def test_rejected_enrollment_reports_old_agent_restart_failure(self):
        self.enrollment_failure_case(False,restart_fails=True)

    def enrollment_failure_case(self,transport_error,stop_fails=False,restart_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            paths={'/var/lib/cc-host-updater':root/'state','/opt/cc-host-updater':root/'program','/etc/systemd/system/cc-host-updater.service':root/'unit.service'}
            for key in ('/var/lib/cc-host-updater','/opt/cc-host-updater'):paths[key].mkdir()
            config=paths['/var/lib/cc-host-updater']/'config.json';config.write_text('old credentials')
            agent=paths['/opt/cc-host-updater']/'agent.py';agent.write_text('old program')
            paths['/etc/systemd/system/cc-host-updater.service'].write_text('old unit')
            commands=[]
            def run(args,**kwargs):
                commands.append(args)
                if stop_fails and args[1]=='is-active':return SimpleNamespace(returncode=3)
                if stop_fails and args[1]=='stop':return SimpleNamespace(returncode=1)
                if restart_fails and args[1]=='start':return SimpleNamespace(returncode=1)
                return SimpleNamespace(returncode=0)
            error=urllib.error.URLError('response lost') if transport_error else urllib.error.HTTPError('https://example.invalid',401,'rejected',{},None)
            attempted=[]
            def enroll(*args,**kwargs):attempted.append(True);raise error
            with patch.object(installer,'exchange_program',side_effect=self.exchange_fixture),patch.object(installer,'enrollment_lock',return_value=nullcontext()),patch.object(installer,'Path',side_effect=lambda value:paths.get(str(value),Path(value))),patch.object(installer.os,'geteuid',create=True,return_value=0),patch.object(installer.socket,'gethostname',return_value='ubuntu-cc'),patch.object(installer.subprocess,'run',side_effect=run),patch.object(installer.urllib.request,'build_opener',return_value=SimpleNamespace(open=enroll)):
                # Non-root development files are accepted here only through a fixture metadata view.
                original_stat=Path.stat
                def stat(path,**kwargs):
                    result=original_stat(path,**kwargs)
                    if path in paths.values():return SimpleNamespace(st_uid=0,st_mode=result.st_mode&~0o022)
                    return result
                with patch.object(Path,'stat',stat):
                    if stop_fails or restart_fails:
                        with self.assertRaisesRegex(RuntimeError,'Could not stop' if stop_fails else 'restart failed'):
                            installer.install('ubuntu-cc','x'*43,{'origin':'https://example.invalid','keys':{},'files':{}})
                    elif transport_error:
                        with self.assertRaisesRegex(RuntimeError,'outcome unknown.*reenrollment required'):
                            installer.install('ubuntu-cc','x'*43,{'origin':'https://example.invalid','keys':{},'files':{}})
                    else:
                        with self.assertRaises(urllib.error.HTTPError):
                            installer.install('ubuntu-cc','x'*43,{'origin':'https://example.invalid','keys':{},'files':{}})
            if isinstance(error,urllib.error.HTTPError):error.close()
            self.assertEqual(config.read_text(),'old credentials')
            self.assertEqual(agent.read_text(),'old program')
            self.assertEqual(['systemctl','start','cc-host-updater.service'] in commands,not stop_fails)
            self.assertEqual(bool(attempted),not stop_fails)


if __name__=='__main__':unittest.main()
