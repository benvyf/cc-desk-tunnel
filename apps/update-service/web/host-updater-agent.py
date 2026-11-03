#!/usr/bin/env python3
"""Root-only outbound updater. Executes fixed helpers or a runner from an authenticated release."""
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path('/var/lib/cc-host-updater')
PROGRAM = Path('/opt/cc-host-updater')
BASE10 = '3098eeced28403a1d465dd53ffc06eeb225bbe45aa7e08dbd051059e778b6c71'
stopping = False


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


def request(config, path, value=None, authenticated=True, limit=131072):
    data = json.dumps(value).encode() if value is not None else None
    headers = {'Content-Type': 'application/json'} if data else {}
    if authenticated: headers['Authorization'] = 'Bearer ' + config['token']
    req = urllib.request.Request(config['origin'] + path, data=data, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
        content = response.read(limit + 1)
    if len(content) > limit: raise RuntimeError('Response exceeded the updater limit')
    return content


def save(path, value):
    temporary = path.with_suffix('.next')
    with temporary.open('w', encoding='utf8') as stream:
        os.chmod(temporary, 0o600); json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def verify_index(envelope, config, work, now=None):
    now = time.time() if now is None else now
    if set(envelope) != {'payload', 'keyId', 'signature'} or envelope['keyId'] not in config['keys']:
        raise RuntimeError('Unknown release signing identity')
    decoded = []
    for name in ['payload', 'signature']:
        text = envelope[name]
        if not isinstance(text, str) or not re.fullmatch('[A-Za-z0-9_-]+', text): raise RuntimeError('Invalid release encoding')
        value = base64.urlsafe_b64decode(text + '===')
        if base64.urlsafe_b64encode(value).decode().rstrip('=') != text: raise RuntimeError('Non-canonical release encoding')
        decoded.append(value)
    payload, signature = decoded
    if len(signature) != 64: raise RuntimeError('Invalid release signature')
    for name, value in [('payload', payload), ('signature', signature), ('public.pem', config['keys'][envelope['keyId']].encode())]:
        (work / name).write_bytes(value)
    result = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(work/'public.pem'), '-rawin', '-in', str(work/'payload'), '-sigfile', str(work/'signature')], capture_output=True, timeout=10)
    if result.returncode: raise RuntimeError('Release signature verification failed')
    value = json.loads(payload)
    if [value.get(k) for k in ['schema','product','channel','platform','arch']] != [1,'cc-desk-tunnel-managed-server','pilot','linux','x64']:
        raise RuntimeError('Wrong release identity')
    issued, expires = [datetime.datetime.fromisoformat(value[k].replace('Z','+00:00')).timestamp() for k in ['issuedAt','expiresAt']]
    if issued > now + 60 or expires <= now or not 0 < expires-issued <= 31*86400: raise RuntimeError('Release expired or clock incorrect')
    release = value['release']
    if type(release.get('build')) is not int or release['build'] < 1 or not re.fullmatch('[a-f0-9]{64}',release.get('sha256','')) or not 0 < release.get('size',0) <= 64*1024**2:
        raise RuntimeError('Invalid release target')
    return release


def container():
    ids = subprocess.check_output(['docker','ps','--filter','label=com.docker.compose.service=proxy','--format','{{.ID}}'], text=True, timeout=10).split()
    candidates = []
    for identity in ids:
        info = json.loads(subprocess.check_output(['docker','inspect',identity], timeout=10))[0]
        project = (info.get('Config',{}).get('Labels') or {}).get('com.docker.compose.project','')
        if project == 'cc-desk-tunnel' or project.startswith('cc-desk-tunnel-'): candidates.append(identity)
    if len(candidates) != 1: raise RuntimeError('Expected exactly one local CC service container')
    return candidates[0]


def node_command(identity, target):
    program = 'const target='+json.dumps(target)+';\n'+(PROGRAM/'server-upgrade.cjs').read_text()
    return ['docker','exec','-i',identity,'/opt/runtime/node/bin/node','--env-file=/data/config/service.env','--input-type=commonjs','-e',program]


def probe(protocol=None):
    target = {'probe':True}
    if protocol: target['protocol'] = protocol
    result = subprocess.run(node_command(container(),target), capture_output=True, text=True, timeout=15)
    if result.returncode: raise RuntimeError('Local service management interface unavailable')
    return json.loads(result.stdout.strip().splitlines()[-1])


def current():
    try:
        value = probe()
        return {'build':value['current']['build'],'protocol':value['current']['protocol'],'phase':value['phase']}
    except Exception as error:
        print('Local CC service status unavailable:',type(error).__name__,flush=True)
        return None


def load_helper():
    spec = importlib.util.spec_from_file_location('host_release_unpack',PROGRAM/'base/server-bootstrap.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module


def command_for(config, job, work, floor):
    release = verify_index(job['index'],config,work)
    if (job['build'],job['sha256']) != (release['build'],release['sha256']): raise RuntimeError('Confirmed target differs')
    latest = json.loads(request(config,'/cc-updates/server/v1/channels/pilot/linux-x64.json',authenticated=False))
    published = verify_index(latest,config,work)
    if published['sha256'] != release['sha256']: raise RuntimeError('Published target changed; refresh and confirm again')
    status = probe(release['protocol'])
    if floor > release['build'] or status['current']['build'] > release['build']: raise RuntimeError('Older releases cannot replace the installed version')
    if status['current']['build'] == release['build']:
        if status['current']['protocol'] != release['protocol']: raise RuntimeError('Installed version identity differs')
        return None, release
    check = status.get('check') or {}
    if check.get('compatible') and check.get('reason') == 'available':
        return node_command(container(),{'build':release['build'],'protocol':release['protocol'],'sha256':release['sha256']}), release
    if check.get('reason') != 'manual-image-upgrade': raise RuntimeError('Device is busy or the target is not currently installable')
    if release['build']==10 and release['sha256']==BASE10:
        return [sys.executable,str(PROGRAM/'base/upgrade-runtime-base.py'),'--sha256',release['sha256'],'--cleanup','--install'], release
    # Future base migrations must be carried by the signed archive, never supplied as job command text.
    archive = request(config,f"/cc-updates/server/v1/artifacts/{release['build']}/linux-x64/cc-desk-tunnel-server-{release['appVersion']}-build{release['build']}.tar.gz",authenticated=False,limit=64*1024**2)
    program = work/'program'; load_helper().unpack(archive,program,release)
    runner = program/'deploy/host-update/apply.py'
    if not runner.is_file(): raise RuntimeError('This release has no approved automatic base migration; use its administrator instructions')
    (work/'release.json').write_text(json.dumps(release))
    return [sys.executable,str(runner),'--release',str(work/'release.json'),'--install'], release


def progress(path, token):
    if not path.exists(): return '准备校验更新目标'
    with path.open('rb') as stream:
        stream.seek(max(0,path.stat().st_size-3500)); text=stream.read().decode('utf8',errors='replace')
    # Keep JSON reports within the center's 8 KiB body limit, including escaped characters.
    return text.replace(token,'[redacted]')[-1000:] or '更新处理中'


def run(config):
    state_path=ROOT/'state.json'
    state=json.loads(state_path.read_text()) if state_path.exists() else {'floor':0}
    if state.get('report',{}).get('state')=='running':
        identity=state['report']['id']
        state['report']={'id':identity,'state':'failed','progress':('更新进程被中断，未自动重放。请检查节点日志和备份目录。\n'+progress(ROOT/'jobs'/f'{identity}.log',config['token']))[-1200:]};save(state_path,state)
    while not stopping:
        version=current()
        try:
            response=json.loads(request(config,'/cc-host/v1/poll',{'nodeId':config['nodeId'],'current':version,**({'report':state['report']} if state.get('report') else {})}))
            if state.get('report') and response.get('acknowledged')==state['report']['id'] and state['report']['state']!='running':
                state.pop('report');save(state_path,state)
            job=response.get('job')
            if job:
                identity=job['id']
                if not re.fullmatch('[a-f0-9-]{36}',identity): raise RuntimeError('Invalid job identity')
                if state.get('lastJob')==identity: raise RuntimeError('An acknowledged job cannot be replayed')
                state['lastJob']=identity;state['report']={'id':identity,'state':'running','progress':'正在校验已签名的更新目标'};save(state_path,state)
                log=ROOT/'jobs'/f'{identity}.log'
                try:
                    created=datetime.datetime.fromisoformat(job['createdAt'].replace('Z','+00:00')).timestamp()
                    if not 0 <= time.time()-created <= 600: raise RuntimeError('Update confirmation expired; no installation requested')
                    with tempfile.TemporaryDirectory(prefix='update-',dir=ROOT) as directory:
                        args,release=command_for(config,job,Path(directory),state.get('floor',0))
                        if args:
                            with log.open('ab') as output:
                                worker=subprocess.Popen(args,stdout=output,stderr=subprocess.STDOUT)
                                while worker.poll() is None:
                                    state['report']['progress']=progress(log,config['token'])
                                    try:request(config,'/cc-host/v1/poll',{'nodeId':config['nodeId'],'current':version,'report':state['report']})
                                    except Exception:pass
                                    time.sleep(5)
                                if worker.returncode: raise RuntimeError('更新未完成，请查看下方日志；原服务恢复和回退信息以脚本输出为准。')
                        version=current()
                        if not version or version['build'] != release['build'] or version['protocol']!=release['protocol'] or version['phase'] not in ['idle','committed']: raise RuntimeError('更新后的版本或就绪状态尚未确认，请检查日志。')
                        state['floor']=max(state.get('floor',0),version['build'])
                        state['report']={'id':identity,'state':'succeeded','progress':('更新成功\n'+progress(log,config['token']))[-1200:]}
                except Exception as error:
                    message=str(error) if isinstance(error,RuntimeError) else type(error).__name__
                    state['report']={'id':identity,'state':'failed','progress':(message+'\n'+progress(log,config['token']))[-1200:]}
                save(state_path,state)
        except Exception as error:
            print('Host update channel:',type(error).__name__,flush=True)
        for _ in range(15):
            if stopping:break
            time.sleep(1)


def main():
    if os.geteuid()!=0:raise RuntimeError('Run the host updater as root')
    ROOT.mkdir(mode=0o700,exist_ok=True);(ROOT/'jobs').mkdir(mode=0o700,exist_ok=True)
    config=json.loads((ROOT/'config.json').read_text())
    import fcntl
    with (ROOT/'agent.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);run(config)


if __name__=='__main__':
    def stop(*args):
        global stopping
        stopping=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    main()
