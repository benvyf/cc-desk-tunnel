#!/usr/bin/env python3
"""Prepare/cut over the signed managed-server image on supported enrolled Ubuntu nodes; keep offline rollback."""
import argparse
from contextlib import contextmanager
import copy
import stat
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import http.client

ROOT = Path('/var/lib/cc-runtime-upgrade')
PROGRAM = Path(__file__).resolve().parents[2]
IDENTITY = json.loads((PROGRAM / 'deploy/managed-server.json').read_bytes())
BUILD, PROTOCOL = IDENTITY['build'], 24
RUNTIME = IDENTITY['runtimeLevel']
RUNTIME_LEVEL = (PROGRAM / 'deploy/docker/runtime-level').read_text().strip()
BASE_LOCK = '09eb7a3b1b2814c72a6362ea2c150f0c3a3d5eb987651c88d3808410e8877de7'
PREVIOUS_LOCK = 'ebf38fe28262d97e04e506b70fde86b89b20431262a5a50ca695c9c886830b92'
LOCK = '71e609c6c17673611360fe51dffc15dc3a205350e0acec6478f058a1ed7e630c'
NODE_VERSION = '24.22.2'
CLI = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
HELPER_SHA = '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0'
BASE_DESCRIPTOR = 'a366fbcf992cf5c76393e42a5f61231f079b13f3e67dffdd9bf673e5c8a3b94a'
BASELINES = {
    '42d161514ab4e12dfe0c753e7d4ff0b257f2c68efc6c0ac5f938aa9c7a469c66': (21, 24),
    'c2b0ab967a219cde7d250b1a39a5793ba57177ddfc0c0f43e021d362181dfed3': (20, 24),
    'a8f103b38a5b270f5a301071780cc2ba0ad9394312b01da4dbc3c74a7a76d5c7': (19, 24),
    '6201439cf95e495eb0741296cf7fe0d286a9c9c738cde335813a6794e3f31b33': (18, 24),
    'bb97e49caf492f82abfe898b6c32bd0b017977d4b29f95e1aed015be5f722682': (16, 24),
    '075f5d15b45156218327abf8341f965c1f5cda8d00e8f75445b59f696b9fcf09': (15, 24),
    '9cb6c0924367efbc291bca06e3f7f331d360e6752bf42db5c5189b903fb0baa7': (14, 24),
    '42df8b7aad3c10c8fa99ec54c70a48637800a7a4d48bdf03704f7b689d7a87f3': (13, 24),
    '1207a4ab33542466f951fc48cc4f76f1ca9b5c5991423535c8d2b1b048912b2d': (12, 24),
    BASE_DESCRIPTOR: (10, 23),
    '245677bc443c97e2e0b2c2a842801b5ade9629d8df8bc438c5f5dc64245be2c4': (11, 23),
}


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def retry_download(download, *args, **kwargs):
    for attempt in range(3):
        try:
            return download(*args, **kwargs)
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as error:
            if isinstance(error, urllib.error.HTTPError) and error.code not in (408, 429, 500, 502, 503, 504):
                raise
            if attempt == 2:
                raise
            print(f'DOWNLOAD_RETRY: transient network error; attempt {attempt+2}/3; original service still running.', flush=True)
            time.sleep(attempt + 1)


def clean_build_cache():
    before = shutil.disk_usage(ROOT).free
    print(f'CLEANUP: unused Docker build cache only; available_before={before} bytes.', flush=True)
    subprocess.run(['docker', 'builder', 'prune', '--all', '--force'], check=True, timeout=300)
    print(f'CLEANUP: available_after={shutil.disk_usage(ROOT).free} bytes; images, containers, data and rollback resources retained.', flush=True)


def check_docker_storage():
    result = subprocess.run(['docker','info','--format','{{.DockerRootDir}}'],check=True,capture_output=True,text=True,timeout=15)
    docker_root = Path(result.stdout.strip())
    need(docker_root.is_absolute(), 'Docker storage path is unavailable; no build requested')
    need(docker_root.stat().st_dev == ROOT.stat().st_dev, 'Docker storage uses an unbudgeted filesystem; no build requested')
    containerd = Path('/var/lib/containerd')
    if containerd.exists():
        need(containerd.stat().st_dev == ROOT.stat().st_dev, 'Docker storage containerd uses an unbudgeted filesystem; no build requested')


def finish_preparation(legacy):
    # Building can consume the space that passed the initial budget. Reclaim
    # build cache again before asking clients to leave or changing the service.
    clean_build_cache()
    legacy.check_space()


def retain_previous_backup(container):
    # Already under upgrade.lock. Failure to validate retention preserves backups;
    # it must not misreport a healthy installed service as a failed cutover.
    try:
        retirement = load('host_backup_retirement', PROGRAM / 'scripts/retire-ubuntu-cc-backups.py')
        retirement.retire(ROOT, container_name=container, apply=True)
    except Exception as error:
        print('RETENTION_PENDING: retirement not completed; required rollback left untouched; inspect audit/records: ' +
              str(error) + '; current service is not stopped.', flush=True)


def check_recovery_records():
    for backup in ROOT.glob('backup-*'):
        record_path = backup / 'record.json'
        if not record_path.is_file():
            raise RuntimeError(f'Incomplete backup record; inspect {backup} before retrying')
        record = json.loads(record_path.read_bytes())
        if record.get('phase') not in ('prepared', 'installed', 'rolled-back') or (
            record.get('phase') == 'prepared' and record.get('dataChanged')):
            raise RuntimeError(f'Unresolved cutover; inspect {backup}; no new upgrade requested')


def verify_release(fresh, data, expected):
    release = fresh.verify_index(data)
    need((release['build'], release['protocol'], release['appVersion'], release['runtimeLevel'],
          release['packageLockSha256'], release['sha256']) ==
         (BUILD, PROTOCOL, '0.3.10', RUNTIME, LOCK, expected),
         'Signed target differs from the authenticated source identity; refresh the update')
    return release


SOURCE_GUARD=load('image_source_guard',PROGRAM/'apps/update-service/web/host-operations.py').SOURCE_GUARD
VERIFY_RUNTIME = SOURCE_GUARD + r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[1]);
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');
const bytes=sourceRegular('/app','SERVER-RELEASE.json',[0]),d=JSON.parse(bytes);
for(const[p,v]of Object.entries(d.files)){const b=sourceRegular('/app',p,[0]);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
for(const p of ['/opt/runtime/node/bin/node','/opt/runtime/cli/bin/claude','/etc/claude-code/managed-settings.json','/etc/claude-code/moderation-node.json']){const s=f.statSync(p);a(s.isFile()&&s.uid===0&&!(s.mode&18))}
const m=JSON.parse(f.readFileSync('/etc/claude-code/moderation-node.json'));a.equal(m.nodeId,process.argv[2]);
const u=new URL(m.endpoint);a(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/cc-updates/v1/moderation/check'&&/^[A-Za-z0-9_-]{43}$/.test(m.token));
const p=JSON.parse(f.readFileSync('/etc/claude-code/managed-settings.json'));a(p.disableAllHooks!==true);
const hook={hooks:[{type:'command',command:'/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts',timeout:10,onFailure:'block'}]};a(p.hooks.UserPromptSubmit.some(g=>require('util').isDeepStrictEqual(g,hook)));
for(const p of [process.env.HOME||'/data/home',process.env.PROXY_DATA_DIR||'/data/state',process.env.CLAUDE_CONFIG_DIR||'/data/home/.claude'])a(require('path').resolve(p).startsWith('/data/'));
const jp='/data/managed-server/journal.json',js=f.lstatSync(jp);a(js.isFile()&&!js.isSymbolicLink()&&js.size<32768);const journal=JSON.parse(f.readFileSync(jp));
let root='/app';if(journal.current!==null){const e=journal.current;a(e&&typeof e.payload==='string');const r=JSON.parse(Buffer.from(e.payload,'base64url')).release;a(/^[a-f0-9]{64}$/.test(r.sha256));root='/data/managed-server/releases/'+r.sha256}
a.equal(f.realpathSync(root),root);const owners=root==='/app'?[0]:[0,1000],selectedBytes=sourceRegular(root,'SERVER-RELEASE.json',owners),selected=JSON.parse(selectedBytes);
for(const[p,v]of Object.entries(selected.files)){a(/^[A-Za-z0-9_.@/+-]{1,200}$/.test(p)&&!p.split('/').some(x=>['','..','.','node_modules'].includes(x)));const path=root+'/'+p;a.equal(f.realpathSync(path),path);const b=sourceRegular(root,p,owners);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
console.log(JSON.stringify({descriptor:hash(bytes),build:d.build,protocol:d.protocol,node:process.versions.node,lock:hash(f.readFileSync('/app/package-lock.json')),journal,selectedDescriptor:hash(selectedBytes),selectedBuild:selected.build,selectedProtocol:selected.protocol,policySha256:hash(Buffer.concat([f.readFileSync('/etc/claude-code/managed-settings.json'),f.readFileSync('/etc/claude-code/moderation-node.json')]))}));"""


def verify_runtime(container, node):
    result = subprocess.run(['docker', 'exec', container, '/opt/runtime/node/bin/node',
        '--env-file=/data/config/service.env', '-e', VERIFY_RUNTIME, CLI, node],
        check=True, capture_output=True, timeout=90)
    return json.loads(result.stdout)


def check_baseline(baseline, release):
    if baseline['descriptor'] == release['descriptorSha256']:
        need((baseline['build'], baseline['protocol'], baseline['node'], baseline['lock']) ==
             (BUILD, PROTOCOL, NODE_VERSION, LOCK), 'Installed candidate runtime differs')
        return True
    need(BASELINES.get(baseline['descriptor']) == (baseline['build'], baseline['protocol']) and
         baseline['node'] == NODE_VERSION and baseline['lock'] == (LOCK if baseline['build'] in (15, 16, 18, 19, 20, 21) else PREVIOUS_LOCK if baseline['build'] in (13, 14) else BASE_LOCK),
         'Unknown original application/runtime baseline; no change')
    return False


def settled_journal(journal):
    fields={'schema','phase','current','previous','target','backup','attempts'}
    if not isinstance(journal,dict) or set(journal)!=fields or type(journal['schema']) is not int or journal['schema']!=1 or type(journal['attempts']) is not int or not 0<=journal['attempts']<=3:return False
    if journal['phase']=='failed':
        return journal==dict(schema=1,phase='failed',attempts=0,current=None,previous=None,target=None,backup=None)
    return journal['phase'] in ('idle','committed','rolled-back') and journal['target'] is None and (journal['backup'] is None or isinstance(journal['backup'],str) and re.fullmatch(r'[0-9]{13}-[a-f0-9]{16}',journal['backup']) is not None)


def authenticate_selected(core,boot,keys,baseline,journal,status):
    need(settled_journal(journal),'Unknown or unsettled application journal; maintenance required')
    if journal['previous'] is not None:
        previous=boot.verify_app_index(core,journal['previous'],keys,installed=True)
        need(BASELINES.get(previous['descriptorSha256'])==(previous['build'],previous['protocol']),'Unknown previous program journal')
    selected=boot.verify_app_index(core,journal['current'],keys,installed=True) if journal['current'] is not None else dict(build=baseline['build'],protocol=baseline['protocol'],sha256=None,descriptorSha256=baseline['descriptor'],packageLockSha256=baseline['lock'])
    need((baseline['selectedDescriptor'],baseline['selectedBuild'],baseline['selectedProtocol'])==(selected['descriptorSha256'],selected['build'],selected['protocol']),'Selected program differs from authenticated journal')
    need(selected['packageLockSha256']==baseline['lock'],'Selected dependencies differ from immutable runtime')
    current=status.get('current') or {}
    need(all(current.get(k)==selected[k] for k in ('build','protocol','sha256')) and status.get('phase')==journal['phase'],'Live program differs from authenticated selection')
    if journal['current'] is not None:
        need(selected['runtimeLevel']=='node24-cli2.1.295-v3' and BASELINES.get(selected['descriptorSha256'])==(selected['build'],selected['protocol']),'Unsupported selected program identity')
    return selected


def host_preflight(ops):
    snapshot=ops.host_snapshot();phase,reason=ops.classify_host(snapshot)
    if phase=='dependencies':
        print('CC_HOST_STAGE: prepare; preparing authenticated Ubuntu BuildKit dependency',flush=True)
        subprocess.run(ops.buildkit_command(),check=True,timeout=600,env={**os.environ,'DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_MODE':'l'})
        phase,reason=ops.classify_host(ops.host_snapshot())
    if phase=='maintenance-required':
        print('CC_HOST_STAGE: maintenance; '+ops.redact(snapshot.get('kernel',''))[-2400:],flush=True)
    need(phase=='ready',phase+': '+reason)


HOST_DATA = Path('/var/lib/cc-host-updater')
HOST_PROGRAM = Path('/opt/cc-host-platform')
HOST_UNITS = Path('/etc/systemd/system')


@contextmanager
def operation_gate(data=HOST_DATA):
    """Shared gate precedes upgrade.lock. Never reopen an inherited flock."""
    import fcntl
    data.mkdir(mode=0o700,exist_ok=True)
    for parent in (data,*data.parents):
        metadata=parent.lstat()
        need(not stat.S_ISLNK(metadata.st_mode) and stat.S_ISDIR(metadata.st_mode) and metadata.st_uid==0 and (not metadata.st_mode&0o022 or parent!=data and metadata.st_mode&stat.S_ISVTX),'Unprotected operation lock directory')
    path=data/'operation.lock'
    inherited=os.environ.get('CC_HOST_OPERATION_LOCK_FD')
    if inherited is not None:
        need(re.fullmatch(r'[0-9]+',inherited) is not None,'Invalid inherited operation lock descriptor')
        fd=int(inherited);info=os.fstat(fd);fixed=path.lstat()
        need(stat.S_ISREG(info.st_mode) and stat.S_ISREG(fixed.st_mode) and info.st_uid==fixed.st_uid==0 and not (info.st_mode|fixed.st_mode)&0o077 and (info.st_dev,info.st_ino)==(fixed.st_dev,fixed.st_ino),'Unprotected or foreign inherited operation lock')
        evidence=Path('/proc/self/fdinfo/'+str(fd)).read_text()
        need(re.search(r'^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+',evidence,re.M) is not None,'The inherited operation lock is not held exclusively')
        yield fd
        return
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o077,'Unprotected operation lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield fd
    finally:os.close(fd)


def prepare_adoption(core,boot,source,descriptor,config,old,release,response,program=HOST_PROGRAM,data=HOST_DATA,units=HOST_UNITS,original_context=None):
    """Durable observer, signed worker and timer must precede any app cutover."""
    state=core._state(data)
    need(not state.get('current') and not state.get('floor'),'Initial adoption cannot replace active platform')
    need(state.get('phase','steady') in ('steady','staged') and state.get('previous') is None,'Unfinished platform recovery blocks image migration')
    initial=data/'agent-platform'/'initial-unit.json'
    if initial.exists():
        entry=boot._entry();transaction=entry.read_json(initial)
        need(transaction.get('phase')=='rolled-back','Unfinished initial activation blocks image migration')
    web=source/'apps/update-service/web'
    sources={name:(web/name).read_bytes() for name in boot.SOURCE_FILES}
    hashes={name:descriptor['files']['apps/update-service/web/'+name]['sha256'] for name in boot.SOURCE_FILES}
    boot.stage_sources(core,program,data,sources,hashes,config['keys'])
    boot.publish_sources(core,program,data)
    probe=(web/'server-upgrade.cjs').read_bytes()
    boot.stage_probe(core,program,probe,descriptor['files']['apps/update-service/web/server-upgrade.cjs']['sha256'])
    # Use the stable stdlib observer lock: a previous timer cannot activate the old
    # attempt while this runner binds a newly confirmed application job.
    entry=load('prepared_adoption_entry',program/'host-bootstrap-entry.py')
    with entry.observer_gate(data):
        observer=boot.AdoptionObserver(core,program,data,units,Path('/opt/cc-host-updater'),entry.service,boot.request,None,None)
        prior=observer.local
        if prior.get('appJobId') not in (None,old['lastJob']):
            need(prior.get('phase') in ('new','waiting-app','failed','maintenance-required'),'Prior adoption activation requires recovery')
            observer.local={'schema':1,'phase':'new'}
        observer.local['appJobId']=old['lastJob']
        bridge,attempt,target=observer.validate(response,old)
        need(all(target[k]==release[k] for k in ('build','protocol','sha256','descriptorSha256')),'Adoption target differs from signed image target')
        need(attempt['startAllowed'] is True,'Adoption continuation was not authorized')
        need(time.time()<core._date(attempt['continuationUntil']).timestamp(),'Adoption continuation expired')
        if prior.get('appJobId') not in (None,old['lastJob']):
            prior_path=data/'agent-platform'/'adoption.json';core._protect(prior_path);prior_raw=prior_path.read_bytes()
            core._write(prior_path.with_name('adoption.previous-'+core._digest(prior_raw)[:16]+'.json'),prior_raw)
            transaction=data/'agent-platform'/'image-transaction.json'
            if transaction.exists():
                def interrupted(*args):raise RuntimeError('Prior owned image transaction requires recovery')
                need(boot.recover_owned_image(core,data,interrupted,interrupted) in ('installed','rolled-back'),'Prior owned image transaction is unknown')
                raw=transaction.read_bytes();core._write(transaction.with_name('image-transaction.previous-'+core._digest(raw)[:16]+'.json'),raw)
                transaction.unlink();core._sync_dir(transaction.parent)
            previous_context=data/'agent-platform'/'original-app.json'
            if previous_context.exists():
                core._protect(previous_context);raw=previous_context.read_bytes()
                core._write(previous_context.with_name('original-app.previous-'+core._digest(raw)[:16]+'.json'),raw)
        observer.local.update(bridgeId=bridge['id'],attemptId=attempt['id'],response=response,phase='waiting-app')
        observer.local['candidate']=observer.stage(attempt)
        observer.save()
        if original_context is not None:
            need(original_context['appJobId']==old['lastJob'] and original_context['targetSha256']==release['sha256'],'Original proof association differs')
            core._write(data/'agent-platform'/'original-app.json',core._canonical(original_context))
        boot.install_support_units(core,units,data)
        journal=data/'agent-platform'/'support-setup.json'
        for phase,args in [('reload',['systemctl','daemon-reload']),('enable-timer',['systemctl','enable','cc-host-adoption.timer']),('start-timer',['systemctl','start','cc-host-adoption.timer']),('verify-timer',['systemctl','is-active','--quiet','cc-host-adoption.timer'])]:
            core._write(journal,core._canonical({'schema':1,'phase':phase}))
            subprocess.run(args,check=True,capture_output=True,timeout=30)
        core._write(journal,core._canonical({'schema':1,'phase':'ready'}))
    return observer.local


PROC_ROOT=Path('/proc')


def source_regular(root,relative,owners):
    need(re.fullmatch(r'[A-Za-z0-9_.@/+-]{1,200}',relative) is not None and not any(part in ('','.','..','node_modules') for part in relative.split('/')),'Unsafe source path')
    path=root/relative;metadata=path.lstat()
    need(stat.S_ISREG(metadata.st_mode) and metadata.st_uid in owners and not metadata.st_mode&0o022,'Untrusted source ownership or mode')
    directory=path.parent
    while True:
        info=directory.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid in owners and not info.st_mode&0o022,'Untrusted source directory')
        if directory==root:break
        directory=directory.parent
    return path.read_bytes()


def verify_frozen_sources(baseline,selected,current,data):
    """Host reads only: the container is paused, so no docker-exec can enter it."""
    pid=current.get('State',{}).get('Pid')
    need(type(pid) is int and pid>0,'Unknown frozen source process')
    base=PROC_ROOT/str(pid)/'root'/'app'
    def inventory(root,digest,owners):
        raw=source_regular(root,'SERVER-RELEASE.json',owners)
        need(hashlib.sha256(raw).hexdigest()==digest,'Frozen source descriptor changed')
        descriptor=json.loads(raw)
        for relative,expected in descriptor['files'].items():
            content=source_regular(root,relative,owners)
            need(len(content)==expected['size'] and hashlib.sha256(content).hexdigest()==expected['sha256'],'Frozen source inventory changed')
    inventory(base,baseline['descriptor'],(0,))
    journal=source_regular(data/'managed-server','journal.json',(0,1000))
    need(json.loads(journal)==baseline['journal'],'Frozen source journal changed')
    if selected['sha256'] is not None:
        need(re.fullmatch('[a-f0-9]{64}',selected['sha256']) is not None,'Unknown selected source digest')
        releases=data/'managed-server'/'releases';metadata=releases.lstat()
        need(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid in (0,1000) and not metadata.st_mode&0o022,'Untrusted source release directory')
        directory=releases/selected['sha256']
        inventory(directory,selected['descriptorSha256'],(0,1000))


def record_candidate_create(core,data,config,original,policy):
    """Persist the known CREATE configuration before Docker can create it."""
    path=data/'agent-platform'/'image-transaction.json';core._protect(path)
    tx=core._json(path.read_bytes());backup=Path(tx['backup'])
    core._protect(backup/'replacement-intent.json');intent=core._json((backup/'replacement-intent.json').read_bytes())
    need(intent['originalId']==original['Id'] and intent['image']==tx['targetImage']==config['Image'] and re.fullmatch('[a-f0-9]{32}',intent['nonce']),'Owned candidate CREATE association differs')
    expected={k:copy.deepcopy(v) for k,v in config.items() if k not in ('HostConfig','NetworkingConfig')}
    expected['Labels']={**(expected.get('Labels') or {}),'org.cc-desk-tunnel.bootstrap':intent['nonce']}
    mounts=copy.deepcopy(original['Mounts'])
    for mount in mounts:
        if mount['Destination']=='/etc/claude-code':mount['Source']=str(policy)
    mounts.sort(key=lambda value:core._canonical(value))
    tx['candidateConfigurationSha256']=core._digest(core._canonical({'Config':expected,'HostConfig':config['HostConfig'],'Mounts':mounts}))
    core._write(path,core._canonical(tx))
    return tx['candidateConfigurationSha256']


def dockerfile(base):
    return f'''FROM {base}
USER root
RUN rm -rf /app && install -d -o ccdesktunnel -g ccdesktunnel /app
ENV PATH=/opt/runtime/node/bin:/opt/runtime/cli/bin:$PATH
COPY --chown=ccdesktunnel:ccdesktunnel program/ /app/
WORKDIR /app
USER ccdesktunnel
RUN npm_config_nodedir=/opt/runtime/node npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol --no-audit --no-fund && npm cache clean --force
USER root
COPY program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint
COPY program/deploy/docker/healthcheck.mjs /app/healthcheck.mjs
COPY program/deploy/docker/runtime-level /opt/runtime/level
RUN /opt/runtime/node/bin/node /app/deploy/docker/terminal-runtime.mjs --record && chmod 755 /usr/local/bin/proxy-entrypoint && chown -R root:root /app /opt/runtime/node && chmod -R go-w /app /opt/runtime/node
USER ccdesktunnel
WORKDIR /data/workspace
'''


def candidate_check(image, release):
    script = SOURCE_GUARD + r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(process.versions.node,'24.22.2');a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[2]);
const bytes=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(hash(bytes),process.argv[1]);const d=JSON.parse(bytes);
for(const[p,v]of Object.entries(d.files)){const b=sourceRegular('/app',p,[0]);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
a.equal(f.readFileSync('/opt/runtime/level','utf8').trim(),process.argv[3]);
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');"""
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint',
        '/opt/runtime/node/bin/node', image, '-e', script, release['descriptorSha256'], CLI, RUNTIME_LEVEL],
        check=True, capture_output=True, timeout=90)
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint',
        '/opt/runtime/node/bin/node', image, '/app/deploy/docker/terminal-runtime.mjs', '--probe'],
        check=True, capture_output=True, timeout=30)


def live_probe(container):
    script='const target='+json.dumps({'probe':True,'protocol':PROTOCOL})+';\n'+(PROGRAM/'apps/update-service/web/server-upgrade.cjs').read_text()
    raw=subprocess.run(['docker','exec',container,'/opt/runtime/node/bin/node','--env-file=/data/config/service.env','--input-type=commonjs','-e',script],check=True,capture_output=True,timeout=20).stdout
    need(len(raw)<=128*1024,'Management response exceeds limit')
    value=json.loads(raw.strip().splitlines()[-1])
    need(value.get('check',{}).get('current')==value.get('current'),'Management status/check selection differs')
    return value


def enrolled_context(review,node):
    path=HOST_DATA/'config.json'
    if not path.exists():return None
    review.protected(HOST_DATA,True);review.protected(path)
    config=json.loads(path.read_bytes())
    need(config.get('nodeId')==node and config.get('origin')==IDENTITY['origin'] and config.get('keys')==IDENTITY['keys'] and re.fullmatch(r'[A-Za-z0-9_-]{43}',str(config.get('token'))),'Enrolled host identity or publisher trust differs')
    return config


def selected_container(b,review,node,config):
    if config is None:
        need(node in review.NODES,'Manual image migration requires a reviewed node profile')
        return review.NODES[node]
    ids=subprocess.run(['docker','ps','--filter','label=com.docker.compose.service=proxy','--format','{{.ID}}'],check=True,capture_output=True,text=True,timeout=15).stdout.split()
    found=[]
    for identity in ids:
        need(re.fullmatch('[a-f0-9]{12,64}',identity),'Invalid Docker container identity')
        info=b.Engine().request('GET','/containers/'+identity+'/json')
        labels=info.get('Config',{}).get('Labels') or {}
        project=labels.get('com.docker.compose.project','')
        if project=='cc-desk-tunnel' or project.startswith('cc-desk-tunnel-'):found.append(identity)
    need(len(found)==1,'Expected exactly one enrolled CC proxy container')
    return found[0]


def wait_idle(legacy,b,original,deadline=600):
    started=time.monotonic()
    while True:
        try:legacy.check_idle(b,original);return
        except RuntimeError as error:
            # Only the reviewed observational activity refusals are waitable.
            if not str(error).startswith(('Finish Claude tasks','Finish active Claude','CC has an active')):raise
            need(time.monotonic()-started<deadline,'Activity wait expired; original service retained')
            print('CC_HOST_STAGE: prepare; WAITING: active tasks or terminals; original service remains running',flush=True)
            time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--cleanup', action='store_true', help='Compatibility flag; safe build-cache cleanup now always runs')
    args = parser.parse_args()
    confirmed = json.loads(args.release.read_bytes())
    args.sha256 = confirmed['sha256']
    review = load('message_upgrade_support', PROGRAM / 'scripts/upgrade-message-review.py')
    node = socket.gethostname().split('.')[0]
    need(os.geteuid() == 0, 'Image migration requires Linux root')
    config=enrolled_context(review,node)
    config_bytes=(HOST_DATA/'config.json').read_bytes() if config is not None else None
    need(config is None or json.loads(config_bytes)==config,'Enrolled configuration changed during inspection')
    need(re.fullmatch('[a-f0-9]{64}', args.sha256), 'Invalid target digest')
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    review.protected(ROOT, True)
    need(not ROOT.stat().st_mode & 0o077, 'Expected a private root-only upgrade directory')
    import fcntl
    with operation_gate(HOST_DATA), (ROOT / 'upgrade.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_recovery_records()
        ops=load('signed_host_operations',PROGRAM/'apps/update-service/web/host-operations.py')
        helper = PROGRAM / 'apps/update-service/web/server-bootstrap.py'
        need(hashlib.sha256(helper.read_bytes()).hexdigest() == HELPER_SHA, 'Support helper changed')
        shutil.copyfile(helper, ROOT / 'helper.py')
        b = load('runtime_bootstrap_support', ROOT / 'helper.py')
        fresh = load('runtime_signed_release', PROGRAM / 'apps/update-service/web/fresh-install.py')
        fresh.ROOT = ROOT
        # Verification only: the runtime binaries are inherited and authenticated.
        fresh.NODE_RUNTIMES[RUNTIME]=(NODE_VERSION,fresh.NODE_RUNTIMES['node24-cli2.1.295-v3'][1])
        for module in (b, fresh):
            original_download = module.download
            module.download = lambda *a, _download=original_download, **kw: retry_download(_download, *a, **kw)
        b.CONTAINER = selected_container(b,review,node,config)
        original = b.Engine().request('GET', '/containers/' + b.CONTAINER + '/json')
        source = review.adapt(b, original)
        b.validate_runtime(original)
        need(original.get('State',{}).get('Health',{}).get('Status')=='healthy','Original container is not healthy; no image preparation requested')
        baseline = verify_runtime(b.CONTAINER, node)
        core=load('signed_platform_verifier',PROGRAM/'apps/update-service/web/host-platform.py')
        boot=load('signed_adoption_bootstrap',PROGRAM/'apps/update-service/web/host-bootstrap.py')
        status=live_probe(b.CONTAINER)
        selected=authenticate_selected(core,boot,IDENTITY['keys'],baseline,baseline['journal'],status)
        release = verify_release(fresh, b.download('/cc-updates/server/v1/channels/pilot/linux-x64.json', 128 * 1024), args.sha256)
        need(release == confirmed, 'Published release changed; refresh and confirm again')
        if check_baseline(baseline, release):
            b.live_status(b.CONTAINER, release)
            print(f'ALREADY_INSTALLED: Build {BUILD} / protocol {PROTOCOL} / Node {NODE_VERSION}; no change.')
            return
        host_preflight(ops)
        legacy = load('runtime_cutover', PROGRAM / 'scripts/install-cc-space-037.py')
        legacy.ROOT, legacy.DATA, legacy.NODE = ROOT, b.DATA, node
        wait_idle(legacy,b,original)
        if baseline['build'] >= 14:
            retain_previous_backup(b.CONTAINER)
        # All entrypoints, including the management-center host updater, must
        # reclaim safe cache without relying on callers to pass --cleanup.
        keep_image = f'cc-space-runtime:build{BUILD}-' + release['sha256'][:12] + '-' + original['Image'].split(':')[-1][:12]
        cleanup = load('host_update_cleanup', PROGRAM / 'deploy/host-update/cleanup.py')
        cleanup.clean(ROOT, PROGRAM, keep_image)
        legacy.check_space(reserve=2 * 1024**3)
        # The old CLI binary, SDK version and read-only policy were authenticated above. Never execute Claude.
        def reauthenticate(container):
            if config_bytes is not None:
                review.protected(HOST_DATA/'config.json')
                need((HOST_DATA/'config.json').read_bytes()==config_bytes,'Enrolled configuration changed during preparation')
            current=verify_runtime(container,node)
            need(current==baseline,'Application source or journal changed during preparation')
            authenticate_selected(core,boot,IDENTITY['keys'],current,current['journal'],live_probe(container))
        b.runtime_and_policy=reauthenticate
        work = Path(tempfile.mkdtemp(prefix=f'build{BUILD}-', dir=ROOT)); work.chmod(0o755)
        program = work / 'program'
        print(f'CC_HOST_STAGE: prepare; 1/4 Verifying signed Build {BUILD}; current service remains running.',flush=True)
        archive = b.download(f"/cc-updates/server/v1/artifacts/{BUILD}/linux-x64/cc-desk-tunnel-server-{release['appVersion']}-build{BUILD}.tar.gz", 64 * 1024**2)
        b.unpack(archive, program, release)
        need(hashlib.sha256((program / 'package-lock.json').read_bytes()).hexdigest() == LOCK and
             (program / 'deploy/docker/runtime-level').read_text().strip() == RUNTIME_LEVEL, 'Candidate runtime/dependencies differ')
        identity = json.loads((program / 'deploy/managed-server.json').read_bytes())
        need(identity['runtimeLevel'] == RUNTIME and identity['keys'] == b.KEYS and identity['origin'] == b.ORIGIN,
             'Candidate trust or runtime identity differs')
        if config is not None:
            platform=core._state(HOST_DATA)
            if not platform.get('current') and not platform.get('floor'):
                state_path=HOST_DATA/'state.json';review.protected(state_path)
                old=core._json(state_path.read_bytes())
                need(old.get('report',{}).get('state')=='running' and old.get('report',{}).get('id')==old.get('lastJob'),'No active legacy center job; application cutover is blocked')
                need(all((old.get('target') or {}).get(k)==release[k] for k in ('build','protocol','sha256','descriptorSha256')),'Legacy job target differs')
                response=boot.request(config,'/cc-host/v2/adoption',{'nodeId':node,'phase':'prepared','appJobId':old['lastJob']})
                descriptor=core._json((program/'SERVER-RELEASE.json').read_bytes())
                original_context={'schema':1,'nodeId':node,'appJobId':old['lastJob'],'targetSha256':release['sha256'],'containerId':original['Id'],'imageId':original['Image'],
                    'hostConfigSha256':core._digest(config_bytes),'configurationSha256':core._digest(core._canonical({k:original[k] for k in ('Config','HostConfig','Mounts')})),
                    'baseline':{k:baseline[k] for k in ('build','protocol','descriptor','node','lock','selectedDescriptor','selectedBuild','selectedProtocol','policySha256')},'selected':selected,'journal':baseline['journal']}
                prepare_adoption(core,boot,program,descriptor,config,old,release,response,original_context=original_context)
        # Recheck after extracting the signed program, before a costly build.
        legacy.check_space(reserve=2 * 1024**3)
        base = 'cc-space-runtime-base:' + original['Image'].split(':')[-1][:12]
        image = f'cc-space-runtime:build{BUILD}-' + release['sha256'][:12] + '-' + original['Image'].split(':')[-1][:12]
        subprocess.run(['docker', 'tag', original['Image'], base], check=True, capture_output=True)
        inspected = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True)
        if inspected.returncode:
            check_docker_storage()
            (work / 'Dockerfile').write_text(dockerfile(base))
            (work / '.dockerignore').write_text('*\n!Dockerfile\n!program/\n!program/**\n!runtime/\n!runtime/**\n')
            review.logged(['docker','build','--pull=false','-t',image,str(work)],work/'build.log',timeout=1800,env={**os.environ,'DOCKER_BUILDKIT':'1'})
        candidate, old = json.loads(subprocess.run(['docker', 'image', 'inspect', image, original['Image']],
            check=True, capture_output=True).stdout)
        layers = old['RootFS']['Layers']
        need(layers and candidate['RootFS']['Layers'][:len(layers)] == layers, 'Candidate base layers changed')
        image = candidate['Id']
        candidate_check(image, release)
        b.offline_preflight(image, work, release, work / 'preflight.log')
        policy = work / 'policy'
        source_hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
        review.policy_copy(source, policy, program)
        print('2/4 Offline preflight passed; Node 24.22.2 and unchanged official CLI verified.', flush=True)
        host_preflight(ops)
        finish_preparation(legacy)
        if not args.install:
            print('PREPARED: no service changed. Use --install for the idle cutover.')
            return
        legacy.ROOT, legacy.NODE, legacy.BASE, legacy.IMAGE = ROOT, node, original['Image'], image
        legacy.DESCRIPTOR, legacy.TARGET = release['descriptorSha256'], {'build': BUILD, 'protocol': PROTOCOL}
        clone = b.clone_config
        def validate_cutover(current):
            verify_frozen_sources(baseline,selected,current,b.DATA)
            if config_bytes is not None:
                review.protected(HOST_DATA/'config.json')
                need((HOST_DATA/'config.json').read_bytes()==config_bytes,'Enrolled configuration changed before cutover')
            need(review.same_configuration(current, original), 'Original configuration changed')
            now = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
            need(now == source_hashes, 'Administrator policy changed; rollback required')
        b.validate_cutover = validate_cutover
        def clone_candidate(current, target):
            need(review.same_configuration(current,original),'Original configuration changed')
            return review.with_policy(clone(current, target), policy)
        b.clone_config = clone_candidate
        print('CC_HOST_STAGE: apply; 3/4 Final idle admission, cold backup and image/policy cutover.',flush=True)
        if config is not None and not core._state(HOST_DATA).get('current'):
            original_save=legacy.save
            expected_configuration=None
            clone_prepared=b.clone_config
            def clone_owned(current,target):
                nonlocal expected_configuration
                prepared=clone_prepared(current,target)
                expected_configuration=record_candidate_create(core,HOST_DATA,prepared,current,policy)
                return prepared
            b.clone_config=clone_owned
            def save_owned(support,backup,record):
                original_save(support,backup,record)
                reference={'schema':1,'appJobId':original_context['appJobId'],'targetSha256':release['sha256'],'backup':str(backup),'originalId':original['Id'],'targetImage':image,
                    'originalSha256':core._digest((backup/'original.json').read_bytes()),'rollbackSha256':core._digest((backup/'rollback.py').read_bytes()),'helperSha256':core._digest((backup/'helper.py').read_bytes()),'candidateConfigurationSha256':expected_configuration}
                core._write(HOST_DATA/'agent-platform'/'image-transaction.json',core._canonical(reference))
            legacy.save=save_owned
        legacy.install(b, disconnect_clients=True)
        retain_previous_backup(b.CONTAINER)
        print(f'CC_HOST_STAGE: verify; 4/4 SUCCESS: {node} / Build {BUILD} / protocol {PROTOCOL} / Node {NODE_VERSION}.',flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) or type(error).__name__ == 'InstallError' else type(error).__name__
        print('Upgrade stopped: ' + reason + '. Keep the backup directory and inspect the local log.', file=sys.stderr)
        for frame in traceback.extract_tb(error.__traceback__):
            print('  ' + Path(frame.filename).name + ':' + str(frame.lineno) + ' in ' + frame.name, file=sys.stderr)
        raise SystemExit(1)
