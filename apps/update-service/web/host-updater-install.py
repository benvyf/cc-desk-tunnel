#!/usr/bin/env python3
"""One-time root host-channel enrollment; never queues or runs an application update."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import urllib.request
import zlib
from contextlib import contextmanager

BUNDLE = '__HOST_BUNDLE__'


@contextmanager
def enrollment_lock(root):
    import fcntl
    descriptor=os.open(root/'enrollment.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('Another host channel enrollment is running; no enrollment requested')
        yield


def install(node, code, bundle):
    if os.geteuid()!=0 or sys.version_info < (3,12):raise RuntimeError('Use sudo on Ubuntu 24.04 with Python 3.12 or newer')
    if not re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}',node) or socket.gethostname().split('.')[0]!=node:
        raise RuntimeError('Run the command on its matching Ubuntu host')
    if not re.fullmatch('[A-Za-z0-9_-]{43}',code):raise RuntimeError('Invalid enrollment code')
    root=Path('/var/lib/cc-host-updater');program=Path('/opt/cc-host-updater')
    for path in [root,program]:
        if path.is_symlink():raise RuntimeError('Unexpected updater directory link')
        path.mkdir(mode=0o700,exist_ok=True)
        if path.stat().st_uid!=0 or path.stat().st_mode&0o022:raise RuntimeError('Updater directories must be protected and root-owned')
    with enrollment_lock(root):
        return install_locked(node,code,bundle,root,program)


def install_locked(node,code,bundle,root,program):
    state=root/'state.json'
    if state.exists() and json.loads(state.read_text()).get('report',{}).get('state')=='running':
        raise RuntimeError('An update is in progress or was interrupted; inspect its log before replacing the channel')
    # Stage every byte before stopping the old channel or consuming the grant.
    stage=Path(tempfile.mkdtemp(prefix='.cc-host-updater-',dir=str(program.parent)))
    staged_program=stage/'program';staged_program.mkdir(mode=0o700)
    for name,content in bundle['files'].items():
        parts=Path(name)
        if parts.is_absolute() or '..' in parts.parts:raise RuntimeError('Invalid updater file path')
        data=base64.b64decode(content)
        if name.endswith('.py'):compile(data,name,'exec')
        path=staged_program/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        with path.open('xb') as stream:
            os.chmod(path,0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
    nonce=stage.name.rsplit('-',1)[-1]
    next_config=root/('config.next-'+nonce)
    config={'nodeId':node,'origin':bundle['origin'],'keys':bundle['keys'],'token':'x'*43}
    reserved=json.dumps(config).encode()
    with next_config.open('xb') as stream:
        os.chmod(next_config,0o600);stream.write(reserved);stream.flush();os.fsync(stream.fileno())
    unit=Path('/etc/systemd/system/cc-host-updater.service')
    next_unit=unit.with_name(unit.name+'.next-'+nonce)
    previous_unit=unit.read_bytes() if unit.exists() else None
    previous_unit_path=unit.with_name(unit.name+'.previous-'+nonce)
    if previous_unit is not None:
        previous_unit_path.write_bytes(previous_unit);previous_unit_path.chmod(0o644)
    next_unit.write_text('''[Unit]
Description=CC signed host update channel
Wants=network-online.target
After=network-online.target docker.service
[Service]
Type=simple
User=root
UMask=0077
ExecStart=/usr/bin/python3 /opt/cc-host-updater/agent.py
Restart=on-failure
RestartSec=10
KillMode=mixed
TimeoutStopSec=infinity
[Install]
WantedBy=multi-user.target
''');next_unit.chmod(0o644)
    was_active=subprocess.run(['systemctl','is-active','--quiet','cc-host-updater.service'],capture_output=True,timeout=10).returncode==0
    stopped=subprocess.run(['systemctl','stop','cc-host-updater.service'],capture_output=True,timeout=20)
    if was_active and stopped.returncode:raise RuntimeError('Could not stop the existing host channel; no files or credentials changed')
    request=urllib.request.Request(bundle['origin']+'/cc-host/v1/enroll',data=json.dumps({'nodeId':node,'code':code}).encode(),headers={'Content-Type':'application/json'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=20) as response:
            enrolled=json.loads(response.read(4097))
        if not re.fullmatch('[A-Za-z0-9_-]{43}',enrolled.get('token','')):raise RuntimeError('Invalid enrollment response')
    except Exception:
        # A rejected grant must not replace the working program or leave its service stopped.
        if was_active:subprocess.run(['systemctl','start','cc-host-updater.service'],capture_output=True,timeout=20)
        raise
    previous_program=stage/'previous-program'
    swapped=False
    credential_adopted=False
    try:
        # The placeholder has identical length, so adopting the new credential
        # does not require allocating another config after the grant is consumed.
        config['token']=enrolled['token'];content=json.dumps(config).encode()
        if len(content)!=len(reserved):raise RuntimeError('Enrollment credential length changed')
        with next_config.open('r+b') as stream:
            stream.write(content);stream.flush();os.fsync(stream.fileno())
        next_config.replace(root/'config.json')
        credential_adopted=True
        program.rename(previous_program)
        try:staged_program.rename(program)
        except BaseException:
            previous_program.rename(program);raise
        swapped=True
        next_unit.replace(unit)
        subprocess.run(['systemctl','daemon-reload'],check=True)
        subprocess.run(['systemctl','enable','--now','cc-host-updater.service'],check=True)
        subprocess.run(['systemctl','is-active','--quiet','cc-host-updater.service'],check=True)
    except BaseException:
        if not credential_adopted:
            raise RuntimeError('Enrollment grant consumed but credential persistence failed; reenrollment required; original program retained; inspect '+str(stage))
        stopped=subprocess.run(['systemctl','stop','cc-host-updater.service'],capture_output=True,timeout=20)
        if stopped.returncode:raise RuntimeError('Could not stop replacement host channel; recovery requires inspection of '+str(stage))
        if swapped:
            program.rename(stage/'failed-program')
            previous_program.rename(program)
        if previous_unit is not None:
            previous_unit_path.replace(unit)
        elif unit.exists():unit.unlink()
        subprocess.run(['systemctl','daemon-reload'],capture_output=True,timeout=20)
        if was_active:
            restored=subprocess.run(['systemctl','start','cc-host-updater.service'],capture_output=True,timeout=20)
            if restored.returncode:raise RuntimeError('Host channel replacement and old program restart failed; inspect '+str(stage))
            subprocess.run(['systemctl','is-active','--quiet','cc-host-updater.service'],check=True,timeout=20)
        raise RuntimeError('Host channel replacement failed; previous program restored using the newly enrolled credential; inspect '+str(stage))
    print('HOST_CHANNEL_READY: '+node+'; no application upgrade requested. Return to the management center to check and confirm an update.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node',required=True);parser.add_argument('--code',required=True);args=parser.parse_args()
    try:install(args.node,args.code,json.loads(zlib.decompress(base64.b64decode(BUNDLE))))
    except Exception as error:
        reason='Management HTTP '+str(error.code)+'; generate a new enrollment command' if isinstance(error,urllib.error.HTTPError) else str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('Host channel enrollment stopped: '+reason+'. No application update was requested.',file=sys.stderr)
        raise SystemExit(1)
