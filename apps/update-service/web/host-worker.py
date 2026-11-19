#!/usr/bin/env python3
"""Once-enrolled v2 host worker. Jobs select signed targets, never commands or paths."""
import datetime
import hashlib
import base64
import importlib.util
import json
import os
import stat
from pathlib import Path
import random
import re
import signal
import subprocess
import sys
import tempfile
import time
import threading
import urllib.parse
import urllib.request
import uuid

ROOT=Path('/var/lib/cc-host-updater')
PROGRAM=Path(__file__).resolve().parent
STABLE=Path('/opt/cc-host-platform/host-platform.py')
TERMINAL={'succeeded','failed','maintenance-required'}
stopping=False


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def sibling(installed,source):
    path=PROGRAM/installed
    return path if path.exists() else PROGRAM/source


ops=load('cc_host_operations',sibling('operations.py','host-operations.py'))


class ConfirmationExpired(RuntimeError):
    pass


class ApplicationBusy(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def request(config,path,value=None,limit=131072):
    origin=urllib.parse.urlsplit(config['origin'])
    if origin.scheme!='https' or not origin.netloc or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment:
        raise RuntimeError('Host center requires a bare authenticated HTTPS origin')
    if not path.startswith('/') or path.startswith('//'):raise RuntimeError('Invalid fixed request path')
    data=json.dumps(value,separators=(',',':')).encode() if value is not None else None
    req=urllib.request.Request(config['origin'].rstrip('/')+path,data=data,headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
    with urllib.request.build_opener(NoRedirect).open(req,timeout=15) as response:
        if not 200<=response.status<300:raise RuntimeError('Center rejected heartbeat')
        raw=response.read(limit+1)
    if len(raw)>limit:raise RuntimeError('Response exceeded worker limit')
    return json.loads(raw) if value is not None else raw


def atomic(path,data):
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream:
            os.chmod(name,0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        if os.name=='posix':
            directory=os.open(path.parent,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
    finally:
        if os.path.exists(name):os.unlink(name)


def save(path,value):atomic(path,json.dumps(value,separators=(',',':')).encode())


def timestamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()


def date(value):
    parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise RuntimeError('Confirmation requires timezone')
    return parsed.timestamp()


class Worker:
    def __init__(self,config,root=ROOT,identity=None,agent=None):
        self.config=config;self.root=root;self.state_path=root/'worker-state.json'
        self.identity=identity or dict(version=int(os.environ['CC_HOST_AGENT_VERSION']),sha256=os.environ['CC_HOST_AGENT_SHA256'],instanceId=os.environ['CC_HOST_AGENT_INSTANCE_ID'],nonce=os.environ['CC_HOST_PLATFORM_NONCE'])
        self.agent=agent or load('cc_host_app_agent',sibling('agent.py','host-updater-agent.py'))
        if agent is None:self.agent.PROGRAM=PROGRAM
        self.agent.NODE_ID=config['nodeId']
        self.transport=request
        relay_path=PROGRAM/'relay-agent.py'
        self.relay=load('cc_host_worker_relay',relay_path) if agent is None and relay_path.exists() else None
        self.log_retention_next=0;self.log_scan=None;self.log_scan_identity=None
        self.relay_next=0
        self.pending_inventory=None;self.pending_inventory_error=None;self.inventory_thread=None;self.inventory_next=0
        root.mkdir(mode=0o700,exist_ok=True);(root/'jobs').mkdir(mode=0o700,exist_ok=True)
        self.state=json.loads(self.state_path.read_text()) if self.state_path.exists() else {'floor':0}
        self.probe_lock=threading.Lock()
        self.probe_quiet=self.state.get('phase') not in (None,'terminal','accepted','waiting','agent-committed','agent-handoff','agent-confirmation')

    def save(self):save(self.state_path,self.state)

    def report(self,identity,stage,state,message,log=''):
        self.state['reportSeq']=self.state.get('reportSeq',0)+1
        self.state['report']={'id':identity,'seq':self.state['reportSeq'],'stage':stage,'state':state,'message':ops.redact(message,[self.config['token']])[:1000],'log':ops.redact(log,[self.config['token']])[-6000:]}
        self.save()

    def retain_logs(self,now=None):
        """Expire only private UUID job logs after 30 days; never recovery artifacts.

        Hourly, at most 1,000 directory entries / 50 removals per pass. Keep the
        directory cursor so protected entries cannot starve a large directory.
        The serial worker loop calls this only between children, after heartbeat.
        """
        now=time.time() if now is None else now
        if now<self.log_retention_next:return
        self.log_retention_next=now+3600
        if self.probe_quiet or self.state.get('phase') not in (None,'terminal','accepted','waiting','agent-committed'):return
        identity=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')
        def private(info,directory=False):
            if info.st_uid!=0 or info.st_mode&0o077 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1):raise RuntimeError('Unprotected retention input')
        def references(value,keep,depth=0):
            if depth>24:raise ValueError('Unbounded retention metadata')
            if isinstance(value,str):
                if identity.fullmatch(value):
                    keep.add(value)
                    if len(keep)>10000:raise ValueError('Unbounded retention references')
            elif isinstance(value,dict):
                for key,item in value.items():
                    # Durable anti-replay tombstones do not denote active logs.
                    if key!='ownedJobs':references(item,keep,depth+1)
            elif isinstance(value,list):
                for item in value:references(item,keep,depth+1)
        try:
            private(self.root.lstat(),True)
            with ops.operation_lock(self.root):
                keep=set();references(self.state,keep)
                fixed={'worker-state.json':None,'state.json':None,
                    'agent-platform/state.json':{'steady'},
                    'agent-platform/initial-unit.json':{'committed','rolled-back'},
                    'agent-platform/adoption.json':{'committed','adopted','failed','maintenance-required'},
                    'agent-platform/original-app.json':None,
                    'agent-platform/image-transaction.json':None,
                    'agent-platform/failed-worker-state.json':None,
                    'agent-platform/support-setup.json':{'published','ready'}}
                budget=4*1024*1024
                def metadata(path):
                    nonlocal budget
                    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                    try:
                        info=os.fstat(fd);private(info)
                        if info.st_size>min(1024*1024,budget):raise ValueError('Unbounded retention metadata')
                        with os.fdopen(fd,'rb',closefd=False) as stream:raw=stream.read(min(1024*1024,budget)+1)
                    finally:os.close(fd)
                    budget-=len(raw)
                    if budget<0 or len(raw)>1024*1024:raise ValueError('Unbounded retention metadata')
                    value=json.loads(raw)
                    if not isinstance(value,dict) or not value:raise ValueError('Unknown retention metadata')
                    references(value,keep)
                    return value,raw
                historical=[]
                platform=self.root/'agent-platform'
                if os.path.lexists(platform):
                    private(platform.lstat(),True)
                    with os.scandir(platform) as entries:
                        for count,entry in enumerate(entries):
                            if count>=256:raise ValueError('Unbounded platform metadata')
                            match=re.fullmatch(r'(adoption|original-app|image-transaction)\.previous-([a-f0-9]{16})\.json',entry.name)
                            if match:
                                value,raw=metadata(platform/entry.name)
                                historical.append(('agent-platform/'+match[1]+'.json',value))
                                if hashlib.sha256(raw).hexdigest()[:16]!=match[2]:raise ValueError('Changed historical metadata')
                            elif entry.name.endswith('.json') and 'agent-platform/'+entry.name not in fixed:
                                raise ValueError('Unknown platform metadata')
                # Recovery records are only read from the established runtime root,
                # with the runner's exact backup name contract, never from supplied paths.
                backups=set()
                if os.path.lexists(ops.RUNTIME):
                    ops.protected(ops.RUNTIME,True)
                    with os.scandir(ops.RUNTIME) as entries:
                        for count,entry in enumerate(entries):
                            if count>=256:raise ValueError('Unbounded recovery directory')
                            if not entry.name.startswith('backup-'):continue
                            if not re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}',entry.name):raise ValueError('Unknown recovery directory')
                            path=ops.RUNTIME/entry.name;ops.protected(path,True)
                            record,_=metadata(path/'record.json')
                            if record.get('backup')!=str(path) or type(record.get('dataChanged')) is not bool:return
                            if record.get('phase') not in ('installed','rolled-back','prepared') or (record.get('phase')=='prepared' and record.get('dataChanged') is not False):return
                            backups.add(str(path))
                def validate_metadata(name,value):
                    if name.startswith('agent-platform/') and name not in ('agent-platform/state.json','agent-platform/failed-worker-state.json') and (type(value.get('schema')) is not int or value['schema']!=1):raise ValueError('Unknown retention metadata')
                    if name in ('agent-platform/original-app.json','agent-platform/adoption.json','agent-platform/image-transaction.json') and not identity.fullmatch(str(value.get('appJobId',''))):raise ValueError('Unknown retention metadata')
                    if name=='agent-platform/state.json' and not {'phase','current','previous','candidate','floor'}<=set(value):raise ValueError('Unknown retention metadata')
                    if name in ('worker-state.json','state.json','agent-platform/failed-worker-state.json') and (type(value.get('floor')) is not int or value['floor']<0):raise ValueError('Unknown retention metadata')
                    phases=fixed[name]
                    if phases is not None and value.get('phase') not in phases:raise ValueError('Unknown retention metadata')
                    if name=='agent-platform/image-transaction.json' and (value.get('schema')!=1 or value.get('backup') not in backups):raise ValueError('Unknown retention metadata')
                    if name in ('worker-state.json','agent-platform/failed-worker-state.json') and value.get('phase') not in (None,'terminal','accepted','waiting','agent-committed'):raise ValueError('Unknown retention metadata')
                    if name=='state.json' and value.get('report',{}).get('state') not in (None,'succeeded','failed'):raise ValueError('Unknown retention metadata')
                for name,value in historical:validate_metadata(name,value)
                for name in fixed:
                    path=self.root/name
                    if not os.path.lexists(path):continue
                    value,_=metadata(path)
                    validate_metadata(name,value)
                fd=os.open(self.root/'jobs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:
                    info=os.fstat(fd);private(info,True);key=(info.st_dev,info.st_ino)
                    if self.log_scan is not None and self.log_scan_identity!=key:self.log_scan.close();self.log_scan=None
                    if self.log_scan is None:self.log_scan=os.scandir(fd);self.log_scan_identity=key
                    removed=0
                    for _ in range(1000):
                        entry=next(self.log_scan,None)
                        if entry is None:self.log_scan.close();self.log_scan=None;break
                        name=entry.name
                        if not name.endswith('.log') or not identity.fullmatch(name[:-4]) or name[:-4] in keep:continue
                        try:
                            before=os.stat(name,dir_fd=fd,follow_symlinks=False);private(before)
                            if before.st_mtime>=now-30*86400:continue
                            after=os.stat(name,dir_fd=fd,follow_symlinks=False)
                            if before!=after:continue
                            os.unlink(name,dir_fd=fd);removed+=1
                        except (OSError,ValueError,RuntimeError):continue
                        if removed>=50:break
                finally:os.close(fd)
        except (OSError,ValueError,RuntimeError,TypeError,AttributeError):
            # Unknown/linked/unsettled inputs fail closed, never heartbeat failure.
            return

    def app(self,owned_fd=None):
        # The runner pauses the container and rejects unknown Node processes.
        # Drain every background docker-exec probe before spawning it; never let
        # heartbeat or inventory inject another probe while it owns the container.
        with self.probe_lock:
            if self.probe_quiet:return None
            try:
                with ops.probe_gate(self.root,owned_fd):return self.agent.probe()
            except Exception:return None

    def inventory_record(self,snapshot,app,unfinished):
        current=(app or {}).get('current') or {}
        bounded=lambda value,limit: value[:limit] if isinstance(value,str) else None
        return {'schema':1,'observedAt':timestamp(),
            'os':{'id':bounded(snapshot['os_id'],64),'version':bounded(snapshot['os_version'],64),'arch':bounded(snapshot['arch'],32)},
            'docker':{'available':snapshot['docker'],'version':bounded(snapshot.get('docker_version'),120),'buildkitVersion':bounded(snapshot.get('buildkit_version'),160),'storageDriver':bounded(snapshot.get('storage_driver'),120),'root':bounded(snapshot.get('docker_root'),256)},
            'storage':{'rootRw':snapshot['root_rw'],'freeBytes':snapshot['free_bytes'],'freeInodes':snapshot['free_inodes'],'sameFilesystem':snapshot['storage_same']},
            'kernel':{'status':'errors' if snapshot['kernel'].strip() and snapshot['kernel'].strip()!='-- No entries --' else 'clear'},
            'app':{'managementAvailable':app is not None,'descriptorSha256':bounded((app or {}).get('descriptorSha256'),64),'phase':bounded((app or {}).get('phase'),64),'build':current.get('build') if type(current.get('build')) is int else None,'protocol':current.get('protocol') if type(current.get('protocol')) is int else None},
            'recovery':{'eligible':not unfinished,'unfinishedCount':min(len(unfinished),10000)}}

    def refresh_inventory(self):
        if (self.inventory_thread and self.inventory_thread.is_alive()) or time.monotonic()<self.inventory_next:return
        self.inventory_next=time.monotonic()+60
        def collect():
            try:self.pending_inventory=self.inventory_record(ops.host_snapshot(),self.app(),ops.recovery_records())
            except Exception as error:self.pending_inventory_error={'at':timestamp(),'reason':type(error).__name__[:80]}
        self.inventory_thread=threading.Thread(target=collect,daemon=True);self.inventory_thread.start()

    def poll(self):
        if self.pending_inventory is not None:
            self.state['inventory']=self.pending_inventory;self.pending_inventory=None;self.state.pop('inventoryError',None);self.save()
        if self.pending_inventory_error is not None:
            self.state['inventoryError']=self.pending_inventory_error;self.pending_inventory_error=None;self.save()
        sent=self.state.get('report')
        payload={'nodeId':self.config['nodeId'],'instanceId':self.identity['instanceId'],'agent':{k:self.identity[k] for k in ('version','sha256')},'app':self.app(),'capabilities':{'hostWorker':2,'platformCommitted':self.registration_committed(),'automaticBuildkit':True,'signedImageRunner':True,'inventory':self.state.get('inventory'),'inventoryError':self.state.get('inventoryError')},'report':sent}
        response=self.transport(self.config,'/cc-host/v2/poll',payload)
        if not isinstance(response,dict) or set(response)!={'job','acknowledged'} or (response['job'] is not None and not isinstance(response['job'],dict)) or (response['acknowledged'] is not None and not isinstance(response['acknowledged'],str)):
            raise RuntimeError('Unknown heartbeat response; no acceptance proof')
        self.last_acknowledged=response['acknowledged']
        save(self.root/'agent-health.json',{'nodeId':self.config['nodeId'],**self.identity,'at':timestamp()})
        if sent and response['acknowledged']==sent['id'] and sent['state'] in TERMINAL:
            self.state.pop('report',None);self.save()
        return response['job']

    def authorize_handoff(self,job):
        approved=self.poll()
        fields={'id','nodeId','build','sha256','index','agentIndex','createdAt','expiresAt'}
        if (not isinstance(approved,dict) or set(approved)-fields-{'instanceId'} or not fields<=set(approved)
            or self.last_acknowledged!=job['id'] or any(approved[key]!=job.get(key) for key in fields)
            or approved.get('instanceId',self.identity['instanceId'])!=self.identity['instanceId']):
            raise RuntimeError('Center did not authorize this exact agent handoff')

    def accept(self,job):
        identity=job.get('id')
        if not isinstance(identity,str) or not re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',identity) or str(uuid.UUID(identity))!=identity:raise RuntimeError('Invalid job identity')
        if identity==self.state.get('lastJob') or identity in self.state.get('ownedJobs',[]):raise RuntimeError('Previously owned job cannot replay')
        if self.state.get('report') or self.state.get('phase') not in (None,'terminal'):raise RuntimeError('Previous job still owns worker')
        required={'id','nodeId','build','sha256','index','agentIndex','createdAt','expiresAt'}
        if not required<=set(job) or set(job)-required-{'instanceId'} or job['nodeId']!=self.config['nodeId'] or job.get('instanceId',self.identity['instanceId'])!=self.identity['instanceId']:raise RuntimeError('Invalid job ownership')
        now=time.time();created=date(job['createdAt']);expires=date(job['expiresAt'])
        if created>now or not 0<expires-created<=600:raise RuntimeError('Invalid update confirmation lifetime')
        if job['index'] is None:
            if job['build'] is not None or job['sha256'] is not None:raise RuntimeError('Partial app target')
        elif type(job['build']) is not int or job['build']<1 or not re.fullmatch('[a-f0-9]{64}',str(job['sha256'])):raise RuntimeError('Invalid app target')
        envelope=job['agentIndex']
        if (not isinstance(envelope,dict) or set(envelope)!={'payload','keyId','signature'}
            or not isinstance(envelope['payload'],str) or len(envelope['payload'])>128*1024 or not re.fullmatch('[A-Za-z0-9_-]+',envelope['payload'])
            or not isinstance(envelope['keyId'],str) or not re.fullmatch('[A-Za-z0-9_-]{1,64}',envelope['keyId'])
            or not isinstance(envelope['signature'],str) or not re.fullmatch('[A-Za-z0-9_-]{86}',envelope['signature'])):raise RuntimeError('Invalid agent target envelope')
        manifest=json.loads(base64.urlsafe_b64decode(envelope['payload']+'='*(-len(envelope['payload'])%4)))
        if (not isinstance(manifest,dict) or manifest.get('schema')!=1 or manifest.get('product')!='cc-host-agent' or manifest.get('platform')!='linux-x64'
            or type(manifest.get('version')) is not int or manifest['version']<1 or not isinstance(manifest.get('archive'),dict)
            or not re.fullmatch('[a-f0-9]{64}',str(manifest['archive'].get('sha256')))):raise RuntimeError('Invalid agent target identity')
        self.state.setdefault('ownedJobs',[]).append(identity)
        expired=now>=expires
        self.state.update(job=job,lastJob=identity,phase='terminal' if expired else 'accepted',ownerInstance=self.identity['instanceId'])
        self.state.pop('target',None);self.state.pop('agentTarget',None)
        self.report(identity,'agent','failed' if expired else 'queued','Confirmation expired before receipt; no operation started' if expired else 'Confirmed target saved before mutation')
        return not expired

    def reconcile(self):
        phase=self.state.get('phase');job=self.state.get('job')
        if not job or phase in (None,'terminal'):return
        identity=job['id']
        if phase in ('agent-handoff','agent-confirmation'):
            target=self.state.get('agentTarget')
            if target=={k:self.identity[k] for k in ('version','sha256')}:
                self.state['phase']='agent-confirmation'
                self.report(identity,'agent','waiting','Candidate heartbeat is active; awaiting durable platform health commit')
            elif phase=='agent-confirmation':
                self.state['phase']='terminal';self.report(identity,'agent','failed','Candidate activation did not commit before rollback; saved activation is not replayed')
            # The old instance may restart while a maintenance job is still
            # queued. Keep its handoff intent until the fixed unit is observed.
            return
        if phase in ('accepted','waiting','agent-committed'):
            if self.state.get('ownerInstance')!=self.identity['instanceId']:
                self.state['phase']='terminal';self.report(identity,'agent','failed','Saved workflow belongs to another agent instance; no activation or application operation replayed')
            return
        with self.probe_lock:self.probe_quiet=True
        try:
            # An orphan runner inherits this flock. Observe only after it has
            # exited, retaining the gate through the exact readiness probe.
            with ops.operation_lock(self.root):
                ready=False
                try:
                    if self.state.get('target'):ready=self.agent.target_ready(self.state['target'],require_serving=True)
                except Exception:pass
                self.state['phase']='terminal'
                if ready:self.state['floor']=max(self.state.get('floor',0),self.state['target']['build'])
                self.report(identity,'verify','succeeded' if ready else 'failed','Interrupted process target verified' if ready else 'Interrupted operation has no exact readiness proof; unknown cutover is never replayed')
        except BlockingIOError:
            self.report(identity,'verify','waiting','Interrupted runner still owns the shared gate; observing without application probes or replay')
            return
        finally:
            if self.state.get('phase')=='terminal':
                with self.probe_lock:self.probe_quiet=False

    def require_unexpired(self,job):
        if 'expiresAt' in job and time.time()>=date(job['expiresAt']):raise ConfirmationExpired('Update confirmation expired before another operation could start')

    def agent_target(self,job):
        # Only the immutable stable verifier authenticates candidate code.
        core=load('cc_stable_host_platform',STABLE)
        envelope=job['agentIndex']
        # The untrusted digest is syntax checked solely to choose a fixed bounded download.
        manifest=core._json(core._b64(envelope['payload']))
        sha=manifest.get('archive',{}).get('sha256')
        if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha):raise RuntimeError('Invalid agent archive digest')
        archive=request(self.config,'/cc-host/v2/agent-artifacts/'+sha+'.tar.gz',limit=core.MAX_ARCHIVE)
        keys_path=STABLE.parent/'trusted-keys.json';core._protect(keys_path)
        keys=core._json(keys_path.read_bytes())
        floor={k:self.identity[k] for k in ('version','sha256')}
        verified,_=core.verify_bundle(envelope,archive,keys,floor)
        target={'version':verified['version'],'sha256':verified['archive']['sha256']}
        self.state['agentTarget']=target;self.save()
        if target==floor:return False
        with ops.operation_lock(self.root):
            self.require_unexpired(job)
            self.state['phase']='agent-handoff';self.state['handoffAt']=time.time();self.report(job['id'],'agent','waiting','Signed agent verified; requesting exact independent activation authorization')
        self.authorize_handoff(job)
        with ops.operation_lock(self.root):
            self.require_unexpired(job)
            request_dir=self.root/'agent-platform'/'request';request_dir.mkdir(mode=0o700,parents=True,exist_ok=True)
            core._protect(request_dir,True)
            atomic(request_dir/'archive.tar.gz',archive);save(request_dir/'envelope.json',envelope)
        # Never stop or restart this worker from its own systemd cgroup.
        self.require_unexpired(job)
        subprocess.run(['systemctl','start','--no-block','cc-host-maintenance.service'],check=True,timeout=15)
        return True

    def observe_handoff(self):
        # This old process may still be alive if systemd rejected the start.
        # Never reschedule a cutover; observe only the fixed independent unit.
        if time.time()-self.state.get('handoffAt',time.time())<15:return
        try:
            properties=dict(line.split('=',1) for line in ops.output(['systemctl','show','cc-host-maintenance.service','--property=ActiveState','--property=Result','--property=Job']).splitlines() if '=' in line)
            if 'Job' not in properties:return
            queued_text=properties['Job'].strip()
            if queued_text:
                queued=re.match(r'^([0-9]+)(?:\s|$)',queued_text)
                if queued is None or int(queued[1])!=0:return
            if properties.get('ActiveState') not in ('inactive','failed'):return
            self.state['phase']='terminal';self.report(self.state['job']['id'],'agent','failed','Independent agent maintenance did not activate the signed target; saved request was not replayed')
        except (OSError,subprocess.SubprocessError):
            # An unavailable system manager cannot authorize replay or success.
            return

    def confirm_agent(self):
        try:
            if not self.platform_committed():return False
        except BlockingIOError:return False
        self.state['phase']='agent-committed';self.state['ownerInstance']=self.identity['instanceId']
        self.report(self.state['job']['id'],'agent','running','Stable platform committed the exact agent target; resuming saved workflow')
        return True

    def registration_committed(self):
        # A nonblocking gate proves Core finished its commit fsync/rollback. A
        # transient steady JSON while Core still owns the gate is not authority.
        try:
            with ops.operation_lock(self.root):
                path=self.root/'agent-platform'/'state.json'
                for directory in (self.root,path.parent):
                    metadata=directory.lstat()
                    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid!=0 or metadata.st_mode&0o022:return False
                descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
                with os.fdopen(descriptor,'rb') as stream:
                    metadata=os.fstat(stream.fileno())
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=0 or metadata.st_mode&0o077:return False
                    raw=stream.read(65537)
                if len(raw)>65536:return False
                state=json.loads(raw)
                candidate={'nodeId':self.config['nodeId'],**self.identity}
                target={k:self.identity[k] for k in ('version','sha256')}
                return state.get('phase')=='steady' and state.get('candidate') is None and state.get('floor')==target and state.get('current')==candidate
        except (OSError,ValueError,TypeError,AttributeError):return False

    def platform_committed(self):
        core=load('cc_stable_platform_readiness',STABLE)
        with ops.operation_lock(self.root):
            state=core._state(self.root)
            target={k:self.identity[k] for k in ('version','sha256')}
            current=state.get('current') or {}
            candidate={'nodeId':self.config['nodeId'],**self.identity}
            return state.get('phase')=='steady' and state.get('candidate') is None and state.get('floor')==target and current==candidate

    def prepare_command(self,job,work):
        try:return self.agent.command_for(self.config,job,work,self.state.get('floor',0))
        except RuntimeError as original:
            # A failed preparation is not idle. Only this exact observational
            # classifier permits a signed image runner to make its own decision.
            release=self.agent.verify_index(job['index'],self.config,work)
            status=self.agent.probe(release['protocol'])
            if (status.get('check') or {}).get('reason')=='busy':raise ApplicationBusy('Application activity or maintenance admission is busy; update will retry')
            diagnostic=status.get('hostDiagnostics') or {}
            if diagnostic.get('schema')!=1 or diagnostic.get('idle') is not True:raise original
            evidence={**status,'activity':diagnostic.get('activity')}
            journal=ops.read_journal(self.agent.container())
            receipt_path=self.root/'app-baseline.json';baseline=None
            if receipt_path.exists():
                ops.protected(receipt_path)
                if receipt_path.stat().st_size>4096:raise RuntimeError('Invalid trusted application baseline receipt')
                baseline=json.loads(receipt_path.read_text())
            if not ops.safe_failed_preparation(journal,evidence,ops.recovery_records(),baseline):raise original
            release=self.agent.verify_index(job['index'],self.config,work)
            if (release['build'],release['sha256'])!=(job['build'],job['sha256']) or release['build']<=status['current']['build'] or release['build']<self.state.get('floor',0):raise RuntimeError('Invalid signed image target')
            published=self.agent.verify_index(json.loads(self.agent.request(self.config,'/cc-updates/server/v1/channels/pilot/linux-x64.json',authenticated=False)),self.config,work)
            if published['sha256']!=release['sha256']:raise RuntimeError('Published target changed; refresh and confirm again')
            archive=self.agent.request(self.config,f"/cc-updates/server/v1/artifacts/{release['build']}/linux-x64/cc-desk-tunnel-server-{release['appVersion']}-build{release['build']}.tar.gz",authenticated=False,limit=64*1024**2)
            program=work/'program';self.agent.load_helper().unpack(archive,program,release)
            runner=program/'deploy/host-update/apply.py'
            if not runner.is_file():raise RuntimeError('Signed release has no supported image runner')
            save(work/'release.json',release)
            return [sys.executable,str(runner),'--release',str(work/'release.json'),'--install'],release

    def log(self,job,before=()):
        path=self.root/'jobs'/(job['id']+'.log')
        text=ops.tail(path) if path.exists() else ''
        nested=ops.nested_logs(text,job.get('build'),before,secrets=[self.config['token']])
        return ops.redact('Local job log: '+str(path)+'\n'+text[-1800:]+'\n'+nested,[self.config['token']])[-6000:]

    def monitor(self,args,job,stage,before=(),lock_fd=None):
        quiet=stage=='apply'
        self.application_child=None
        if quiet:
            with self.probe_lock:self.probe_quiet=True
        try:return self.monitor_child(args,job,stage,before,lock_fd)
        finally:
            if quiet and (self.application_child is None or self.application_child.poll() is not None):
                with self.probe_lock:self.probe_quiet=False

    def monitor_child(self,args,job,stage,before=(),lock_fd=None):
        self.require_unexpired(job)
        log=self.root/'jobs'/(job['id']+'.log')
        fd=os.open(log,os.O_WRONLY|os.O_APPEND|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(fd,'ab') as stream:
            poll_backoff=5;poll_next=0
            self.require_unexpired(job)
            dependency_env={'NEEDRESTART_MODE':'l','DEBIAN_FRONTEND':'noninteractive'} if stage=='dependencies' else {}
            if stage=='apply' and len(args)>1 and Path(args[1]).name=='apply.py' and Path(args[1]).parent.name=='host-update':
                args=[sys.executable,str(PROGRAM/'runtime-support/apply.py'),args[1],*args[2:]]
            child=subprocess.Popen(args,stdout=stream,stderr=subprocess.STDOUT,pass_fds=(lock_fd,) if lock_fd is not None else (),env={**os.environ,'DOCKER_BUILDKIT':'1',**dependency_env,**({'CC_HOST_OPERATION_LOCK_FD':str(lock_fd)} if lock_fd is not None else {})})
            if stage=='apply':self.application_child=child
            image_runner=stage=='apply' and len(args)>1 and Path(args[1]).name=='apply.py'
            observed_stage='prepare' if image_runner else stage
            while child.poll() is None:
                detail=self.log(job,before)
                if image_runner:observed_stage=ops.runner_stage(detail,observed_stage)
                self.report(job['id'],observed_stage,'running','Fixed signed operation is running',detail)
                if time.monotonic()>=poll_next:
                    try:self.poll();poll_backoff=5
                    except Exception:poll_backoff=min(300,poll_backoff*2)
                    poll_next=time.monotonic()+poll_backoff
                time.sleep(5)
            if child.returncode:raise RuntimeError('Fixed operation failed; original service recovery is described in the local logs')

    def execute(self):
        job=self.state['job'];identity=job['id']
        committed_agent=self.state.get('phase')=='agent-committed'
        try:
            if self.state.get('phase') in ('agent-handoff','agent-confirmation'):return
            if committed_agent:
                if job['index'] is None:
                    # This operation already completed under its original valid
                    # confirmation. Recheck identity only; do not authorize or
                    # download another operation after its expiry.
                    try:committed=self.platform_committed()
                    except BlockingIOError:
                        self.report(identity,'agent','waiting','Awaiting the shared gate to verify the completed agent target');return
                    if not committed:raise RuntimeError('Committed agent identity no longer matches the stable platform')
                    self.state['phase']='terminal';self.report(identity,'agent','succeeded','Exact signed agent target is durably committed');return
                self.report(identity,'preflight','running','Agent target is already committed; checking authorization for application work')
            self.require_unexpired(job)
            filesystem=ops.filesystem_snapshot()
            if not filesystem['root_rw'] or re.search(r'EXT4-fs (?:error|warning)|I/O error|Remounting filesystem read-only|Aborting journal',filesystem['kernel'],re.I):
                self.state['phase']='terminal';self.report(identity,'maintenance','maintenance-required','Filesystem errors or read-only root require administrator maintenance before any agent or application mutation',filesystem['kernel'][-3000:]);return
            self.report(identity,'agent','running','Verifying signed agent target')
            if self.agent_target(job):return
            if job['index'] is None:
                if not self.platform_committed():
                    self.state['phase']='waiting';self.report(identity,'agent','waiting','Awaiting stable platform health commit');return
                self.state['phase']='terminal';self.report(identity,'agent','succeeded','Exact signed agent target is running');return
            self.report(identity,'preflight','running','Checking host, application and recovery state')
            status=self.app()
            if status is None:raise RuntimeError('Application management unavailable; agent heartbeat remains active')
            diagnostic=status.get('hostDiagnostics') or {}
            if diagnostic.get('schema')==1 and diagnostic.get('idle') is False:
                self.state['phase']='waiting';self.report(identity,'preflight','waiting','Application activity is still active; update will resume when idle');return
            snapshot=ops.host_snapshot()
            result,message=ops.classify_host(snapshot)
            if result=='maintenance-required':
                self.state['phase']='terminal';self.report(identity,'maintenance','maintenance-required',message, '\n'.join(line for line in snapshot['kernel'].splitlines() if re.search(r'EXT4|I/O error|read-only|journal',line,re.I))[-3000:]);return
            if result=='failed':raise RuntimeError(message)
            with ops.operation_lock(self.root) as lock_fd:
                if ops.recovery_records():raise RuntimeError('Unfinished or unknown host recovery records; no operation requested')
                if result=='dependencies':
                    self.state['phase']='dependencies';self.report(identity,'dependencies','running','Validating exact Ubuntu BuildKit dependency transaction')
                    args=ops.buildkit_command()
                    self.monitor(args,job,'dependencies',lock_fd=lock_fd)
                    result,message=ops.classify_host(ops.host_snapshot())
                    if result!='ready':raise RuntimeError('Host checks still fail after dependency installation: '+message)
                with tempfile.TemporaryDirectory(prefix='v2-prepare-',dir=self.root) as directory:
                    self.report(identity,'prepare','running','Authenticating exact application target and preparing fixed operation')
                    before=ops.snapshot_workdirs();self.state['workdirsBefore']=sorted(before);self.save()
                    args,release=self.prepare_command(job,Path(directory))
                    self.state['target']={k:release[k] for k in ('build','protocol','sha256','descriptorSha256') if k in release}
                    # This persisted boundary precedes Popen; after a crash even an uncertain spawn is never repeated.
                    self.state['phase']='applying';self.report(identity,'prepare' if args and len(args)>1 and Path(args[1]).name=='apply.py' else 'apply','running','Starting signed operation; shared host gate held')
                    if args:self.monitor(args,job,'apply',before,lock_fd)
                    self.report(identity,'verify','running','Checking exact target identity and serving readiness',self.log(job,before))
                    if not self.agent.target_ready(release,require_serving=True):raise RuntimeError('Exact target identity or serving readiness not proven')
                    actual=self.app(lock_fd);diagnostic=(actual or {}).get('hostDiagnostics') or {};base=diagnostic.get('base') or {}
                    if release.get('descriptorSha256') and base.get('build')==release['build'] and base.get('descriptorSha256')==release['descriptorSha256']:
                        save(self.root/'app-baseline.json',{'schema':1,'build':release['build'],'protocol':release['protocol'],'descriptorSha256':release['descriptorSha256']})
                    self.state['floor']=max(self.state.get('floor',0),release['build'])
                    self.state['phase']='terminal';self.report(identity,'verify','succeeded','Exact signed application target is serving',self.log(job,before))
        except ConfirmationExpired as error:
            self.state['phase']='terminal';self.report(identity,self.state.get('report',{}).get('stage','preflight'),'failed',('Agent target is already committed; ' if committed_agent else '')+str(error))
        except (BlockingIOError,ApplicationBusy) as error:
            self.state['phase']='waiting';self.report(identity,'preflight','waiting',str(error) if isinstance(error,ApplicationBusy) else 'Another host operation owns the shared gate; will retry')
        except Exception as error:
            if self.state.get('phase')=='applying' and self.probe_quiet:
                # A failed observer does not prove runner exit. Its inherited
                # shared lock remains recovery authority; heartbeat stays quiet.
                self.report(identity,'verify','waiting','Runner observation failed; awaiting shared gate without probes or replay')
            elif self.state.get('phase')=='agent-handoff':
                # Preserve the handoff intent: activation may already have been scheduled.
                self.report(identity,'agent','waiting','Agent maintenance request persisted; awaiting verified new instance')
            else:
                detail=self.log(job,self.state.get('workdirsBefore',()));maintenance=False
                try:
                    filesystem=ops.filesystem_snapshot();kernel=filesystem['kernel']
                    maintenance=not filesystem['root_rw'] or re.search(r'EXT4-fs (?:error|warning)|I/O error|Remounting filesystem read-only|Aborting journal',kernel,re.I) is not None
                    if kernel.strip() and kernel.strip()!='-- No entries --':detail+='\nKernel filesystem errors:\n'+kernel[-2000:]
                except Exception:pass
                self.state['phase']='terminal';self.report(identity,'maintenance' if maintenance else self.state.get('report',{}).get('stage','preflight'),'maintenance-required' if maintenance else 'failed',str(error),detail)

    def run(self):
        self.reconcile();backoff=5
        while not stopping:
            try:
                if self.state.get('phase') not in (None,'terminal','accepted','waiting','agent-committed','agent-handoff','agent-confirmation'):
                    self.reconcile()
                job=self.poll();backoff=5;self.refresh_inventory();self.retain_logs()
                if self.relay and not self.probe_quiet and time.monotonic()>=self.relay_next:
                    try:
                        # Poll/proof has already run; this serial check never runs
                        # concurrently with this worker's application subprocess.
                        self.relay.cycle(self.config,self.agent.request,self.root,PROGRAM,self.agent.container)
                    except Exception as error:print('Host relay channel:',type(error).__name__,flush=True)
                    self.relay_next=time.monotonic()+random.uniform(24,36)
                if job and job['id']!=self.state.get('lastJob'):self.accept(job)
                if self.state.get('phase')=='agent-handoff':self.observe_handoff()
                if self.state.get('phase')=='agent-confirmation' and self.confirm_agent():
                    # Deliver committed agent/running to the center before any
                    # later stage can replace this ownership transition report.
                    continue
                if self.state.get('phase') in ('accepted','waiting','agent-committed'):self.execute()
            except Exception as error:
                print('Host v2 channel:',type(error).__name__,flush=True);backoff=min(300,backoff*2)
            deadline=time.monotonic()+random.uniform(backoff*.8,backoff*1.2)
            while not stopping and time.monotonic()<deadline:time.sleep(1)


def main():
    if os.geteuid()!=0:raise RuntimeError('Host worker requires root')
    os.umask(0o077)
    ops.protected(ROOT,True);ops.protected(ROOT/'config.json')
    worker=Worker(json.loads((ROOT/'config.json').read_text()))
    import fcntl
    fd=os.open(ROOT/'worker.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);worker.run()
    finally:os.close(fd)


if __name__=='__main__':
    def stop(*args):
        global stopping
        stopping=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    main()
