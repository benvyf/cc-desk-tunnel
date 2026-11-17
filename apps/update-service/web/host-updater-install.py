#!/usr/bin/env python3
"""One-time root host-channel enrollment; never queues or runs an application update."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import zlib
from contextlib import contextmanager

BUNDLE = '__HOST_BUNDLE__'


def sync_directory(path):
    if os.name == 'posix':
        descriptor=os.open(path,os.O_RDONLY)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)


def write_staged(path,content,mode):
    with path.open('xb') as stream:
        os.chmod(path,mode);stream.write(content);stream.flush();os.fsync(stream.fileno())
    sync_directory(path.parent)


@contextmanager
def enrollment_lock(root):
    import fcntl
    descriptor=os.open(root/'enrollment.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    info=os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        os.close(descriptor);raise ValueError('Invalid enrollment lock destination')
    with os.fdopen(descriptor,'w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Another host channel enrollment is running; no enrollment requested')
        yield


@contextmanager
def trusted_runtime(bundle):
    # Every executable byte comes from this outer hash-pinned installer. Never
    # import candidate or preexisting stable helpers to authenticate enrollment.
    import hashlib
    import importlib.util
    names={'host-platform.py','host-platform-entry.py','host-bootstrap.py','host-bootstrap-entry.py','host-operations.py'}
    if set(bundle['sources'])!=names or set(bundle['hashes'])!=names:raise ValueError('Incomplete trusted bootstrap source')
    sources={name:base64.b64decode(raw,validate=True) for name,raw in bundle['sources'].items()}
    for name,raw in sources.items():
        if len(raw)>512*1024 or hashlib.sha256(raw).hexdigest()!=bundle['hashes'][name]:raise ValueError('Trusted source digest mismatch')
        compile(raw,name,'exec',dont_inherit=True)
    with tempfile.TemporaryDirectory(prefix='cc-host-trusted-') as temporary:
        directory=Path(temporary)
        for name,raw in sources.items():write_staged(directory/name,raw,0o600)
        def load(name):
            spec=importlib.util.spec_from_file_location(name.replace('-','_'),directory/(name+'.py'))
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        core=load('host-platform');bootstrap=load('host-bootstrap');entry=load('host-bootstrap-entry')
        bootstrap.validate_sources(sources,bundle['hashes'],bundle['keys'])
        yield core,bootstrap,entry,sources


def download(url,limit,data=None):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    request=urllib.request.Request(url,data=data,headers={'Content-Type':'application/json'} if data is not None else {})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response:raw=response.read(limit+1)
    if len(raw)>limit:raise ValueError('Management response too large')
    return raw


def validate_file_destination(core,path):
    if path.exists() or path.is_symlink():
        core._protect(path)
        if not stat.S_ISREG(path.lstat().st_mode):raise ValueError('Invalid fixed file destination')


def validate_artifact_destination(core,program,candidate):
    sha=candidate.get('sha256')
    if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha) or not core._positive(candidate.get('version')):raise ValueError('Invalid existing artifact identity')
    root=program/'versions'/sha;core._protect(root,True)
    manifest_path=root/'manifest.json';validate_file_destination(core,manifest_path)
    if manifest_path.lstat().st_size>128*1024:raise ValueError('Existing artifact manifest too large')
    with manifest_path.open('rb') as stream:raw=stream.read(128*1024+1)
    if len(raw)>128*1024:raise ValueError('Existing artifact manifest too large')
    manifest=core._json(raw);core._inventory(manifest)
    if manifest['archive']['sha256']!=sha:raise ValueError('Existing artifact manifest identity mismatch')
    # Validate every declared path and size before the core reads any code.
    # Its inventory validator has already bounded count, sizes and code paths.
    for name,record in manifest['files'].items():
        path=root/name
        for parent in path.parents:
            if parent==root:break
            core._protect(parent,True)
        validate_file_destination(core,path)
        if path.lstat().st_size!=record['size']:raise ValueError('Existing artifact file size mismatch')
    return core._version_files(program,candidate)


def install_platform(node,code,bundle,data,program,units,legacy,manager=None,fetch=download,healthy=None,*,fresh_token=None):
    with trusted_runtime(bundle) as (core,bootstrap,entry,sources):
        manager=manager or entry.service
        # Read-only layout checks: none of these destinations may be created,
        # chmodded, or repaired merely to discover that enrollment is impossible.
        for path in (program,program/'versions',program/'.bootstrap-stage',data,data/'agent-platform',data/'jobs',units):
            if path.exists() or path.is_symlink():core._protect(path,True)
        destinations=[data/name for name in ('config.json','state.json','operation.lock','enrollment.lock','agent-health.json','worker-state.json')]
        destinations.extend(data/'agent-platform'/name for name in ('state.json','lock','initial-unit.json','prior-unit','support-setup.json'))
        source_names=set(sources)|{'trusted-keys.json','source-hashes.json'}
        destinations.extend(program/name for name in source_names|{'server-upgrade.cjs','probe-sha256'})
        destinations.extend(program/'.bootstrap-stage'/name for name in source_names)
        destinations.extend(units/name for name in bootstrap.fixed_units())
        for path in destinations:validate_file_destination(core,path)
        if fresh_token is not None:
            if not re.fullmatch('[A-Za-z0-9_-]{43}',fresh_token):raise ValueError('Invalid fresh host token')
            config_path=data/'config.json'
            if config_path.exists():
                configured=core._json(config_path.read_bytes())
                if configured!={'nodeId':node,'origin':bundle['origin'],'keys':bundle['keys'],'token':fresh_token}:
                    raise ValueError('Fresh host configuration belongs to another installation')
                transaction=data/'agent-platform'/'initial-unit.json'
                if transaction.exists():
                    tx=entry.read_json(transaction)
                    if tx.get('mode')=='fresh' and tx.get('phase')=='committed' and tx.get('configSha256')==core._digest(config_path.read_bytes()) and entry.committed(core._state(data),tx['candidate']):
                        print('HOST_CHANNEL_READY: '+node+'; fresh initial commit resumed.');return
        outcome=bootstrap.preflight(core,program,data,units,legacy,manager)
        if outcome=='resumed':
            print('HOST_CHANNEL_READY: '+node+'; initial enrollment commit resumed.');return
        if outcome!='initial':raise RuntimeError('Host platform is already installed; use its normal update action without re-enrollment')
        platform=core._state(data)
        if platform.get('phase') not in ('steady','staged') or platform.get('previous') is not None:raise ValueError('Initial platform state requires recovery')
        pending=platform.get('candidate')
        if pending is not None:
            if not isinstance(pending,dict) or set(pending)!=set(core.PROOF_FIELDS) or pending['nodeId']!=node or any(not isinstance(pending[key],str) or not pending[key] for key in ('instanceId','nonce')):raise ValueError('Invalid staged platform identity')
            validate_artifact_destination(core,program,pending)
        legacy_state=data/'state.json'
        if legacy_state.exists():
            core._protect(legacy_state)
            if core._json(legacy_state.read_bytes()).get('report',{}).get('state')=='running':raise RuntimeError('An update is in progress or was interrupted; inspect its log before replacing the channel')
        # Validate all downloads, executable files and destinations BEFORE redeem.
        envelope=core._json(fetch(bundle['origin']+'/cc-host/v2/agent-index.json',131072))
        manifest=core._json(core._b64(envelope['payload']))
        sha=manifest.get('archive',{}).get('sha256')
        if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha):raise ValueError('Invalid signed agent archive identity')
        archive=fetch(bundle['origin']+'/cc-host/v2/agent-artifacts/'+sha+'.tar.gz',core.MAX_ARCHIVE)
        manifest,files=bootstrap.validate_worker(core,envelope,archive,bundle['keys'])
        artifact=program/'versions'/manifest['archive']['sha256']
        if artifact.exists() or artifact.is_symlink():
            _,installed=validate_artifact_destination(core,program,{'version':manifest['version'],'sha256':manifest['archive']['sha256']})
            if installed['files']!=manifest['files']:raise ValueError('Existing artifact inventory mismatch')
        probe=base64.b64decode(bundle['probe'],validate=True)
        if len(probe)>128*1024 or core._digest(probe)!=bundle['probeSha256'] or b'const fs = require(' not in probe or b'if (target.probe)' not in probe:raise ValueError('Invalid trusted fixed probe')
        fixed=dict(sources,**{'trusted-keys.json':core._canonical(bundle['keys']),'source-hashes.json':core._canonical(bundle['hashes']),'server-upgrade.cjs':probe,'probe-sha256':bundle['probeSha256'].encode()})
        for name,raw in fixed.items():
            path=program/name
            if path.exists() or path.is_symlink():
                core._protect(path)
                if path.read_bytes()!=raw:raise ValueError('Existing stable source differs')
        for name,raw in bootstrap.fixed_units().items():
            path=units/name
            if name!='cc-host-updater.service' and path.exists() and path.read_bytes()!=raw:raise ValueError('Existing support unit differs')
        previous=manager('inspect')
        previous_unit=(units/'cc-host-updater.service').read_bytes() if (units/'cc-host-updater.service').exists() else None
        previous_program=entry.program_identity(legacy) if legacy.exists() else None
        core._directory(data)
        if (data/'config.json').exists():core._protect(data/'config.json')
        bootstrap.stage_sources(core,program,data,sources,bundle['hashes'],bundle['keys'])
        # Reserve and sync the credential file while the old channel is untouched.
        config={'nodeId':node,'origin':bundle['origin'],'keys':bundle['keys'],'token':'x'*43}
        next_config=data/('config.next-'+os.urandom(12).hex());reserved=json.dumps(config).encode()
        write_staged(next_config,reserved,0o600)
        try:
            enrolled={'token':fresh_token} if fresh_token is not None else core._json(fetch(bundle['origin']+'/cc-host/v1/enroll',4096,json.dumps({'nodeId':node,'code':code}).encode()))
            if set(enrolled)!={'token'} or not re.fullmatch('[A-Za-z0-9_-]{43}',enrolled.get('token','')):raise ValueError('Invalid enrollment response')
        except urllib.error.HTTPError as error:
            if 400<=error.code<500:raise
            raise RuntimeError('Enrollment outcome unknown; previous program and config retained; reenrollment required') from error
        except Exception as error:
            raise RuntimeError('Enrollment outcome unknown; previous program and config retained; reenrollment required') from error
        adopted=False;activation=False
        try:
            config['token']=enrolled['token'];raw=json.dumps(config).encode()
            if len(raw)!=len(reserved):raise ValueError('Credential reservation length changed')
            with next_config.open('r+b') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
            next_config.replace(data/'config.json');adopted=True;sync_directory(data)
            bootstrap.publish_sources(core,program,data)
            bootstrap.stage_probe(core,program,probe,bundle['probeSha256'])
            bootstrap.install_support_units(core,units,data)
            support=data/'agent-platform'/'support-setup.json'
            for action in ('reload','enable-recovery','enable-adoption'):
                core._write(support,core._canonical({'schema':1,'phase':action}))
                if action=='reload':manager('reload')
                else:
                    unit='cc-host-recovery.service' if action=='enable-recovery' else 'cc-host-adoption.timer'
                    subprocess.run(['systemctl','enable',unit],check=True,timeout=30)
            core._write(support,core._canonical({'schema':1,'phase':'enabled'}))
            bootstrap.ensure_recovery(manager)
            # No old service stop occurs until the new credential and complete
            # recoverable initial intent are durably recorded.
            if manager('inspect')!=previous or ((units/'cc-host-updater.service').read_bytes() if (units/'cc-host-updater.service').exists() else None)!=previous_unit or (entry.program_identity(legacy) if legacy.exists() else None)!=previous_program:raise ValueError('Old channel changed during enrollment')
            candidate=core.stage_bundle(program,data,manifest,files)
            bootstrap.prepare_initial(core,program,data,units,legacy,candidate,'fresh' if fresh_token is not None else 'enroll',manager)
            activation=True
            bootstrap.activate_initial(core,program,data,units,legacy,candidate,manager,healthy or (lambda current:core.wait_healthy(data,current)))
        except Exception as error:
            if not adopted:raise RuntimeError('Enrollment grant consumed but credential persistence failed; reenrollment required; original program retained') from error
            if activation:
                # The audited initial core owns exact unit/enablement/activity
                # rollback. Never replace its journal or restore a revoked token.
                tx=entry.read_json(data/'agent-platform'/'initial-unit.json')
                if tx.get('phase')!='rolled-back':raise RuntimeError('Host platform setup failed; recovery requires inspection; newly enrolled credential retained') from error
            else:
                # Before activation there were no updater unit/program mutations.
                # Restart only the previous active process to reload its new token.
                if manager('inspect')!=previous or ((units/'cc-host-updater.service').read_bytes() if (units/'cc-host-updater.service').exists() else None)!=previous_unit or (entry.program_identity(legacy) if legacy.exists() else None)!=previous_program:raise RuntimeError('Old channel changed; recovery requires inspection; newly enrolled credential retained') from error
                if previous['active']:
                    try:manager('stop');manager('start')
                    except Exception as restart_error:raise RuntimeError('Old channel restart failed; newly enrolled credential retained') from restart_error
            raise RuntimeError('Host platform setup failed; previous program restored using the newly enrolled credential') from error
    print('HOST_CHANNEL_READY: '+node+'; full signed host platform installed; no application upgrade requested.')


def install(node, code, bundle):
    if sys.platform!='linux' or os.geteuid()!=0 or sys.version_info < (3,12):raise RuntimeError('Use sudo on Ubuntu 24.04 with Python 3.12 or newer')
    if not re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}',node) or socket.gethostname().split('.')[0]!=node:raise RuntimeError('Run the command on its matching Ubuntu host')
    if not re.fullmatch('[A-Za-z0-9_-]{43}',code):raise RuntimeError('Invalid enrollment code')
    root=Path('/var/lib/cc-host-updater')
    if root.is_symlink():raise RuntimeError('Unexpected updater directory link')
    root.mkdir(mode=0o700,exist_ok=True)
    info=root.stat()
    if info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Updater directories must be protected and root-owned')
    with enrollment_lock(root):install_platform(node,code,bundle,root,Path('/opt/cc-host-platform'),Path('/etc/systemd/system'),Path('/opt/cc-host-updater'))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node',required=True);parser.add_argument('--code',required=True);args=parser.parse_args()
    try:install(args.node,args.code,json.loads(zlib.decompress(base64.b64decode(BUNDLE))))
    except Exception as error:
        reason='Management HTTP '+str(error.code)+'; generate a new enrollment command' if isinstance(error,urllib.error.HTTPError) else str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('Host channel enrollment stopped: '+reason+'. No application update was requested.',file=sys.stderr)
        raise SystemExit(1)
