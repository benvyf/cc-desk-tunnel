"""Fixed initial host-channel setup; no credential redemption or application install."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

def _entry():
    path=Path(__file__).with_name('host-bootstrap-entry.py')
    spec=importlib.util.spec_from_file_location('cc_bootstrap_recovery',path)
    entry=importlib.util.module_from_spec(spec); spec.loader.exec_module(entry); return entry

def require_recovery(manager):
    observed=manager('inspect-recovery')
    if observed!={'active':True,'subState':'exited','result':'success'}:
        raise ValueError('boot recovery service must already be active (exited) before initial activation')

def ensure_recovery(manager):
    """Call OUTSIDE operation.lock, before prepare_initial records any intent.

    Starting an inactive recovery dependency during updater start would wait on
    the activation's own operation lock, or restore its uncommitted candidate.
    """
    observed=manager('inspect-recovery')
    if observed!={'active':True,'subState':'exited','result':'success'}:manager('start-recovery')
    require_recovery(manager)

def prepare_initial(core, program, data, units, legacy, candidate, mode, manager, binding=None):
    require_recovery(manager)
    entry=_entry(); entry.unit_layout(units)
    if mode not in ('legacy','enroll','fresh'): raise ValueError('unknown bootstrap mode')
    config_path=data/'config.json'; core._protect(config_path)
    config=core._json(config_path.read_bytes())
    if candidate.get('nodeId') != config['nodeId']: raise ValueError('candidate node identity mismatch')
    state=core._state(data)
    if state.get('current') or state.get('floor'): raise ValueError('initial bootstrap cannot replace an installed platform')
    core._directory(data/'agent-platform')
    journal=data/'agent-platform'/'initial-unit.json'
    if journal.exists() and entry.read_json(journal).get('phase') not in ('rolled-back',): raise ValueError('initial transaction already exists')
    previous=manager('inspect')
    if previous.get('enabled') not in ('enabled','disabled') or type(previous.get('active')) is not bool: raise ValueError('unsupported prior unit state')
    unit=units/'cc-host-updater.service'; raw=unit.read_bytes() if unit.exists() else None
    if raw is None and previous['active']: raise ValueError('unknown active updater')
    if raw is not None: core._write(data/'agent-platform'/'prior-unit',raw)
    tx={'schema':1,'mode':mode,'phase':'prepared','nodeId':config['nodeId'], 'configSha256':core._digest(config_path.read_bytes()),
        'candidate':candidate,'candidateUnitSha256':core._digest(fixed_units()['cc-host-updater.service']),'priorUnit':dict(previous,exists=raw is not None,sha256=core._digest(raw) if raw is not None else None),
        'previousProgram':entry.program_identity(legacy) if legacy.exists() else None,'binding':binding or {},'sourceHashes':entry.read_json(program/'source-hashes.json') if (program/'source-hashes.json').exists() else {}}
    core._write(journal,core._canonical(tx)); return tx

def fixed_units():
    root='/opt/cc-host-platform/'
    return {
        'cc-host-updater.service':('[Unit]\nDescription=CC signed host update channel\nWants=network-online.target\nAfter=network-online.target docker.service cc-host-recovery.service\nRequires=cc-host-recovery.service\n[Service]\nType=simple\nUser=root\nExecStart=/usr/bin/python3 -I '+root+'host-platform-entry.py launch\nRestart=on-failure\nRestartSec=15\n[Install]\nWantedBy=multi-user.target\n').encode(),
        'cc-host-maintenance.service':('[Unit]\nDescription=CC independent agent maintenance\nAfter=network-online.target\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 -I '+root+'host-platform-entry.py maintain\nTimeoutStartSec=10min\n').encode(),
        'cc-host-recovery.service':('[Unit]\nDescription=CC host channel boot recovery\nBefore=cc-host-updater.service\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 -I '+root+'host-bootstrap-entry.py recover\nRemainAfterExit=yes\nTimeoutStartSec=3min\n[Install]\nWantedBy=multi-user.target\n').encode(),
        'cc-host-adoption.service':('[Unit]\nDescription=CC legacy channel adoption observer\nAfter=network-online.target docker.service\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 -I '+root+'host-bootstrap.py observe\nTimeoutStartSec=10min\n').encode(),
        'cc-host-adoption.timer':b'[Unit]\nDescription=Observe fixed legacy adoption\n[Timer]\nOnBootSec=30s\nOnUnitInactiveSec=30s\nUnit=cc-host-adoption.service\n[Install]\nWantedBy=timers.target\n'}

def activate_initial(core, program, data, units, legacy, candidate, manager, healthy):
    entry=_entry(); path=data/'agent-platform'/'initial-unit.json'; tx=entry.read_json(path)
    if tx['candidate']!=candidate or tx['phase']!='prepared': raise ValueError('initial activation is not prepared')
    require_recovery(manager)
    def mutate(phase, callback):
        if core._digest((data/'config.json').read_bytes())!=tx['configSha256']: raise ValueError('configuration changed')
        entry.validate_initial_intent(tx,units,legacy)
        tx['phase']=phase; core._write(path,core._canonical(tx)); callback()
    def stop():
        # mutate validates the current phase-owned fragment before this test.
        # Fresh first activation has no service; rollback must still stop the
        # candidate once its launcher fragment has been published.
        mutate('stopping' if tx['phase']=='prepared' else 'rollback-stopping',
            lambda:manager('stop') if (units/'cc-host-updater.service').exists() else None)
    def start():
        # Read-only prerequisite check; never start recovery under platform locks.
        require_recovery(manager)
        mutate('installing-unit',lambda:core._write(units/'cc-host-updater.service',fixed_units()['cc-host-updater.service']))
        mutate('reloading',lambda:manager('reload'))
        mutate('enabling',lambda:manager('enable'))
        mutate('starting',lambda:manager('start'))
    try:
        result=core.activate(program,data,candidate,stop,start,healthy)
        if core._digest((data/'config.json').read_bytes())!=tx['configSha256']: raise ValueError('configuration changed')
        tx['phase']='committed'; core._write(path,core._canonical(tx)); return result
    except Exception:
        # activate has released its locks after its own worker-pointer rollback.
        with core._operation_locked(data): entry.recover_initial(program,data,units,legacy,manager,boot=False)
        raise

SOURCE_FILES = frozenset({'host-platform.py','host-platform-entry.py','host-bootstrap.py','host-bootstrap-entry.py','host-operations.py'})

def validate_sources(sources, hashes, keys):
    """Pure pre-redemption validation of caller-authenticated fixed source bytes.

    hashes must come from the hash-pinned installer or signed application source,
    never a response accepted solely because it travelled over HTTPS.
    """
    import hashlib
    if set(sources)!=SOURCE_FILES or set(hashes)!=SOURCE_FILES or not isinstance(keys,dict) or not keys: raise ValueError('incomplete trusted bootstrap source')
    checked={}
    for name,raw in sources.items():
        if not isinstance(raw,bytes) or len(raw)>512*1024 or hashlib.sha256(raw).hexdigest()!=hashes[name]: raise ValueError('trusted source digest mismatch')
        compile(raw,name,'exec',dont_inherit=True); checked[name]=raw
    return checked

def validate_worker(core,envelope,archive,keys,floor=None,now=None):
    """Pure signed-package preflight, usable before any credential redemption."""
    manifest,files=core.verify_bundle(envelope,archive,keys,floor,now)
    for name,raw in files.items():
        if name.endswith('.py'):compile(raw,name,'exec',dont_inherit=True)
    return manifest,files

def stage_sources(core, program, data, sources, hashes, keys):
    """Private staging only. Existing stable runtime remains byte-for-byte intact."""
    checked=validate_sources(sources,hashes,keys)
    core._directory(program)
    stage=core._directory(program/'.bootstrap-stage')
    for name,raw in checked.items():core._write(stage/name,raw)
    core._write(stage/'trusted-keys.json',core._canonical(keys))
    core._write(stage/'source-hashes.json',core._canonical(hashes))
    core._sync_dir(stage); return stage

def publish_sources(core, program, data):
    """Only initial setup may publish stable sources; never upgrade a live core."""
    state=core._state(data)
    if state.get('current') or state.get('floor'): raise ValueError('stable runtime is already installed')
    stage=program/'.bootstrap-stage'; core._protect(stage,True)
    hashes=core._json((stage/'source-hashes.json').read_bytes()); keys=core._json((stage/'trusted-keys.json').read_bytes())
    checked=validate_sources({name:(stage/name).read_bytes() for name in SOURCE_FILES},hashes,keys)
    checked.update({'trusted-keys.json':core._canonical(keys),'source-hashes.json':core._canonical(hashes)})
    # Preflight the entire destination before publishing the first byte.
    for name,raw in checked.items():
        path=program/name
        if path.exists() or path.is_symlink():
            core._protect(path)
            if path.read_bytes()!=raw: raise ValueError('refusing to replace existing stable source')
    for name,raw in checked.items():core._write(program/name,raw)
    return hashes

def install_support_units(core, units, data):
    _entry().unit_layout(units)
    for name,raw in fixed_units().items():
        if name=='cc-host-updater.service': continue
        path=units/name
        if path.exists() and path.read_bytes()!=raw: raise ValueError('existing support unit differs')
    core._directory(data/'agent-platform')
    journal=data/'agent-platform'/'support-setup.json'
    for name,raw in fixed_units().items():
        if name!='cc-host-updater.service':
            core._write(journal,core._canonical({'schema':1,'phase':'publishing','unit':name,'sha256':core._digest(raw)}))
            core._write(units/name,raw)
    core._write(journal,core._canonical({'schema':1,'phase':'published'}))

def verify_app_index(core, envelope, keys, installed=False, now=None):
    """Authenticate exact Linux app publication; installed is read-only proof only."""
    import re
    from datetime import datetime, timezone, timedelta
    raw=core.verify_signed_payload(envelope,keys); payload=core._json(raw)
    if not isinstance(payload,dict) or set(payload)!={'schema','product','channel','platform','arch','revision','issuedAt','expiresAt','release'}: raise ValueError('invalid app index')
    if type(payload['schema']) is not int or [payload[k] for k in ('schema','product','channel','platform','arch')]!=[1,'cc-desk-tunnel-managed-server','pilot','linux','x64'] or not core._positive(payload['revision']): raise ValueError('wrong app product')
    issued,expires=core._date(payload['issuedAt']),core._date(payload['expiresAt']); now=now or datetime.now(timezone.utc)
    if not timedelta(0)<expires-issued<=timedelta(days=31) or issued>now+timedelta(seconds=60) or (not installed and now>=expires): raise ValueError('app index expired or invalid lifetime')
    release=payload['release']
    fields={'build','appVersion','protocol','sourceCommit','size','sha256','packageLockSha256','runtimeLevel','compatibility','descriptorSha256'}
    if not isinstance(release,dict) or set(release)!=fields:raise ValueError('invalid app release fields')
    if any(not core._positive(release[k]) for k in ('build','protocol','size')) or release['size']>64*1024**2:raise ValueError('invalid app release numbers')
    if any(not isinstance(release[k],str) or not re.fullmatch('[a-f0-9]{64}',release[k]) for k in ('sha256','packageLockSha256','descriptorSha256')):raise ValueError('invalid app release digest')
    if (not isinstance(release['appVersion'],str) or not re.fullmatch(r'[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-zA-Z0-9.]{1,40})?',release['appVersion'])
        or not isinstance(release['sourceCommit'],str) or not re.fullmatch('[a-f0-9]{40}',release['sourceCommit'])
        or not isinstance(release['runtimeLevel'],str) or len(release['runtimeLevel'])>100
        or not isinstance(release['compatibility'],dict) or len(release['compatibility'])>128
        or any(not isinstance(v,str) or not re.fullmatch('[a-f0-9]{64}',v) for v in release['compatibility'].values())):raise ValueError('invalid app release metadata')
    return release

def exact_app_ready(release,status,journal,unfinished):
    """No healthy-HTTP shortcut: require serving, journal and program identity."""
    if not isinstance(status,dict) or not isinstance(journal,dict) or unfinished:return False
    current=status.get('current') or {}; diagnostic=status.get('hostDiagnostics') or {}; base=diagnostic.get('base') or {}; program=diagnostic.get('program') or {}
    same=lambda value: all(type(value.get(k)) is type(release[k]) and value[k]==release[k] for k in ('build','protocol'))
    identity=current.get('sha256')==release['sha256'] or (current.get('sha256') is None and status.get('descriptorSha256')==release['descriptorSha256'])
    recorded=journal.get('current') or {}
    return (type(journal.get('schema')) is int and journal['schema']==1 and journal.get('phase') in ('idle','committed')
        and same(recorded) and recorded.get('sha256') in (None,release['sha256']) and same(current) and identity
        and status.get('phase') in ('idle','committed') and status.get('serving') is True
        and type(diagnostic.get('schema')) is int and diagnostic['schema']==1 and diagnostic.get('ready') is True and diagnostic.get('serving') is True
        and base.get('build')==release['build'] and base.get('descriptorSha256')==release['descriptorSha256']
        and same(program) and program.get('descriptorSha256')==release['descriptorSha256'] and status.get('descriptorSha256')==release['descriptorSha256'])

def verified_journal(core,keys,journal,release):
    fields={'schema','phase','current','previous','target','backup','attempts'}
    if not isinstance(journal,dict) or set(journal)!=fields or type(journal['schema']) is not int or journal['schema']!=1 or type(journal['attempts']) is not int or journal['attempts']<0:raise ValueError('unknown application journal')
    if journal['phase'] not in ('idle','committed') or journal['target'] is not None:raise ValueError('unfinished application journal')
    recorded=verify_app_index(core,journal['current'],keys,installed=True) if journal['current'] is not None else release
    if any(recorded[k]!=release[k] for k in ('build','protocol','sha256','descriptorSha256')):raise ValueError('application journal target mismatch')
    return dict(journal,current=recorded)

def request(config,path,value=None,limit=131072):
    import re
    import urllib.parse
    import urllib.request
    import time
    origin=urllib.parse.urlsplit(config['origin'])
    if origin.scheme!='https' or not origin.hostname or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment:raise ValueError('expected bare HTTPS center origin')
    if not ((path=='/cc-host/v2/adoption' and value is not None) or (value is None and re.fullmatch(r'/cc-host/v2/agent-artifacts/[a-f0-9]{64}\.tar\.gz',path))):raise ValueError('unsupported adoption request')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    payload=json.dumps(value,separators=(',',':')).encode() if value is not None else None
    req=urllib.request.Request(config['origin'].rstrip('/')+path,data=payload,headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
    attempts=1 if value is not None else 3
    for attempt in range(attempts):
        try:
            with urllib.request.build_opener(NoRedirect).open(req,timeout=15) as response:
                if not 200<=response.status<300:raise ValueError('center rejected adoption')
                raw=response.read(limit+1)
            if len(raw)>limit:raise ValueError('adoption response exceeds limit')
            return json.loads(raw) if value is not None else raw
        except (OSError,TimeoutError):
            if attempt+1==attempts:raise
            time.sleep(attempt+1)

def adoption_report(phase,config,error=None,activation_started=None):
    """Small fixed-unit evidence attached to adoption progress and failures."""
    path=Path(__file__).with_name('host-operations.py');_entry().protected(path)
    spec=importlib.util.spec_from_file_location('cc_adoption_report_redaction',path)
    ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
    messages={'prepared':'Observing the exact confirmed legacy application job',
        'waiting-app':'Waiting for signed application readiness and its normal result',
        'waiting-ack':'Waiting for the legacy application terminal acknowledgement',
        'activating':'Starting the independently supervised signed host worker',
        'precheck':'Read-only repair evidence; no activation was requested',
        'failed':'Host worker setup failed; the saved attempt will not activate again',
        'maintenance-required':'Host channel recovery needs maintenance; no activation was requested'}
    secrets=[config.get('token','')]
    detail=(type(error).__name__+': '+str(error)) if error is not None else ''
    message=messages.get(phase,'Observing host channel adoption')+(': '+detail if detail else '')
    log=detail
    if error is not None and activation_started is not None:
        try:
            from datetime import datetime,timezone
            import time
            started=datetime.fromisoformat(activation_started.replace('Z','+00:00'))
            if started.tzinfo is None or not 0<=time.time()-started.timestamp()<=2*86400:raise ValueError('invalid activation log boundary')
            result=subprocess.run(['journalctl','--unit=cc-host-updater.service','--since=@'+str(int(started.timestamp())),
                '--no-pager','--output=cat','--lines=60'],capture_output=True,text=True,timeout=10,env={**__import__('os').environ,'LC_ALL':'C'})
            if result.returncode==0:log+='\nCandidate updater journal since this activation:\n'+ops.redact(result.stdout,secrets)[-12000:]
            else:log+='\nCandidate updater journal unavailable (journalctl exit '+str(result.returncode)+')'
        except (OSError,ValueError,subprocess.SubprocessError):log+='\nCandidate updater journal unavailable'
    report={'message':ops.redact(message,secrets)[:1000],'log':ops.redact(log,secrets)[-6000:]}
    # Leave room for fixed association fields even when escaping expands text.
    while len(json.dumps(report).encode())>6500:
        if report['log']:report['log']=report['log'][max(1,len(report['log'])//8):]
        else:report['message']=report['message'][:-max(1,len(report['message'])//8)]
    return report

def report_recovery_failure(program,data,error,transport=request):
    """Best effort only after protected original config AND context still match.

    No platform import is needed, and a changed config origin is never used.
    """
    try:
        entry=_entry();tx=entry.read_json(data/'agent-platform'/'initial-unit.json')
        local=entry.read_json(data/'agent-platform'/'adoption.json')
        config_path=data/'config.json';entry.protected(config_path);raw=config_path.read_bytes()
        if len(raw)>64*1024 or entry.digest(raw)!=tx['configSha256']:return False
        config=entry.read_json(config_path);binding=tx['binding']
        if tx.get('schema')!=1 or config.get('nodeId')!=tx['nodeId'] or any(not local.get(k) or binding.get(k)!=local[k] for k in ('bridgeId','appJobId','attemptId')):return False
        payload={'nodeId':config['nodeId'],'phase':'maintenance-required',**{k:local[k] for k in ('bridgeId','appJobId','attemptId')},
            'report':adoption_report('maintenance-required',config,error,local.get('activationStartedAt'))}
        # Check the exact bytes again immediately before choosing the transport.
        entry.protected(config_path)
        if config_path.read_bytes()!=raw:return False
        transport(config,'/cc-host/v2/adoption',payload);return True
    except Exception:return False

def report_image_recovery_failure(program,data,error,transport=request):
    """Image recovery precedes initial agent-unit intent; bind its own receipt."""
    try:
        entry=_entry();context=entry.read_json(data/'agent-platform'/'original-app.json');local=entry.read_json(data/'agent-platform'/'adoption.json')
        path=data/'config.json';entry.protected(path);raw=path.read_bytes()
        if len(raw)>64*1024 or entry.digest(raw)!=context.get('hostConfigSha256'):return False
        config=entry.read_json(path)
        if context.get('schema')!=1 or config.get('nodeId')!=context.get('nodeId') or local.get('appJobId')!=context.get('appJobId') or any(not local.get(k) for k in ('bridgeId','appJobId','attemptId')):return False
        payload={'nodeId':config['nodeId'],'phase':'maintenance-required',**{k:local[k] for k in ('bridgeId','appJobId','attemptId')},'report':adoption_report('maintenance-required',config,error)}
        entry.protected(path)
        if path.read_bytes()!=raw:return False
        transport(config,'/cc-host/v2/adoption',payload);return True
    except Exception:return False


class AdoptionObserver:
    """One bounded observation per timer invocation; failed activation is never replayed.

    inspect(release) is a fixed process boundary returning rootRw, kernelStatus,
    status, journal and unfinished. It runs exclusively under the shared gate.
    Network and systemd effects are independent of the old worker cgroup.
    """
    def __init__(self,core,program,data,units,legacy,manager,transport,inspect,gate):
        self.core=core;self.program=program;self.data=data;self.units=units;self.legacy=legacy
        self.manager=manager;self.transport=transport;self.inspect=inspect;self.gate=gate
        core._directory(data/'agent-platform');self.path=data/'agent-platform'/'adoption.json'
        self.config_path=data/'config.json';core._protect(self.config_path)
        self.config_bytes=self.config_path.read_bytes();self.config=core._json(self.config_bytes)
        self.local=_entry().read_json(self.path) if self.path.exists() else {'schema':1,'phase':'new'}
    def save(self):self.core._write(self.path,self.core._canonical(self.local))
    def old(self):
        path=self.data/'state.json';self.core._protect(path)
        if path.stat().st_size>256*1024:raise ValueError('legacy state too large')
        return self.core._json(path.read_bytes())
    def unchanged(self):
        self.core._protect(self.config_path)
        if self.config_path.read_bytes()!=self.config_bytes:raise ValueError('configuration changed during adoption')
    def post(self,phase,proof=None,report=None):
        self.unchanged();payload={'nodeId':self.config['nodeId'],'phase':phase,'appJobId':self.local['appJobId']}
        if phase!='prepared' or self.local.get('bridgeId'):payload['bridgeId']=self.local['bridgeId']
        if phase!='prepared':payload['attemptId']=self.local['attemptId']
        if proof is not None:payload['proof']=proof
        payload['report']=report or (self.local.get('failureReport') if phase in ('failed','maintenance-required','precheck') else None) or adoption_report(phase,self.config)
        return self.transport(self.config,'/cc-host/v2/adoption',payload)
    def failed(self,error,phase='failed'):
        report=adoption_report(phase,self.config,error,self.local.get('activationStartedAt'))
        self.local.update(phase=phase,failureReport=report);self.save()
        try:self.post(phase,report=report)
        except (OSError,ValueError):pass
        return phase
    def validate(self,response,old):
        import re
        import time
        bridge=response['bridge'];attempt=response['attempt'];job=attempt['job']
        required={'id','nodeId','build','sha256','index','agentIndex','createdAt','expiresAt'}
        if not isinstance(job,dict) or not required<=set(job) or set(job)-required-{'instanceId'}:raise ValueError('invalid component job fields')
        created=self.core._date(job['createdAt']).timestamp();expires=self.core._date(job['expiresAt']).timestamp()
        if not 0<expires-created<=600 or created>time.time()+60 or any(type(attempt.get(k)) is not bool for k in ('startAllowed','activationAccepted','targetReadyApproved')):raise ValueError('invalid adoption authorization')
        if attempt.get('startedAt') is not None:
            started=self.core._date(attempt['startedAt']).timestamp();until=self.core._date(attempt['continuationUntil']).timestamp()
            if not 0<until-started<=7200 or started>time.time()+60:raise ValueError('invalid adoption continuation')
        elif attempt['startAllowed']:raise ValueError('adoption was not started')
        if (bridge['appJobId']!=self.local['appJobId'] or bridge['appJobId']!=old.get('lastJob')
            or (self.local.get('bridgeId') and bridge['id']!=self.local['bridgeId'])
            or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',str(attempt['id']))
            or job.get('id')!=attempt['id'] or job.get('nodeId')!=self.config['nodeId'] or job.get('index') is not None or job.get('build') is not None or job.get('sha256') is not None
            or job.get('agentIndex')!=attempt['agentIndex'] or attempt['app']!={'build':bridge['build'],'sha256':bridge['sha256']}):raise ValueError('adoption association mismatch')
        release=verify_app_index(self.core,bridge['index'],self.config['keys'],installed=True)
        if (release['build'],release['sha256'])!=(bridge['build'],bridge['sha256']):raise ValueError('signed application target changed')
        target=old.get('target') or {}
        if any(target.get(k)!=release[k] for k in ('build','protocol','sha256')):raise ValueError('legacy confirmed target changed')
        return bridge,attempt,release
    def proof(self,release):
        from datetime import datetime,timezone
        snapshot=self.inspect(release);ready=False;recovery='unknown'
        try:
            journal=verified_journal(self.core,self.config['keys'],snapshot['journal'],release)
            recovery='unfinished' if snapshot['unfinished'] else 'settled'
            ready=exact_app_ready(release,snapshot['status'],journal,snapshot['unfinished'])
        except (ValueError,KeyError):
            if snapshot.get('unfinished'):recovery='unfinished'
        app_ready=ready
        if not ready and (snapshot.get('baseline') is not None or snapshot.get('originalAuthenticated') is True):
            app_ready=repair_proof(snapshot)
            if app_ready:recovery='settled'
        platform=self.core._state(self.data)
        initial=self.data/'agent-platform'/'initial-unit.json'
        if platform.get('phase') not in ('steady','staged'):recovery='unfinished'
        if initial.exists():
            transaction=_entry().read_json(initial)
            if transaction.get('phase') not in ('committed','rolled-back') and not _entry().committed(platform,transaction['candidate']):recovery='unfinished'
        return {'observedAt':datetime.now(timezone.utc).isoformat(),'rootRw':snapshot.get('rootRw') is True,
            'kernelStatus':snapshot.get('kernelStatus') if snapshot.get('kernelStatus') in ('clear','errors','unavailable') else 'unavailable',
            'recovery':recovery,'appReady':app_ready,'targetReady':ready}
    def stage(self,attempt):
        envelope=attempt['agentIndex'];untrusted=self.core._json(self.core._b64(envelope['payload']));sha=untrusted.get('archive',{}).get('sha256')
        import re
        if not isinstance(sha,str) or not re.fullmatch('[a-f0-9]{64}',sha):raise ValueError('invalid agent artifact identity')
        archive=self.transport(self.config,'/cc-host/v2/agent-artifacts/'+sha+'.tar.gz',limit=self.core.MAX_ARCHIVE)
        key_path=self.program/'trusted-keys.json';self.core._protect(key_path);keys=self.core._json(key_path.read_bytes())
        manifest,files=validate_worker(self.core,envelope,archive,keys,self.core._state(self.data)['floor'])
        return self.core.stage_bundle(self.program,self.data,manifest,files)
    def seed_worker(self,attempt,candidate,release):
        state=self.core._state(self.data)
        if state.get('current') or state.get('floor'):raise ValueError('committed worker state cannot be replaced')
        path=self.data/'worker-state.json'
        if path.exists():
            prior=_entry().read_json(path)
            archived=self.data/'agent-platform'/'failed-worker-state.json'
            previous=self.local.get('previousAttempt')
            if not previous or prior.get('lastJob')!=previous or prior.get('phase') not in ('terminal','agent-handoff','agent-confirmation'):raise ValueError('unrecognized prior worker state')
            self.core._write(archived,path.read_bytes())
        job=attempt['job']
        seeded={'job':job,'lastJob':attempt['id'],'ownedJobs':[attempt['id']],'agentTarget':{k:candidate[k] for k in ('version','sha256')},'phase':'agent-handoff','reportSeq':0,'floor':max(self.old().get('floor',0),release['build'])}
        self.core._write(path,self.core._canonical(seeded))
        self.core._write(self.data/'app-baseline.json',self.core._canonical({'schema':1,'build':release['build'],'protocol':release['protocol'],'descriptorSha256':release['descriptorSha256']}))
    def step(self):
        try:
            with self.gate():
                self.unchanged();old=self.old()
                if not self.local.get('appJobId'):
                    self.local['appJobId']=old.get('lastJob')
                    if not self.local['appJobId']:raise ValueError('no local legacy application association')
                    self.save()
        except BlockingIOError:return 'busy'
        # Discover the exact old application association, never today's publication.
        response=self.post('prepared');bridge,attempt,release=self.validate(response,old)
        previous=self.local.get('attemptId')
        if previous and previous!=attempt['id']:
            if self.local['phase'] not in ('failed','maintenance-required'):raise ValueError('new attempt before prior attempt settled')
            self.local={'schema':1,'phase':'new','appJobId':bridge['appJobId'],'bridgeId':bridge['id'],'previousAttempt':previous}
        self.local.update(bridgeId=bridge['id'],attemptId=attempt['id'],response=response);self.save()
        platform=self.core._state(self.data)
        candidate=self.local.get('candidate')
        if candidate and _entry().committed(platform,candidate):
            self.local['phase']='committed';self.save();return 'committed'
        terminal=attempt['state'] in ('failed','maintenance-required','adopted')
        try:
            with self.gate():
                self.unchanged();old=self.old()
                if old.get('lastJob')!=bridge['appJobId']:raise ValueError('legacy application identity changed')
                proof=self.proof(release)
        except BlockingIOError:return 'busy'
        if terminal or self.local['phase'] in ('failed','maintenance-required'):
            if terminal:self.local['phase']=attempt['state'];self.save()
            if attempt['state']!='adopted':self.post('precheck',proof)
            return attempt['state'] if terminal else self.local['phase']
        if self.local['phase'] in ('authorization-pending','activating'):
            return self.failed(RuntimeError(self.local.get('authorizationError','Interrupted activation authorization; no cutover is replayed')))
        import time
        if not attempt['startAllowed'] or time.time()>=self.core._date(attempt['continuationUntil']).timestamp():return 'waiting-authorization'
        if not proof['rootRw'] or proof['kernelStatus']!='clear' or proof['recovery']!='settled':
            return self.failed(ValueError('Root writable='+str(proof['rootRw'])+', kernel='+proof['kernelStatus']+', recovery='+proof['recovery']),'maintenance-required')
        if not proof['targetReady'] or (bridge['state']!='succeeded' and not (attempt['targetReadyApproved'] is True and bridge['state']=='failed')):
            self.post('waiting-app');return 'waiting-app'
        if old.get('report') is not None or (not attempt['targetReadyApproved'] and old.get('floor',0)<release['build']):
            self.post('waiting-ack');return 'waiting-ack'
        # Verify and stage immutable worker bytes before requesting the one-time cutover.
        try:candidate=self.stage(attempt)
        except Exception as error:return self.failed(error)
        self.local['candidate']=candidate;self.save()
        try:
            with self.gate():
                self.unchanged();fresh=self.old()
                if fresh!=old or not self.proof(release)['targetReady']:return 'waiting-ack'
                self.local['phase']='authorization-pending';self.save()
        except BlockingIOError:return 'busy'
        try:authorized=self.post('activating')
        except (OSError,TimeoutError) as error:
            self.local['authorizationError']=adoption_report('failed',self.config,error)['message'];self.save();return 'authorization-pending'
        authorized_bridge,authorized_attempt,_=self.validate(authorized,old)
        if authorized_attempt['id']!=attempt['id'] or authorized_attempt['activationAccepted'] is not True:
            return self.failed(ValueError('Center did not accept activation for the exact bound attempt'))
        from datetime import datetime,timezone
        self.local.update(phase='activating',activationStartedAt=datetime.now(timezone.utc).isoformat());self.save()
        # Release the gate before core.activate reacquires it. Its stop callback
        # revalidates the protected old intent, closing the inspection/cutover gap.
        try:
            ensure_recovery(self.manager)
            with self.gate():
                self.unchanged()
                if self.old()!=old or not self.proof(release)['targetReady']:raise ValueError('application intent changed before cutover')
                self.seed_worker(attempt,candidate,release)
                prepare_initial(self.core,self.program,self.data,self.units,self.legacy,candidate,'legacy',self.manager,
                    {'bridgeId':bridge['id'],'appJobId':bridge['appJobId'],'attemptId':attempt['id']})
            transition_started=False
            def guarded_manager(action):
                nonlocal transition_started
                if action=='stop' and not transition_started:
                    self.unchanged()
                    if time.time()>=self.core._date(attempt['continuationUntil']).timestamp():raise ValueError('activation continuation expired')
                    if self.old()!=old:raise ValueError('legacy application state changed before stop')
                    association=_entry().read_json(self.path)
                    if association.get('attemptId')!=attempt['id'] or association.get('bridgeId')!=bridge['id'] or association.get('phase')!='activating':raise ValueError('adoption authorization changed before stop')
                    transition_started=True
                return self.manager(action)
            activate_initial(self.core,self.program,self.data,self.units,self.legacy,candidate,guarded_manager,lambda current:self.core.wait_healthy(self.data,current))
            self.local['phase']='committed';self.save();return 'committed'
        except Exception as error:return self.failed(error)

def preflight(core,program,data,units,legacy,manager):
    """Call before grant redemption. Active platforms never need re-enrollment.

    A committed inner transaction with the same persisted config resumes without
    redeeming again. Every other live platform returns already-platform.
    """
    entry=_entry();entry.unit_layout(units)
    path=data/'agent-platform'/'initial-unit.json'
    if path.exists():
        tx=entry.read_json(path)
        if tx.get('phase') not in ('committed','rolled-back'):
            state=core._state(data)
            if entry.committed(state,tx['candidate']):
                with core._operation_locked(data):entry.recover_initial(program,data,units,legacy,manager)
                return 'resumed'
            raise ValueError('unfinished initial installation requires recovery')
    state=core._state(data)
    if state.get('current') or state.get('floor'):return 'already-platform'
    previous=manager('inspect')
    if previous.get('enabled') not in ('enabled','disabled') or type(previous.get('active')) is not bool:raise ValueError('unsupported prior unit state')
    if not (units/'cc-host-updater.service').exists() and previous['active']:raise ValueError('unknown active updater without unit fragment')
    return 'initial'

def stage_probe(core,program,raw,expected_sha256):
    """Persist trusted fixed management probe, never one obtained from a worker."""
    if not isinstance(raw,bytes) or len(raw)>128*1024 or core._digest(raw)!=expected_sha256:raise ValueError('fixed probe source hash mismatch')
    if b'const fs = require(' not in raw or b'if (target.probe)' not in raw:raise ValueError('unsupported fixed management probe')
    path=program/'server-upgrade.cjs'
    if path.exists() or path.is_symlink():
        core._protect(path)
        if path.read_bytes()!=raw:raise ValueError('fixed probe already installed')
    core._write(path,raw);core._write(program/'probe-sha256',expected_sha256.encode())

def fixed_inspection(core,program,ops,release):
    """Caller holds operation.lock, so no probes enter a frozen application."""
    probe=program/'server-upgrade.cjs';identity=program/'probe-sha256'
    for path in (probe,identity):core._protect(path)
    raw=probe.read_bytes()
    if len(raw)>128*1024 or core._digest(raw)!=identity.read_text():raise ValueError('fixed probe identity changed')
    ids=ops.output(['docker','ps','--filter','label=com.docker.compose.service=proxy','--format','{{.ID}}']).split()
    candidates=[]
    for identity in ids:
        if not __import__('re').fullmatch('[a-f0-9]{12,64}',identity):raise ValueError('invalid local container identity')
        info=json.loads(ops.output(['docker','inspect',identity]))[0]
        project=(info.get('Config',{}).get('Labels') or {}).get('com.docker.compose.project','')
        if project=='cc-desk-tunnel' or project.startswith('cc-desk-tunnel-'):candidates.append(identity)
    if len(candidates)!=1:raise ValueError('expected one local CC application')
    container=candidates[0]
    source='const target='+json.dumps({'probe':True,'protocol':release['protocol']})+';\n'+raw.decode('utf-8')
    output=ops.output(['docker','exec','-i',container,'/opt/runtime/node/bin/node','--env-file=/data/config/service.env','--input-type=commonjs','-e',source],timeout=20)
    if len(output)>128*1024:raise ValueError('management proof exceeds limit')
    status=core._json(output.strip().splitlines()[-1]);journal=ops.read_journal(container)
    filesystem={'rootRw':False,'kernelStatus':'unavailable'}
    try:
        observed=ops.filesystem_snapshot();filesystem={'rootRw':observed['root_rw'],'kernelStatus':'errors' if observed['kernel'].strip() else 'clear'}
    except (OSError,RuntimeError,subprocess.SubprocessError):pass
    baseline_path=core.DATA_ROOT/'app-baseline.json'
    baseline=_entry().read_json(baseline_path) if baseline_path.exists() else None
    snapshot=dict(filesystem,status=status,journal=journal,unfinished=ops.recovery_records(),baseline=baseline)
    original_path=core.DATA_ROOT/'agent-platform'/'original-app.json'
    if original_path.exists():
        original=_entry().read_json(original_path)
        config=_entry().read_json(core.DATA_ROOT/'config.json');old=_entry().read_json(core.DATA_ROOT/'state.json')
        if original.get('targetSha256')==release['sha256'] and original.get('appJobId')==old.get('lastJob') and original.get('nodeId')==config.get('nodeId') and original.get('hostConfigSha256')==core._digest((core.DATA_ROOT/'config.json').read_bytes()):
            authenticated=False
            try:
                if original['journal']['current'] is not None:
                    signed=verify_app_index(core,original['journal']['current'],config['keys'],installed=True)
                    if signed!=original['selected']:raise ValueError('original signed selection differs')
                authenticated=ops.inspect_original(core,original,container)
            except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError):pass
            snapshot.update(original=original,originalAuthenticated=authenticated)
    return snapshot

def original_repair_proof(snapshot):
    original=snapshot.get('original') or {};selected=original.get('selected') or {};journal=original.get('journal') or {};status=snapshot.get('status') or {};current=status.get('current') or {}
    if snapshot.get('originalAuthenticated') is not True or snapshot.get('unfinished') or snapshot.get('journal')!=journal:return False
    if status.get('phase')!=journal.get('phase') or not all(current.get(k)==selected.get(k) for k in ('build','protocol','sha256')):return False
    if journal.get('target') is not None:return False
    if journal.get('phase')=='failed':return journal==dict(schema=1,phase='failed',attempts=0,current=None,previous=None,target=None,backup=None)
    return journal.get('phase') in ('idle','committed','rolled-back')


def repair_proof(snapshot):
    if original_repair_proof(snapshot):return True
    # Reuse the same narrow classifier as the worker. It observes an exact known
    # failed-preparation journal and protected baseline; it changes no history.
    path=Path(__file__).with_name('host-operations.py');_entry().protected(path)
    spec=importlib.util.spec_from_file_location('cc_bootstrap_repair_checks',path)
    ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
    return ops.safe_failed_preparation(snapshot.get('journal'),snapshot.get('status') or {},snapshot.get('unfinished'),snapshot.get('baseline'))

IMAGE_ROOT=Path('/var/lib/cc-runtime-upgrade')


def recover_owned_image(core,data,target_ready,rollback):
    """Recover only the image transaction recorded by this authenticated runner."""
    entry=_entry();path=data/'agent-platform'/'image-transaction.json'
    if not path.exists():return None
    tx=entry.read_json(path);context=entry.read_json(data/'agent-platform'/'original-app.json')
    fields={'schema','appJobId','targetSha256','backup','originalId','targetImage','originalSha256','rollbackSha256','helperSha256'}
    if set(tx) not in (fields,fields|{'candidateConfigurationSha256'}) or tx['schema']!=1 or any(tx.get(k)!=context.get(v) for k,v in [('appJobId','appJobId'),('targetSha256','targetSha256'),('originalId','containerId')]):raise ValueError('image recovery association mismatch')
    backup=Path(tx['backup'])
    import re
    if backup.parent!=IMAGE_ROOT or not re.fullmatch(r'backup-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}',backup.name):raise ValueError('unknown image recovery path')
    entry.protected(backup)
    for name,key in [('original.json','originalSha256'),('rollback.py','rollbackSha256'),('helper.py','helperSha256')]:
        source=backup/name;entry.protected(source)
        if core._digest(source.read_bytes())!=tx[key]:raise ValueError('image recovery source identity changed')
    original=entry.read_json(backup/'original.json')
    if original['Id']!=tx['originalId'] or original['Image']!=context['imageId'] or core._digest(core._canonical({k:original[k] for k in ('Config','HostConfig','Mounts')}))!=context['configurationSha256']:raise ValueError('original image recovery identity changed')
    record=entry.read_json(backup/'record.json')
    if record.get('backup')!=str(backup) or type(record.get('dataChanged')) is not bool:raise ValueError('unknown image cutover record')
    phase=record.get('phase')
    if phase in ('installed','rolled-back'):return phase
    if phase not in ('prepared','admission','stopping','backed-up','starting','restoring'):raise ValueError('unknown image cutover phase')
    if record['dataChanged'] or phase=='backed-up':
        import hashlib
        archive=backup/'data.tar.gz';entry.protected(archive)
        digest=hashlib.sha256()
        with archive.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
        if digest.hexdigest()!=record.get('archiveSha256'):raise ValueError('owned cold backup identity changed')
    # Strong target proof wins after a crash between health verification and save.
    # Its callback authenticates the live v4 target and excludes only this record.
    if target_ready(tx,context):
        record.update(phase='installed',imageId=tx['targetImage'])
        core._write(backup/'record.json',core._canonical(record));return 'installed'
    rollback(tx,context)
    if entry.read_json(backup/'record.json').get('phase')!='rolled-back':raise ValueError('image recovery did not settle')
    return 'rolled-back'


def recover_target_ready(core,program,data,ops,release,tx,context,support):
    """False means a proven owned failure; missing proof raises maintenance."""
    entry=_entry();backup=Path(tx['backup']);original=entry.read_json(backup/'original.json')
    support.CONTAINER=original['Name'].lstrip('/');engine=support.Engine()
    replacement,current=support.recovery_container(engine,backup,original)
    if replacement is None:
        # The existing engine recognizes the original service or an interrupted
        # pre-creation name gap. It rejects a foreign occupant before returning.
        if current is not None and current['Id']!=original['Id']:raise ValueError('unknown image recovery occupant')
        return False
    intent=entry.read_json(backup/'replacement-intent.json')
    labels=current.get('Config',{}).get('Labels') or {};project=labels.get('com.docker.compose.project','')
    if intent.get('originalId')!=original['Id'] or intent.get('image')!=tx['targetImage'] or current.get('Image')!=tx['targetImage'] or labels.get('org.cc-desk-tunnel.bootstrap')!=intent.get('nonce') or not (project=='cc-desk-tunnel' or project.startswith('cc-desk-tunnel-')):raise ValueError('owned candidate identity changed')
    expected=tx.get('candidateConfigurationSha256')
    if not expected or core._digest(core._canonical(dict(Config=current['Config'],HostConfig=current['HostConfig'],Mounts=sorted(current['Mounts'],key=lambda value:core._canonical(value)))))!=expected:raise ValueError('owned candidate configuration is unknown or changed')
    # The reviewed 90-second startup/health wait never starts or stops anything.
    # Transient management failures and a still-starting timeout are unknown.
    try:support.wait_healthy(engine,replacement)
    except support.InstallError as error:
        observed=engine.request('GET','/containers/'+replacement+'/json')
        if observed.get('Image')!=tx['targetImage'] or core._digest(core._canonical(dict(Config=observed['Config'],HostConfig=observed['HostConfig'],Mounts=sorted(observed['Mounts'],key=lambda value:core._canonical(value)))))!=expected:raise ValueError('owned candidate configuration changed during health wait') from error
        state=observed.get('State') or {}
        if state.get('Health',{}).get('Status')=='unhealthy' or state.get('Status')=='exited' and state.get('Running') is False:return False
        raise ValueError('candidate health is not yet proven; maintenance inspection required') from error
    snapshot=fixed_inspection(core,program,ops,release)
    others=[path for path in snapshot['unfinished'] if path!=tx['backup']]
    journal=verified_journal(core,entry.read_json(data/'config.json')['keys'],snapshot['journal'],release)
    if not exact_app_ready(release,snapshot['status'],journal,others):raise ValueError('healthy candidate lacks exact signed readiness proof')
    if not ops.inspect_target(replacement,release):raise ValueError('healthy candidate source inventory is unproven')
    return True


def recover_image_process(core,program,data,ops):
    entry=_entry()
    reference=data/'agent-platform'/'image-transaction.json'
    if reference.exists():
        tx=entry.read_json(reference)
        if any(path!=tx.get('backup') for path in ops.recovery_records()):raise ValueError('unassociated unfinished image recovery record')
        association=entry.read_json(data/'agent-platform'/'adoption.json')
        config=entry.read_json(data/'config.json');old=entry.read_json(data/'state.json')
        if association.get('appJobId')!=tx['appJobId'] or old.get('lastJob')!=tx['appJobId']:raise ValueError('image recovery job changed')
        release=verify_app_index(core,association['response']['bridge']['index'],config['keys'],installed=True)
        if release['sha256']!=tx['targetSha256']:raise ValueError('image recovery target changed')
    def target_ready(tx,context):
        path=Path(tx['backup'])/'helper.py'
        spec=importlib.util.spec_from_file_location('owned_image_health',path)
        support=importlib.util.module_from_spec(spec);spec.loader.exec_module(support)
        return recover_target_ready(core,program,data,ops,release,tx,context,support)
    def rollback(tx,context):
        # Existing reviewed rollback engine; never import worker candidate code.
        backup=Path(tx['backup'])
        module=importlib.util.spec_from_file_location('owned_image_rollback',backup/'rollback.py')
        legacy=importlib.util.module_from_spec(module);module.loader.exec_module(legacy)
        helper_spec=importlib.util.spec_from_file_location('owned_image_helper',backup/'helper.py')
        support=importlib.util.module_from_spec(helper_spec);helper_spec.loader.exec_module(support)
        original=entry.read_json(backup/'original.json')
        support.CONTAINER=original['Name'].lstrip('/')
        data_mount=[m for m in original['Mounts'] if m['Destination']=='/data']
        if len(data_mount)!=1 or data_mount[0]['Type']!='bind' or data_mount[0]['Source']!='/srv/cc-desk-tunnel':raise ValueError('unknown image recovery data binding')
        legacy.DATA=Path(data_mount[0]['Source']);legacy.ROOT=IMAGE_ROOT
        import fcntl
        fd=__import__('os').open(IMAGE_ROOT/'upgrade.lock',__import__('os').O_RDWR|__import__('os').O_CREAT|__import__('os').O_NOFOLLOW,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            legacy.rollback(support,backup)
        finally:__import__('os').close(fd)
    return recover_owned_image(core,data,target_ready,rollback)


def observe(entry):
    """Serialize pre-core recovery and the complete observer in one fixed gate."""
    program=entry.PROGRAM;data=entry.DATA
    try:
        with entry.observer_gate(data):
            try:
                with entry.operation_gate(data):entry.recover_initial(program,data,entry.UNITS,entry.LEGACY,entry.service,boot=False)
            except BlockingIOError:return
            except Exception as error:
                report_recovery_failure(program,data,error);raise
            try:core=entry.load_core()
            except Exception as error:
                report_recovery_failure(program,data,error);raise
            ops_path=program/'host-operations.py';core._protect(ops_path)
            spec=importlib.util.spec_from_file_location('cc_stable_operations',ops_path);ops=importlib.util.module_from_spec(spec);spec.loader.exec_module(ops)
            try:
                with entry.operation_gate(data):recover_image_process(core,program,data,ops)
            except BlockingIOError:return
            except Exception as error:
                report_image_recovery_failure(program,data,error);raise
            observer=AdoptionObserver(core,program,data,entry.UNITS,entry.LEGACY,entry.service,request,
                lambda release:fixed_inspection(core,program,ops,release),lambda:ops.operation_lock(data))
            try:observer.step()
            except Exception as error:
                if observer.local.get('bridgeId') and observer.local.get('attemptId'):observer.failed(error,'maintenance-required')
                raise
    except BlockingIOError:return

def main(argv=None):
    import os
    argv=sys.argv[1:] if argv is None else argv
    if argv!=['observe'] or os.name!='posix' or os.geteuid()!=0:raise ValueError('expected fixed root adoption observer')
    observe(_entry())

if __name__=='__main__':main()
