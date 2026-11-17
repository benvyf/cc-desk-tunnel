#!/usr/bin/env python3
"""Fixed boot recovery. Initial unit restoration needs only the Python stdlib."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

PROGRAM = Path('/opt/cc-host-platform')
DATA = Path('/var/lib/cc-host-updater')
UNITS = Path('/etc/systemd/system')
LEGACY = Path('/opt/cc-host-updater')

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def protected(path):
    path = Path(path)
    for item in [path, *path.parents]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode): raise ValueError('symlink in protected path')
        if os.name == 'posix' and (info.st_uid != 0 or info.st_mode & 0o022):
            if item != path and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & stat.S_ISVTX: continue
            raise ValueError('unprotected bootstrap path')

def read_json(path):
    protected(path)
    if path.stat().st_size > 256*1024: raise ValueError('bootstrap record too large')
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError('duplicate record key')
            value[key] = item
        return value
    return json.loads(path.read_bytes(), object_pairs_hook=pairs)

def sync(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)

def write(path, raw):
    path = Path(path); protected(path.parent)
    if path.exists() or path.is_symlink(): protected(path)
    fd, temporary = tempfile.mkstemp(prefix='.bootstrap-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.chmod(temporary, 0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path); sync(path.parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def save(path, value):
    write(path, json.dumps(value,sort_keys=True,separators=(',', ':')).encode())

def program_identity(root):
    protected(root); files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if '__pycache__' in relative.parts or path.suffix == '.pyc': continue
        protected(path)
        if path.is_file(): files[relative.as_posix()] = digest(path.read_bytes())
        elif not path.is_dir(): raise ValueError('unknown legacy file type')
    return digest(json.dumps(files,sort_keys=True,separators=(',', ':')).encode())

def unit_layout(units):
    protected(units)
    for name in ('cc-host-updater.service','cc-host-maintenance.service','cc-host-recovery.service','cc-host-adoption.service','cc-host-adoption.timer'):
        path = units/name
        if path.is_symlink() or (units/(name+'.d')).exists(): raise ValueError('unsupported systemd unit layout')
        if path.exists(): protected(path)

def service(action):
    if action == 'inspect':
        result = subprocess.run(['systemctl','show','cc-host-updater.service','--property=UnitFileState','--property=ActiveState','--property=FragmentPath','--property=DropInPaths'],check=True,capture_output=True,text=True,timeout=20)
        fields = dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if fields.get('DropInPaths') or fields.get('FragmentPath') not in ('',str(UNITS/'cc-host-updater.service')): raise ValueError('unknown updater unit layout')
        enabled, active = fields.get('UnitFileState'), fields.get('ActiveState')
        if enabled not in ('enabled','disabled','') or active not in ('active','inactive'): raise ValueError('masked or transitional updater unit')
        return {'enabled':enabled or 'disabled','active':active=='active'}
    if action=='inspect-recovery':
        result=subprocess.run(['systemctl','show','cc-host-recovery.service','--property=ActiveState','--property=SubState','--property=Result'],check=True,capture_output=True,text=True,timeout=20)
        fields=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        return {'active':fields.get('ActiveState')=='active','subState':fields.get('SubState'),'result':fields.get('Result')}
    if action=='start-recovery':
        subprocess.run(['systemctl','start','cc-host-recovery.service'],check=True,timeout=180);return
    if action not in ('reload','start','stop','enable','disable'):raise ValueError('unsupported fixed service action')
    args = ['systemctl','daemon-reload'] if action == 'reload' else ['systemctl',action,'cc-host-updater.service']
    subprocess.run(args,check=True,timeout=45)

def committed(state, candidate):
    floor = state.get('floor')
    if not isinstance(floor,dict) or type(floor.get('version')) is not int: return False
    if floor['version'] < candidate['version']: return False
    if floor['version'] == candidate['version'] and floor.get('sha256') != candidate['sha256']: return False
    return any(isinstance(item,dict) and all(item.get(k)==floor.get(k) for k in ('version','sha256')) and item.get('nodeId')==candidate['nodeId'] for item in (state.get('current'),state.get('previous')))

def validate_initial_intent(tx,units,legacy):
    """Only transaction-owned old/new unit bytes may be changed or stopped."""
    unit_layout(units)
    expected=tx['previousProgram']
    if expected is None:
        if legacy.exists() or legacy.is_symlink():raise ValueError('unexpected legacy program appeared')
    elif program_identity(legacy)!=expected:raise ValueError('legacy program identity changed')
    prior=tx['priorUnit'];old=prior['sha256'] if prior['exists'] else None
    new=tx['candidateUnitSha256'];phase=tx['phase']
    if phase in ('prepared','stopping'):allowed={old}
    elif phase in ('installing-unit','rollback-stopping','restoring-stop','restoring-disable','restoring-unit'):allowed={old,new}
    elif phase in ('reloading','enabling','starting'):allowed={new}
    elif phase in ('restoring-reload','restoring-enablement','restoring-start'):allowed={old}
    else:raise ValueError('unknown initial unit transaction phase')
    unit=units/'cc-host-updater.service'
    observed=digest(unit.read_bytes()) if unit.exists() else None
    if observed not in allowed:raise ValueError('unexpected updater unit identity requires maintenance')

def recover_initial(program=PROGRAM, data=DATA, units=UNITS, legacy=LEGACY, manager=service, boot=True):
    """Caller owns the shared operation gate; boot restores pointers without start."""
    path = data/'agent-platform'/'initial-unit.json'
    if not path.exists(): return None
    tx = read_json(path)
    if tx.get('schema') != 1 or tx.get('mode') not in ('legacy','enroll','fresh'): raise ValueError('unknown initial transaction')
    if tx.get('phase') in ('committed','rolled-back'): return tx
    unit_layout(units)
    config = data/'config.json'; protected(config)
    if digest(config.read_bytes()) != tx['configSha256']: raise ValueError('configuration changed during initial installation')
    state_path = data/'agent-platform'/'state.json'
    state = read_json(state_path) if state_path.exists() else dict(phase='steady',current=None,previous=None,candidate=None,floor=None)
    if committed(state,tx['candidate']):
        tx['phase']='committed'; save(path,tx); return tx
    if (state.get('floor') is not None or state.get('phase') not in ('steady','staged','stopping','switching','starting','rollback')
        or any(item not in (None,tx['candidate']) for item in (state.get('current'),state.get('previous'),state.get('candidate')))):
        raise ValueError('unrecognized platform state requires maintenance')
    validate_initial_intent(tx,units,legacy)
    prior = tx['priorUnit']; backup = data/'agent-platform'/'prior-unit'
    if prior['exists']:
        protected(backup); raw = backup.read_bytes()
        if digest(raw) != prior['sha256']: raise ValueError('prior unit identity mismatch')
    def mutate(phase, callback):
        validate_initial_intent(tx,units,legacy)
        tx['phase']=phase; save(path,tx); callback()
    unit = units/'cc-host-updater.service'
    if not boot and unit.exists(): mutate('restoring-stop',lambda:manager('stop'))
    if not prior['exists'] and unit.exists():mutate('restoring-disable',lambda:manager('disable'))
    if prior['exists']: mutate('restoring-unit',lambda:write(unit,raw))
    elif unit.exists(): mutate('restoring-unit',lambda:(unit.unlink(),sync(units)))
    mutate('restoring-reload',lambda:manager('reload'))
    if prior['exists']:mutate('restoring-enablement',lambda:manager('enable' if prior['enabled']=='enabled' else 'disable'))
    # Only the initial, uncommitted worker pointer is discarded. Application data
    # and either worker's state.json are deliberately untouched here.
    save(state_path,dict(phase='steady',current=None,previous=None,candidate=None,floor=None))
    if not boot and prior['active']: mutate('restoring-start',lambda:manager('start'))
    tx['phase']='rolled-back'; save(path,tx); return tx

def load_core(program=PROGRAM):
    path=program/'host-platform.py'; protected(path)
    spec=importlib.util.spec_from_file_location('cc_host_platform',path)
    core=importlib.util.module_from_spec(spec); spec.loader.exec_module(core); return core

@contextmanager
def operation_gate(data=DATA,blocking=False):
    import fcntl
    protected(data)
    fd=os.open(data/'operation.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        protected(data/'operation.lock')
        fcntl.flock(fd,fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield
    finally:os.close(fd)

@contextmanager
def observer_gate(data=DATA):
    """Stable stdlib lock precedes live recovery and every core import."""
    protected(data)
    for directory in (data/'agent-platform',data/'agent-platform'/'observer'):
        if not directory.exists() and not directory.is_symlink():
            directory.mkdir(mode=0o700);sync(directory.parent)
        protected(directory)
        if not directory.is_dir():raise ValueError('invalid observer lock directory')
    with operation_gate(data/'agent-platform'/'observer'):yield

def best_effort_maintenance(error,program=PROGRAM,data=DATA):
    """Only the original hash-pinned stable helper may report a recovery failure."""
    try:
        tx=read_json(data/'agent-platform'/'initial-unit.json')
        path=program/'host-bootstrap.py';protected(path)
        expected=tx.get('sourceHashes',{}).get('host-bootstrap.py')
        if expected is None or path.stat().st_size>512*1024 or digest(path.read_bytes())!=expected:return False
        spec=importlib.util.spec_from_file_location('cc_bootstrap_failure_report',path)
        bootstrap=importlib.util.module_from_spec(spec);spec.loader.exec_module(bootstrap)
        return bootstrap.report_recovery_failure(program,data,error)
    except Exception:return False

def main():
    if sys.argv[1:] != ['recover'] or os.name!='posix' or os.geteuid()!=0: raise ValueError('expected fixed root boot recovery')
    try:
        with operation_gate(blocking=True):recovered=recover_initial()
    except Exception as error:
        best_effort_maintenance(error);raise
    if recovered and recovered['phase']=='rolled-back':return
    load_core().main(['recover'])

if __name__=='__main__': main()
