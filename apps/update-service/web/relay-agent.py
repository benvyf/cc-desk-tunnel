"""Fixed-purpose relay configuration adoption, called serially by the host updater."""
from contextlib import contextmanager
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

UNIT=Path('/etc/systemd/system/cc-bwg-relay.service')
OPTIONS={'BatchMode','IdentitiesOnly','StrictHostKeyChecking','HostKeyAlgorithms','UserKnownHostsFile','ExitOnForwardFailure','ServerAliveInterval','ServerAliveCountMax','ConnectTimeout','HostKeyAlias'}

def public_ip(value):
    try:
        ip=ipaddress.IPv4Address(value)
        if not ip.is_global or str(ip)!=value:raise ValueError()
    except (ValueError,TypeError):raise RuntimeError('Expected a public IPv4 relay target')
    return value

def parse_unit(text):
    if len(text)>32768 or '\\' in text or '%' in text or '$' in text:raise RuntimeError('Unsupported relay unit syntax')
    starts=re.findall(r'^ExecStart=(.+)$',text,re.M)
    users=re.findall(r'^User=([a-z_][a-z0-9_-]*)$',text,re.M)
    if len(starts)!=1 or len(users)!=1:raise RuntimeError('Expected one relay ExecStart and User')
    args=shlex.split(starts[0])
    if args[:2]!=['/usr/bin/ssh','-NT'] or not re.fullmatch(r'ccdesk-relay@[0-9.]+',args[-1]):raise RuntimeError('Unsupported relay command')
    options={};key=None;forward=None;i=2
    while i<len(args)-1:
        flag=args[i]
        if flag not in ('-o','-i','-R') or i+1>=len(args)-1:raise RuntimeError('Unsupported relay SSH arguments')
        value=args[i+1];i+=2
        if flag=='-o':
            name,sep,content=value.partition('=')
            if not sep or name not in OPTIONS or name in options or not re.fullmatch(r'[a-zA-Z0-9_./:@+-]+',content):raise RuntimeError('Unsupported relay SSH option')
            options[name]=content
        elif flag=='-i':
            if key is not None:raise RuntimeError('Duplicate SSH identity')
            key=value
        else:
            if forward is not None:raise RuntimeError('Duplicate reverse forwarding')
            forward=value
    if options.get('StrictHostKeyChecking')!='yes' or options.get('BatchMode')!='yes' or options.get('ExitOnForwardFailure')!='yes':raise RuntimeError('Relay must preserve strict SSH verification')
    home='/home/'+users[0]+'/.ssh/'
    if not key or not key.startswith(home) or not re.fullmatch(r'/[a-zA-Z0-9_./-]+',key) or '..' in key:raise RuntimeError('Unexpected relay identity path')
    known=options.get('UserKnownHostsFile',home+'known_hosts')
    if not known.startswith(home) or '..' in known:raise RuntimeError('Unexpected known-hosts path')
    match=re.fullmatch(r'127\.0\.0\.1:([0-9]{4,5}):127\.0\.0\.1:8787',forward or '')
    if not match or not 1024<=int(match[1])<=65535:raise RuntimeError('Unexpected reverse forwarding')
    host=public_ip(args[-1].split('@')[1])
    return {'host':host,'port':22,'reversePort':int(match[1]),'known':known,'alias':options.get('HostKeyAlias',host),'args':args}

def rewrite(text,desired):
    if set(desired)!={'revision','host','port','hostKey'} or type(desired['revision']) is not int or desired['revision']<1 or desired['port']!=22:raise RuntimeError('Invalid relay desired configuration')
    host=public_ip(desired['host']);parsed=parse_unit(text);args=parsed['args'][:]
    if not any(x.startswith('HostKeyAlias=') for x in args):args[-1:-1]=['-o','HostKeyAlias='+parsed['alias']]
    args[-1]='ccdesk-relay@'+host
    return re.sub(r'^ExecStart=.+$',lambda _: 'ExecStart='+shlex.join(args),text,count=1,flags=re.M)

def atomic(path,content,mode=0o600):
    descriptor,name=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(descriptor,'wb') as stream:
            os.chmod(name,mode);stream.write(content);stream.flush();os.fsync(stream.fileno())
        os.replace(name,path)
        if os.name=='posix':
            fd=os.open(path.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
    finally:
        if os.path.exists(name):os.unlink(name)

def save(path,state):atomic(path,json.dumps(state).encode())

def keys(output):
    found=set()
    for line in output.splitlines():
        fields=line.split()
        if len(fields)>=3 and fields[1]=='ssh-ed25519':found.add(fields[2])
    if len(found)!=1:raise RuntimeError('Expected exactly one trusted Ed25519 host key')
    return found.pop()

def scan(host):
    result=subprocess.run(['ssh-keyscan','-T','8','-p','22','-t','ed25519',public_ip(host)],capture_output=True,text=True,timeout=12,check=True)
    return keys(result.stdout)

def inspect(unit=UNIT):
    if unit.is_symlink() or unit.stat().st_uid!=0 or unit.stat().st_mode&0o022:raise RuntimeError('Relay unit must be root-owned and protected')
    dropins=subprocess.check_output(['systemctl','show','cc-bwg-relay.service','--property=DropInPaths','--value'],text=True,timeout=10).strip()
    if dropins:raise RuntimeError('Relay drop-ins require manual enrollment review')
    parsed=parse_unit(unit.read_text())
    trusted=subprocess.check_output(['ssh-keygen','-F',parsed['alias'],'-f',parsed['known']],text=True,timeout=10)
    return {k:parsed[k] for k in ('host','port','reversePort')}|{'hostKey':keys(trusted)}

def tunnel_connected():
    value=subprocess.check_output(['systemctl','show','cc-bwg-relay.service','--property=MainPID','--value'],text=True,timeout=5).strip()
    if not re.fullmatch(r'[0-9]+',value):raise RuntimeError('Unknown relay process identity')
    if value=='0':return False
    sockets=subprocess.check_output(['ss','-Htnp','state','established'],text=True,timeout=5)
    return re.search(r'\bpid='+re.escape(value)+r',',sockets) is not None

def admission(command):
    def control(action,lease):
        # A dead transport needs recovery even when an approval/terminal is active.
        # Both paths still obtain local maintenance ownership, preventing install races.
        if action=='enter':
            mode='enter' if tunnel_connected() else 'recover'
            try:return command(mode,None).get('lease')
            except RuntimeError:return None
        return command(action,lease)
    return control

def apply(desired,state,unit,state_path,control,restart,scan_key):
    if not desired:return
    revision=desired['revision'];report=state.get('report',{})
    interrupted=report.get('state')=='applying'
    if not interrupted and revision<=state.get('floor',0):return
    def result(kind,message,rev=revision):
        state['report']={'revision':rev,'state':kind,'message':message};save(state_path,state)
    lease=None;recovery_checked=False;mutation_started=interrupted
    try:
        current=unit.read_text();changed=rewrite(current,desired)
        if interrupted:
            if current not in (state.get('before'),state.get('after')):raise RuntimeError('Interrupted configuration differs; manual inspection required')
            recovery_checked=True
        elif scan_key(desired['host'])!=desired['hostKey']:raise RuntimeError('Relay host key differs; no configuration changed')
        lease=control('enter',None)
        if not lease:
            if not interrupted:result('waiting','Waiting for idle service or relay admission support')
            return
        if unit.read_text()!=current:raise RuntimeError('Relay unit changed during preflight; no configuration changed')
        if interrupted:
            # Never replay an uncertain restart after a crash. Restore the durable preimage.
            atomic(unit,state['before'].encode(),0o644);restart(state['before'])
            mutation_started=False
            state['floor']=max(state.get('floor',0),report['revision'])
            result('failed','interrupted change restored; publish a new version to retry',report['revision'])
            return
        state.update(before=current,after=changed,floor=revision)
        result('applying','Restarting reverse SSH tunnel')
        mutation_started=True
        atomic(unit,changed.encode(),0o644)
        restart(changed)
        result('applied','Local tunnel started; awaiting public certificate and health verification')
    except Exception as error:
        message=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        if interrupted and recovery_checked and not lease:
            result('applying',message+'; recovery deferred until maintenance ownership is available',report['revision'])
            return
        if lease and mutation_started and state.get('before'):
            try:
                if unit.read_text() not in (state['before'],state['after']):raise RuntimeError('unit changed externally')
                atomic(unit,state['before'].encode(),0o644);restart(state['before']);message+='; previous configuration restored (old IP may remain unreachable)'
            except Exception:message+='; restoration not confirmed, inspect local service'
        state['floor']=max(state.get('floor',0),revision)
        result('failed',message[:1000])
    finally:
        if lease:
            try:control('leave',lease)
            except Exception:pass  # Local admission lease expires without agent cooperation.

@contextmanager
def operation_lock(root):
    # This file is also held by the v2 worker and stable maintenance supervisor.
    path=root/'operation.lock'
    with path.open('a+b') as lock:
        if os.name=='posix':
            import fcntl
            info=os.fstat(lock.fileno())
            if path.is_symlink() or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unprotected host operation lock')
            os.chmod(path,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        else:
            import msvcrt
            if not path.stat().st_size:lock.write(b'0');lock.flush()
            lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        try:yield
        finally:
            if os.name=='posix':fcntl.flock(lock,fcntl.LOCK_UN)
            else:lock.seek(0);msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)


def cycle(config,request,root,program,container):
    if not UNIT.exists():return
    try:
        with operation_lock(root):return _cycle_locked(config,request,root,program,container)
    except (BlockingIOError,PermissionError):return


def _cycle_locked(config,request,root,program,container):
    local=inspect()
    identity=container()
    def command(action,lease=None):
        source='const relayAction='+json.dumps(action)+';const relayLease='+json.dumps(lease)+';\n'+(program/'relay-control.cjs').read_text()
        result=subprocess.run(['docker','exec','-i',identity,'/opt/runtime/node/bin/node','--env-file=/data/config/service.env','--input-type=commonjs','-e',source],capture_output=True,text=True,timeout=12)
        if result.returncode:raise RuntimeError('Local relay admission unavailable; update the service before switching')
        return json.loads(result.stdout)
    local['localPin']=command('identity')['fingerprint']
    state_path=root/'relay-state.json';state=json.loads(state_path.read_text()) if state_path.exists() else {}
    response=json.loads(request(config,'/cc-host/v1/relay',{'nodeId':config['nodeId'],'inventory':local,'report':state.get('report')}))
    control=admission(command)
    def restart(expected):
        subprocess.run(['systemctl','daemon-reload'],check=True,timeout=10)
        loaded=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show','cc-bwg-relay.service','--property=FragmentPath','--property=DropInPaths'],text=True,timeout=5).splitlines() if '=' in line)
        if loaded.get('FragmentPath')!=str(UNIT) or loaded.get('DropInPaths')!='':raise RuntimeError('Loaded relay unit or overrides changed; restart refused')
        if UNIT.read_text()!=expected:raise RuntimeError('Relay unit changed during daemon reload; restart refused')
        subprocess.run(['systemctl','restart','cc-bwg-relay.service'],check=True,timeout=20)
        subprocess.run(['systemctl','is-active','--quiet','cc-bwg-relay.service'],check=True,timeout=5)
    # Recheck the trusted local key before touching the unit; scanning alone never establishes trust.
    desired=response.get('desired')
    if desired and desired.get('hostKey')!=local['hostKey']:raise RuntimeError('Desired SSH identity differs from local trust')
    apply(desired,state,UNIT,state_path,control,restart,scan)
