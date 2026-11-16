"""Fixed host checks and local log collection; never accepts commands from jobs."""
from contextlib import contextmanager
import json
import hashlib
import importlib.util
import sqlite3
import os
from pathlib import Path
import platform
import re
import stat
import subprocess

RUNTIME = Path('/var/lib/cc-runtime-upgrade')


def output(args, timeout=20):
    return subprocess.run(args,check=True,capture_output=True,text=True,timeout=timeout,env={**os.environ,'LC_ALL':'C'}).stdout


def classify_host(host):
    if not host['root_rw'] or re.search(r'EXT4-fs (?:error|warning)|(?:Buffer )?I/O error|Remounting filesystem read-only|Aborting journal',host['kernel'],re.I):
        return 'maintenance-required','Filesystem errors or read-only root require administrator maintenance'
    if (host['os_id'],host['os_version'],host['arch']) != ('ubuntu','24.04','x86_64'):
        return 'failed','Automatic host updates support Ubuntu 24.04 x64 only'
    if not host['docker'] or not host['storage_same']:
        return 'failed','Docker unavailable or storage spans unsupported filesystems'
    docker_version=re.fullmatch(r'(26|27|28|29)\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?',str(host.get('docker_version','')))
    if not docker_version or host.get('storage_driver') not in ('overlay2','overlayfs'):
        return 'failed','Unsupported or unknown Docker engine version or storage driver; no engine migration requested'
    if host['free_bytes'] < 2*1024**3 or host['free_inodes'] < 50000:
        return 'failed','Insufficient free storage or inodes for preparation'
    if not host['buildkit']: return 'dependencies','BuildKit dependency is missing'
    buildx=re.fullmatch(r'(?:github\.com/docker/buildx\s+)?v?(0)\.([0-9]+)\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?(?:\s+[A-Za-z0-9._+~-]+)?',str(host.get('buildkit_version','')))
    if not buildx or int(buildx[2])<12:return 'failed','Unsupported or unknown BuildKit version; no engine migration requested'
    return 'ready',''


def filesystem_snapshot():
    # Filter the entire current boot before bounding output. A tail of ordinary
    # lines can hide an early EXT4 checksum failure.
    expression='EXT4-fs (error|warning)|I/O error|Remounting filesystem read-only|Aborting journal'
    result=subprocess.run(['journalctl','-k','-b','--no-pager','-o','cat','--grep='+expression],capture_output=True,text=True,timeout=20,env={**os.environ,'LC_ALL':'C'})
    if result.returncode not in (0,1) or len(result.stdout)>1024*1024:raise RuntimeError('Kernel filesystem diagnostics unavailable or truncated; no operation requested')
    # journalctl returns 1 for a successful search with no matching entries.
    if result.returncode==1 and result.stderr.strip():raise RuntimeError('Kernel filesystem diagnostics are not readable')
    mount=json.loads(output(['findmnt','--json','--target','/','--output','OPTIONS']))['filesystems'][0]
    return {'root_rw':'rw' in mount['options'].split(','),'kernel':result.stdout}


def host_snapshot():
    release = dict(line.split('=',1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    filesystem=filesystem_snapshot()
    root_stat=os.statvfs('/')
    docker=False; same=False; buildkit=False;docker_version=None;buildkit_version=None;driver=None;storage=None
    try:
        info=json.loads(output(['docker','info','--format','{{json .}}']))
        storage=Path(info.get('DockerRootDir',''))
        docker_version=str(info.get('ServerVersion',''))[:120];driver=str(info.get('Driver',''))[:120]
        docker=storage.is_absolute()
        same=docker and storage.stat().st_dev==Path('/').stat().st_dev
        for path in (RUNTIME,Path('/var/lib/containerd')):
            if path.exists() and path.stat().st_dev!=Path('/').stat().st_dev: same=False
        buildkit_version=output(['docker','buildx','version']).strip()[:160]; buildkit=True
    except (OSError,subprocess.SubprocessError): pass
    return dict(docker_version=docker_version,buildkit_version=buildkit_version,storage_driver=driver,docker_root=str(storage) if storage else None,os_id=release.get('ID','').strip('"'),os_version=release.get('VERSION_ID','').strip('"'),arch=platform.machine(),docker=docker,storage_same=same,buildkit=buildkit,root_rw=filesystem['root_rw'],free_bytes=root_stat.f_bavail*root_stat.f_frsize,free_inodes=root_stat.f_favail,kernel=filesystem['kernel'])


def validate_apt_plan(text, package, version):
    if package != 'docker-buildx' or not re.fullmatch(r'[0-9][A-Za-z0-9.+:~_-]*',version): raise RuntimeError('Unsupported dependency target')
    upstream=re.match(r'^(?:[0-9]+:)?0\.([0-9]+)\.[0-9]+(?:[-+~.]|$)',version)
    if not upstream or int(upstream[1])<12:raise RuntimeError('Unsupported BuildKit dependency version')
    installed=[]; configured=[]
    for line in text.splitlines():
        if re.match(r'^(Remv|Purg)',line): raise RuntimeError('Dependency plan removes packages')
        if line.startswith(('Inst ','Conf ')):
            match=re.fullmatch(r'(Inst|Conf) (docker-buildx)(?: \[[^\]]+\])? \(([^ ]+) Ubuntu:24\.04/noble(?:-updates|-security)? \[amd64\]\)',line)
            if not match or match[3]!=version: raise RuntimeError('Dependency plan includes an unexpected package, version or origin')
            (installed if match[1]=='Inst' else configured).append(match[2])
        elif re.match(r'^(E:|W:|WARNING:)',line): raise RuntimeError('Dependency resolver warning')
    if installed!=[package] or configured!=[package]: raise RuntimeError('Expected one exact BuildKit installation')


def buildkit_command():
    # Ubuntu archive policy must be authenticated by the existing APT configuration.
    policy=output(['apt-cache','policy','docker-buildx'])
    match=re.search(r'^  Candidate: ([^\s]+)$',policy,re.M)
    if not match or match[1]=='(none)': raise RuntimeError('No trusted Ubuntu BuildKit candidate is available')
    if not re.search(r'\bhttps?://[^\s]+\s+noble(?:-updates|-security)?/[^\s]+ amd64 Packages',policy):
        raise RuntimeError('BuildKit candidate is not from the existing Ubuntu archive')
    # Reject authentication overrides, even if the simulated resolver succeeds.
    settings=output(['apt-config','dump'])
    if re.search(r'(?:AllowUnauthenticated|AllowInsecureRepositories|AllowDowngradeToInsecureRepositories)\s+"(?:true|1)"',settings,re.I):
        raise RuntimeError('APT authentication has been disabled')
    sources=[]
    for path in [Path('/etc/apt/sources.list'),*Path('/etc/apt/sources.list.d').glob('*.list'),*Path('/etc/apt/sources.list.d').glob('*.sources')]:
        if path.exists(): sources.append(path.read_text())
    if re.search(r'trusted\s*=\s*yes|Trusted:\s*yes|allow-insecure\s*=\s*yes', '\n'.join(sources),re.I): raise RuntimeError('Unauthenticated APT source configuration')
    args=['apt-get','-o','Dpkg::Options::=--force-confold','--no-remove','--no-install-recommends','install','docker-buildx='+match[1]]
    validate_apt_plan(output([*args[:1],'-s',*args[1:]]),'docker-buildx',match[1])
    return [*args[:1],'-y',*args[1:]]


def safe_failed_preparation(journal,status,unfinished,baseline=None):
    required=dict(schema=1,phase='failed',attempts=0,current=None,previous=None,target=None,backup=None)
    diagnostic=status.get('hostDiagnostics') or {};base=diagnostic.get('base') or {};program=diagnostic.get('program') or {};activity=diagnostic.get('activity') or {}
    fields={'tasks','terminals','reviews','pending','registering','connections'}
    current=status.get('current') or {}
    if not isinstance(baseline,dict) or set(baseline)!={'schema','build','protocol','descriptorSha256'} or type(baseline['schema']) is not int or baseline['schema']!=1 or type(baseline['build']) is not int or baseline['build']<1 or type(baseline['protocol']) is not int or baseline['protocol']<1 or not re.fullmatch('[a-f0-9]{64}',str(baseline['descriptorSha256'])):return False
    known={k:baseline[k] for k in ('build','protocol','descriptorSha256')}
    return (journal == required and type(journal.get('schema')) is int and type(journal.get('attempts')) is int and not unfinished and status.get('phase')=='failed' and
        type(diagnostic.get('schema')) is int and diagnostic.get('schema')==1 and diagnostic.get('idle') is True and diagnostic.get('ready') is True and diagnostic.get('serving') is True and
        current.get('build')==known['build'] and current.get('protocol')==known['protocol'] and known['descriptorSha256']==status.get('descriptorSha256') and
        base.get('build')==status.get('current',{}).get('build') and base.get('descriptorSha256')==status.get('descriptorSha256') and
        program.get('build')==base.get('build') and program.get('protocol')==known['protocol'] and program.get('descriptorSha256')==base.get('descriptorSha256') and
        set(activity)==fields and all(type(v) is int and v>=0 for v in activity.values()) and all(activity[k]==0 for k in fields-{'connections'}))


def recovery_records(root=RUNTIME):
    unfinished=[]
    for path in root.glob('backup-*'):
        try:
            protected(path,True); protected(path/'record.json')
            record=json.loads((path/'record.json').read_text())
            if record.get('phase') not in ('prepared','installed','rolled-back') or (record.get('phase')=='prepared' and record.get('dataChanged')): unfinished.append(str(path))
        except (OSError,ValueError,RuntimeError): unfinished.append(str(path))
    return unfinished


@contextmanager
def operation_lock(root):
    import fcntl
    path=root/'operation.lock'
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o077: raise RuntimeError('Unprotected operation lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield fd
    finally: os.close(fd)


@contextmanager
def probe_gate(root,owned_fd=None):
    """Drain shared probes before a runner freezes the application."""
    import fcntl
    protected(root,True)
    path=root/'operation.lock'
    if owned_fd is not None:
        fixed=path.lstat();info=os.fstat(owned_fd)
        if not stat.S_ISREG(fixed.st_mode) or not stat.S_ISREG(info.st_mode) or fixed.st_uid!=0 or info.st_uid!=0 or (fixed.st_mode|info.st_mode)&0o077 or (fixed.st_dev,fixed.st_ino)!=(info.st_dev,info.st_ino):raise RuntimeError('Invalid owned probe gate')
        if not re.search(r'^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+',Path('/proc/self/fdinfo/'+str(owned_fd)).read_text(),re.M):raise RuntimeError('Owned probe gate is not exclusive')
        yield
        return
    fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077:raise RuntimeError('Unprotected probe gate')
        fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
        yield
    finally:os.close(fd)


def protected(path,directory=False):
    info=path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or (directory and not stat.S_ISDIR(info.st_mode)) or (not directory and not stat.S_ISREG(info.st_mode)):
        raise RuntimeError('Log path is not root-owned protected storage')


def snapshot_workdirs(root=RUNTIME):
    return {p.name for p in root.glob('build*-*')}


def runner_stage(text,current):
    markers=re.findall(r'^CC_HOST_STAGE: (prepare|maintenance|apply|verify);',text,re.M)
    return markers[-1] if markers else current


def redact(text,secrets=()):
    for secret in secrets:
        if secret: text=text.replace(secret,'[redacted]')
    text=re.sub(r'(?i)(authorization\s*[:=]\s*|\b(?:token|password|secret|credential|api[_-]?key)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+',r'\1[redacted]',text)
    text=re.sub(r"(?i)([\"']?\b(?:[A-Za-z0-9_]*_)?(?:token|password|secret|credential|api[_-]?key|_authToken)[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)",r'\1[redacted]',text)
    text=re.sub(r'(?i)(https?://)[^/\s:@]+:[^/\s@]+@',r'\1[redacted]@',text)
    text=re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*','Bearer [redacted]',text)
    # Public artifact URLs have no query. Treat every query value as a secret,
    # including custom or percent-encoded parameter names.
    text=re.sub(r'(https?://[^\s<>\"?]+)\?[^\s<>\"]*',r'\1?[redacted]',text,flags=re.I)
    return text


def tail(path,limit=6000):
    with path.open('rb') as stream:
        stream.seek(max(0,path.stat().st_size-limit));return stream.read(limit).decode('utf8',errors='replace')


def nested_logs(text,build,before,root=RUNTIME,secrets=()):
    result=[];seen=set()
    for raw in re.findall(r'(?:log=|inspect )([^\s]+/build\.log)',text):
        path=Path(raw)
        if path in seen:continue
        seen.add(path)
        if '..' in path.parts or path.parent.parent!=root or path.parent.name in before or not re.fullmatch('build'+str(build)+r'-[A-Za-z0-9_-]+',path.parent.name): continue
        try:
            protected(root,True);protected(path.parent,True);protected(path)
            result.append(str(path)+'\n'+tail(path,1400))
        except (OSError,RuntimeError): continue
    return redact('\n'.join(result[-2:]),secrets)


def read_journal(container):
    # A fixed read in the already validated container; jobs never supply a path.
    script = "const f=require('fs'),p='/data/managed-server/journal.json';const s=f.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>32768)throw Error('Invalid journal');process.stdout.write(f.readFileSync(p))"
    raw=output(['docker','exec',container,'/opt/runtime/node/bin/node','-e',script])
    if len(raw)>32768:raise RuntimeError('Journal exceeds fixed limit')
    return json.loads(raw)


SOURCE_GUARD = r"""function sourceRegular(root,p,owners){
a(/^[A-Za-z0-9_.@/+-]{1,200}$/.test(p)&&!p.split('/').some(x=>['','..','.','node_modules'].includes(x)),'Unsafe source path');
const path=root+'/'+p;a.equal(f.realpathSync(path),path,'Linked source path');const s=f.lstatSync(path);a(s.isFile()&&owners.includes(s.uid)&&!(s.mode&18),'Untrusted source ownership or mode');
let dir=require('path').dirname(path);for(;;){const d=f.lstatSync(dir);a(d.isDirectory()&&owners.includes(d.uid)&&!(d.mode&18),'Untrusted source directory');if(dir===root)break;dir=require('path').dirname(dir)}
return f.readFileSync(path)}
"""


ORIGINAL_INVENTORY = SOURCE_GUARD + r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
const expected=JSON.parse(process.argv[1]);
for(const p of ['/opt/runtime/node/bin/node','/opt/runtime/cli/bin/claude','/etc/claude-code/managed-settings.json','/etc/claude-code/moderation-node.json']){const s=f.statSync(p);a(s.isFile()&&s.uid===0&&!(s.mode&18))}
function inventory(root){a.equal(f.realpathSync(root),root);const owners=root==='/app'?[0]:[0,1000],raw=sourceRegular(root,'SERVER-RELEASE.json',owners),d=JSON.parse(raw);for(const[p,v]of Object.entries(d.files)){a(/^[A-Za-z0-9_.@/+-]{1,200}$/.test(p)&&!p.split('/').some(x=>['','..','.','node_modules'].includes(x)));const path=root+'/'+p;a.equal(f.realpathSync(path),path);const b=sourceRegular(root,p,owners);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}return {raw,d}}
const base=inventory('/app');a.equal(hash(base.raw),expected.baseline.descriptor);
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),'4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358');a.equal(process.versions.node,'24.22.2');a.equal(hash(f.readFileSync('/app/package-lock.json')),expected.baseline.lock);
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');
a.equal(hash(Buffer.concat([f.readFileSync('/etc/claude-code/managed-settings.json'),f.readFileSync('/etc/claude-code/moderation-node.json')])),expected.baseline.policySha256);
const journal=JSON.parse(f.readFileSync('/data/managed-server/journal.json'));a.deepEqual(journal,expected.journal);
const root=expected.selected.sha256===null?'/app':'/data/managed-server/releases/'+expected.selected.sha256;a(/^\/app$|^\/data\/managed-server\/releases\/[a-f0-9]{64}$/.test(root));
const selected=inventory(root);a.equal(hash(selected.raw),expected.selected.descriptorSha256);a.equal(selected.d.build,expected.selected.build);a.equal(selected.d.protocol,expected.selected.protocol);
console.log('authenticated-original');"""


def inspect_original(core,context,container):
    """Reauthenticate a protected pre-build receipt; healthy HTTP alone is never proof."""
    known={'c2b0ab967a219cde7d250b1a39a5793ba57177ddfc0c0f43e021d362181dfed3':20,'42d161514ab4e12dfe0c753e7d4ff0b257f2c68efc6c0ac5f938aa9c7a469c66':21}
    baseline=context.get('baseline') or {};selected=context.get('selected') or {}
    if known.get(baseline.get('descriptor'))!=baseline.get('build') or known.get(selected.get('descriptorSha256'))!=selected.get('build'):return False
    if context.get('schema')!=1 or selected.get('protocol')!=24:return False
    info=json.loads(output(['docker','inspect',container]))[0]
    if (info['Id'],info['Image'])!=(context.get('containerId'),context.get('imageId')) or not info.get('State',{}).get('Running') or info['State'].get('Paused') or info['State'].get('Health',{}).get('Status')!='healthy':return False
    if core._digest(core._canonical({k:info[k] for k in ('Config','HostConfig','Mounts')}))!=context.get('configurationSha256'):return False
    if output(['docker','exec',container,'/opt/runtime/node/bin/node','-e',ORIGINAL_INVENTORY,json.dumps(context)],timeout=90).strip()!='authenticated-original':return False
    # Old v3 has no hostDiagnostics. Reuse the reviewed process classifier and
    # read-only DB guard, rather than inventing future v4 activity fields.
    helper=RUNTIME/'helper.py';protected(helper)
    if hashlib.sha256(helper.read_bytes()).hexdigest()!='270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0':return False
    spec=importlib.util.spec_from_file_location('original_idle_helper',helper);support=importlib.util.module_from_spec(spec);spec.loader.exec_module(support)
    rows=output(['docker','top',container,'-eo','pid,args']).splitlines()
    if not rows or rows[0].split() not in (['PID','COMMAND'],['PID','CMD']):
        raise ValueError('Unrecognized Docker process table')
    processes=[row.split(None,1) for row in rows[1:] if row.strip()]
    if not processes or any(len(row)!=2 or not row[0].isdigit() for row in processes):
        raise ValueError('Invalid Docker process table')
    if support.busy([[cell.replace('/apps/server/src/managed-server-child.ts','/apps/server/src/managed-server-main.ts') for cell in row] for row in processes]):return False
    database=Path('/srv/cc-desk-tunnel/state/sessions.sqlite')
    if not database.is_file():return False
    from contextlib import closing
    with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=1)) as db:
        if any(json.loads(row[0]).get('activeRun') for row in db.execute('SELECT metadata FROM sessions')):return False
    return True


TARGET_INVENTORY = SOURCE_GUARD + r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
const expected=JSON.parse(process.argv[1]);a.equal(process.versions.node,'24.22.2');
const raw=sourceRegular('/app','SERVER-RELEASE.json',[0]);a.equal(hash(raw),expected.descriptorSha256);const d=JSON.parse(raw);a.equal(d.build,expected.build);a.equal(d.protocol,expected.protocol);
for(const[p,v]of Object.entries(d.files)){a(/^[A-Za-z0-9_.@/+-]{1,200}$/.test(p)&&!p.split('/').some(x=>['','..','.','node_modules'].includes(x)));const path='/app/'+p;a.equal(f.realpathSync(path),path);const s=f.statSync(path);a(s.isFile()&&s.uid===0&&!(s.mode&18));const b=sourceRegular('/app',p,[0]);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),'4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358');a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');a.equal(hash(f.readFileSync('/app/package-lock.json')),expected.packageLockSha256);
for(const p of ['/opt/runtime/node/bin/node','/opt/runtime/cli/bin/claude','/etc/claude-code/managed-settings.json','/etc/claude-code/moderation-node.json']){const s=f.statSync(p);a(s.isFile()&&s.uid===0&&!(s.mode&18))}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);a.equal(f.readFileSync('/opt/runtime/level','utf8').trim(),'4');console.log('authenticated-target');"""


def inspect_target(container,release):
    return output(['docker','exec',container,'/opt/runtime/node/bin/node','-e',TARGET_INVENTORY,json.dumps(release)],timeout=90).strip()=='authenticated-target'
