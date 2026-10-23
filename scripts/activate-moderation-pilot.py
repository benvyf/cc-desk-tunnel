#!/usr/bin/env python3
"""Activate the already tested ubuntu-cc overlay; never start Claude or send model input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import traceback

STATE = Path('/var/lib/cc-moderation-pilot-2638731374c8')
DATA = Path('/srv/cc-desk-tunnel')
SOURCE = Path('/opt/cc-desk-tunnel')
CONFIG = SOURCE / '.local/docker.env'
COMPOSE = SOURCE / 'deploy/docker/compose.yaml'
PROJECT = 'cc-desk-tunnel-ba938975'
CONTAINER = PROJECT + '-proxy-1'
BASE = 'sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553'
IMAGE = 'sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24'
IMAGE_TAG = 'cc-desk-tunnel:moderation-2638731374c8'
BACKUP = STATE / 'activation-backup'
SERVICE_ENV = DATA / 'config/service.env'
NODE_CONFIG = DATA / 'config/moderation-node.json'
ENDPOINT = 'https://api.ghostapi.org/cc-updates/v1/moderation/check'
HOST_KEY = '74.82.201.214 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEpdsTQ0vC1ya2DfVdhYbSsQ/Tfh+SjSSvyuhYn0XfnF'


def run(*args, input=None):
    return subprocess.check_output([str(arg) for arg in args], input=input, text=True, stderr=subprocess.STDOUT).strip()


def inspect(kind, name):
    return json.loads(run('docker', kind, 'inspect', name))[0]


def dc(*args):
    return run('docker', 'compose', '--env-file', CONFIG, '-p', PROJECT, '-f', COMPOSE, *args)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def replace_file(path, data):
    owner = path.stat()
    temporary = path.with_name(path.name + '.moderation-next')
    temporary.write_bytes(data)
    shutil.copystat(path, temporary)
    os.chown(temporary, owner.st_uid, owner.st_gid)
    temporary.replace(path)


def pin_image(tag):
    text, count = re.subn(r'^PROXY_IMAGE=.*$', "PROXY_IMAGE='" + tag + "'", CONFIG.read_text(), flags=re.M)
    assert count == 1, 'Expected exactly one managed image setting'
    replace_file(CONFIG, text.encode())
    assert json.loads(dc('config', '--format', 'json'))['services']['proxy']['image'] == tag


def receive_config():
    host_file = STATE / 'enrollment-known-hosts'
    host_file.write_text(HOST_KEY + '\n')
    received = STATE / 'received-node.json'
    if not received.exists():
        temporary = received.with_suffix('.pending')
        with temporary.open('wb') as output:
            result = subprocess.run(['ssh', '-F', '/dev/null', '-T', '-i', str(STATE / 'enroll_ed25519'),
                '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                '-o', 'UserKnownHostsFile=' + str(host_file), '-o', 'GlobalKnownHostsFile=/dev/null',
                '-o', 'ConnectTimeout=15', 'root@74.82.201.214'], stdout=output, stderr=subprocess.PIPE, timeout=30)
        if result.returncode:
            temporary.unlink(missing_ok=True)
            raise RuntimeError('Restricted configuration retrieval failed; enrollment may have expired')
        temporary.replace(received)
    received.chmod(0o600)
    assert received.stat().st_size <= 1024
    node = json.loads(received.read_text())
    assert set(node) == {'endpoint', 'nodeId', 'token'} and node['nodeId'] == 'ubuntu-cc'
    assert node['endpoint'] == ENDPOINT and re.fullmatch('[A-Za-z0-9_-]{43}', node['token'])
    # A malformed empty body must return 400 AFTER node auth. This never reaches JEV.
    script = 'const config = ' + json.dumps(node) + ';\n' + r'''
try {
  const response = await fetch(config.endpoint, {method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},body:'{}'});
  if(response.status!==400) throw new Error('node auth check failed');
  console.log('NODE_AUTH_OK');
} catch { console.error('Node endpoint/authentication unavailable; no model request sent.'); process.exitCode=1; }
'''
    assert run('docker', 'run', '--rm', '--network', 'container:' + CONTAINER, '--entrypoint', 'node',
               IMAGE, '--input-type=module', '-', input=script) == 'NODE_AUTH_OK'
    return received


def idle():
    script = r'''
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const db = new DatabaseSync(join(process.env.PROXY_DATA_DIR, 'sessions.sqlite'),{readOnly:true});
const {n} = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(metadata,'$.activeRun') IS NOT NULL").get();
db.close(); console.log(JSON.stringify({activeRuns:n}));
'''
    value = json.loads(run('docker', 'exec', '-i', CONTAINER, 'node', '--env-file=/data/config/service.env',
                           '--input-type=module', '-', input=script))
    assert value['activeRuns'] == 0, 'Node still has an active run; stop here'


VERIFY_JS = r'''
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {X509Certificate,randomUUID} from 'node:crypto';
import https from 'node:https';
const enabled = __ENABLED__;
assert.equal(Boolean(process.env.PROXY_MODERATION_CONFIG),enabled);
const ca = readFileSync(process.env.PROXY_TLS_CERT);
assert.equal(new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase(),
  '7c08ee9eaa52b39bdaf64b63fbfdbe163b4614519da315c5b5f68a1ea183a82e');
const tls = {ca,servername:process.env.PROXY_CERT_NAME,allowPartialTrustChain:true};
const health = await new Promise((resolve,reject)=>{
  const r=https.get({host:'127.0.0.1',port:8787,path:'/health',...tls},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>{
      try{assert.equal(res.statusCode,200);resolve(JSON.parse(text));}catch(e){reject(e);}
    });
  });r.on('error',reject);r.setTimeout(10000,()=>r.destroy(new Error('health timeout')));
});
assert.equal(health.protocolVersion,20);
assert.equal(health.adapter,'claude-code');
let terminalChecked=false;
const {WebSocket}=createRequire('/app/apps/server/package.json')('ws');
await new Promise((resolve,reject)=>{
  const ws=new WebSocket('wss://127.0.0.1:8787/ws',tls);
  const timer=setTimeout(()=>done(new Error('control timeout')),10000);
  const requestId=randomUUID();
  function done(error){clearTimeout(timer);ws.terminate();error?reject(error):resolve();}
  ws.on('error',done);
  ws.on('open',()=>ws.send(JSON.stringify({type:'auth',protocolVersion:20,token:process.env.PROXY_TOKEN,deviceName:'moderation-activation-check'})));
  ws.on('message',bytes=>{try{
    const m=JSON.parse(bytes);
    if(m.type==='connection.error')throw new Error('control authentication failed');
    if(m.type==='ready'){
      if(!enabled || !m.sessions.length){done();return;}
      ws.send(JSON.stringify({type:'terminal.open',requestId,sessionId:m.sessions[0].id,cols:80,rows:24}));
    }
    if(m.type==='response' && m.requestId===requestId){
      assert.equal(m.ok,false);assert.equal(m.code,'moderation_terminal_disabled');terminalChecked=true;done();
    }
  }catch(e){done(e);}});
});
if(enabled){
  const {environmentConfig}=await import('/app/apps/server/src/config.ts');
  assert.equal(environmentConfig(process.env,'/data/state').options.moderation.nodeId,'ubuntu-cc');
}
console.log(JSON.stringify({protocol:20,authenticated:true,tlsUnchanged:true,moderationEnabled:enabled,terminalDisabledVerified:terminalChecked,modelRequests:0}));
'''


def verify(image, enabled):
    for _ in range(60):
        current = inspect('container', CONTAINER)
        assert current['Image'] == image
        if current['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(1)
    else:
        raise RuntimeError('Service health deadline exceeded')
    return json.loads(run('docker', 'exec', '-i', CONTAINER, 'node', '--env-file=/data/config/service.env',
                          '--input-type=module', '-', input=VERIFY_JS.replace('__ENABLED__', str(enabled).lower())))


def rollback():
    manifest = json.loads((BACKUP / 'manifest.json').read_text())
    for name, expected in manifest['files'].items():
        assert digest(BACKUP / name) == expected, 'Backup checksum mismatch'
    assert inspect('container', CONTAINER)['Image'] in (BASE, IMAGE)
    dc('stop', 'proxy')
    replace_file(CONFIG, (BACKUP / 'docker.env').read_bytes())
    replace_file(SERVICE_ENV, (BACKUP / 'service.env').read_bytes())
    NODE_CONFIG.unlink(missing_ok=True)
    dc('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'proxy')
    result = verify(BASE, False)
    result.update(rolledBack=True, cutoverPerformed=False, dataRestored=False,
                  note='Same-schema data retained; consistent pre-cutover data archive available privately.')
    write_json(STATE / 'activation-result.json', result)
    print(json.dumps(result), flush=True)


def activate():
    prepared = json.loads((STATE / 'result.json').read_text())
    assert prepared['imageId'] == IMAGE and prepared['protectedImageFilesEqual'] and prepared['modelRequests'] == 0
    assert inspect('image', IMAGE_TAG)['Id'] == IMAGE
    current = inspect('container', CONTAINER)
    before = json.loads((STATE / 'production-before.json').read_text())
    assert [current['Id'], current['Image'], current['State']['StartedAt']] == [before['Id'], BASE, before['State']['StartedAt']]
    assert len(current['Mounts']) == 1 and current['Mounts'][0]['Source'] == str(DATA) and current['Mounts'][0]['Destination'] == '/data'
    assert DATA.is_dir() and not DATA.is_symlink() and (DATA / '.cc-desk-tunnel-data').is_file()
    assert not BACKUP.exists() and not NODE_CONFIG.exists()
    assert not re.search(r'^PROXY_MODERATION_CONFIG=', SERVICE_ENV.read_text(), re.M)
    print('1/3 Retrieving this node credential over pinned/restricted SSH; checking endpoint without model calls.', flush=True)
    credential = receive_config()
    idle()
    protected = {str(path.relative_to(DATA)): digest(path) for path in [
        DATA / name for name in ('config/provider.json','tls/control.crt','tls/control.key',
        'home/.claude/settings.json','home/.claude/.credentials.json','home/.claude.json')
    ] if path.is_file()}
    allocated = int(run('du', '-sx', '-B1', DATA).split()[0])
    assert shutil.disk_usage(STATE).free > allocated * 2 + 512 * 1024**2, 'Insufficient backup space'
    BACKUP.mkdir(mode=0o700)
    shutil.copy2(CONFIG, BACKUP / 'docker.env')
    shutil.copy2(SERVICE_ENV, BACKUP / 'service.env')
    run('docker', 'tag', BASE, 'cc-desk-tunnel:before-moderation-e3275f6f27d5')
    stopped = changed = False
    try:
        print('2/3 Stopping this idle node briefly and taking a consistent local data backup.', flush=True)
        idle()
        stopped = True
        dc('stop', 'proxy')
        assert not inspect('container', CONTAINER)['State']['Running']
        run('tar', '--acls', '--xattrs', '--numeric-owner', '-cpf', BACKUP / 'data.tar', '-C', DATA, '.')
        run('tar', '-tf', BACKUP / 'data.tar')
        write_json(BACKUP / 'manifest.json', {'baseImage':BASE,'newImage':IMAGE,
            'files': {name:digest(BACKUP / name) for name in ('docker.env','service.env','data.tar')}, 'protected':protected})
        changed = True
        shutil.copyfile(credential, NODE_CONFIG)
        NODE_CONFIG.chmod(0o600)
        os.chown(NODE_CONFIG, 1000, 1000)
        original = (BACKUP / 'service.env').read_bytes()
        replace_file(SERVICE_ENV, original + (b'' if original.endswith(b'\n') else b'\n') + b'PROXY_MODERATION_CONFIG=/data/config/moderation-node.json\n')
        pin_image(IMAGE_TAG)
        print('3/3 Starting the tested overlay; verifying TLS, control auth and terminal restriction only.', flush=True)
        dc('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'proxy')
        result = verify(IMAGE, True)
        after = inspect('container', CONTAINER)
        assert after['Config']['Env'] == current['Config']['Env'], 'Container environment changed'
        for key in ('NetworkMode','Dns','DnsSearch','ExtraHosts','PortBindings','SecurityOpt','CapDrop'):
            assert (after['HostConfig'].get(key) or []) == (current['HostConfig'].get(key) or []), 'Container routing/security option changed'
        assert after['Mounts'] == current['Mounts'], 'Container data mount changed'
        assert all(digest(DATA / name) == expected for name, expected in protected.items()), 'Protected data changed'
        result.update(cutoverPerformed=True, rolledBack=False, backupDirectory=str(BACKUP), cliAndSdkUnchanged=True,
                      credentialsAndRoutingUnchanged=True, imageId=IMAGE, clientAcceptancePending=True)
        write_json(STATE / 'activation-result.json', result)
        print(json.dumps(result), flush=True)
        print('PASS. Gate enabled on ubuntu-cc; no Claude model request sent. Client acceptance remains pending.', flush=True)
    except Exception:
        if changed:
            rollback()
        elif stopped:
            run('docker', 'start', CONTAINER)
            verify(BASE, False)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--idle-confirmed', action='store_true')
    group.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    os.umask(0o077)
    # Prevent two copies of this maintenance operation racing over the same backup/configuration.
    import fcntl
    lock = (STATE / 'activation.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        saved = STATE / 'activate.py'
        if Path(__file__).resolve() != saved.resolve():
            shutil.copyfile(__file__, saved)
            saved.chmod(0o700)
        if args.rollback: rollback()
        else: activate()
    except Exception:
        (STATE / 'activation-error.log').write_text(traceback.format_exc())
        raise SystemExit('Activation stopped; report any rollback result and this message only. Private diagnostics: ' + str(STATE))
