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
import urllib.request
import zlib

BUNDLE = '__HOST_BUNDLE__'


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
    state=root/'state.json'
    if state.exists() and json.loads(state.read_text()).get('report',{}).get('state')=='running':
        raise RuntimeError('An update is in progress or was interrupted; inspect its log before replacing the channel')
    # Validate code before stopping the existing channel or consuming the grant.
    for name,content in bundle['files'].items():
        parts=Path(name)
        if parts.is_absolute() or '..' in parts.parts:raise RuntimeError('Invalid updater file path')
        data=base64.b64decode(content)
        if name.endswith('.py'):compile(data,name,'exec')
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
    for name,content in bundle['files'].items():
        path=program/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        path.write_bytes(base64.b64decode(content));path.chmod(0o600)
    config={'nodeId':node,'origin':bundle['origin'],'keys':bundle['keys'],'token':enrolled['token']}
    path=root/'config.json';path.write_text(json.dumps(config));path.chmod(0o600)
    unit=Path('/etc/systemd/system/cc-host-updater.service')
    unit.write_text('''[Unit]
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
''')
    unit.chmod(0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','cc-host-updater.service'],check=True)
    print('HOST_CHANNEL_READY: '+node+'; no application upgrade requested. Return to the management center to check and confirm an update.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--node',required=True);parser.add_argument('--code',required=True);args=parser.parse_args()
    try:install(args.node,args.code,json.loads(zlib.decompress(base64.b64decode(BUNDLE))))
    except Exception as error:
        reason='Management HTTP '+str(error.code)+'; generate a new enrollment command' if isinstance(error,urllib.error.HTTPError) else str(error) if isinstance(error,RuntimeError) else type(error).__name__
        print('Host channel enrollment stopped: '+reason+'. No application update was requested.',file=sys.stderr)
        raise SystemExit(1)
