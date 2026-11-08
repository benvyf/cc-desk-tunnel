#!/usr/bin/env python3
"""One-node backup/cutover, with matching-data rollback. Run only while idle."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

STATE = Path('/var/lib/cc-desk-tunnel-pilot-4a39bc3')
BACKUP = STATE / 'production-backup'
SOURCE = Path('/opt/cc-desk-tunnel')
DATA = Path('/srv/cc-desk-tunnel')
CONFIG = SOURCE / '.local/docker.env'
COMPOSE = SOURCE / 'deploy/docker/compose.yaml'
PROJECT = 'cc-desk-tunnel-ba938975'
CONTAINER = PROJECT + '-proxy-1'
OLD = 'sha256:8b9d684a84664ad27a7d97d808a8a8a057940b6ca3f5c080d6bc2182792d2390'
NEW = 'sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553'
NEW_TAG = 'cc-desk-tunnel:pilot-4a39bc3-e3275f6f27d5'
OLD_TAG = 'cc-desk-tunnel:rollback-20261023-8b9d684a8466'
CERT = '7c08ee9eaa52b39bdaf64b63fbfdbe163b4614519da315c5b5f68a1ea183a82e'
PROTECTED = ('config/service.env', 'config/provider.json', 'tls/control.crt', 'tls/control.key')


def run(*args, input=None):
    return subprocess.check_output([str(a) for a in args], input=input, text=True,
                                   stderr=subprocess.STDOUT).strip()


def dc(*args):
    return run('docker', 'compose', '--env-file', CONFIG, '-p', PROJECT,
               '-f', COMPOSE, *args)


def inspect(kind, name):
    return json.loads(run('docker', kind, 'inspect', name))[0]


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def pin_image(tag):
    text = CONFIG.read_text()
    text, count = re.subn(r'^PROXY_IMAGE=.*$', "PROXY_IMAGE='%s'" % tag, text, flags=re.M)
    assert count == 1, 'Expected one managed image setting'
    temp = CONFIG.with_suffix('.pilot-tmp')
    temp.write_text(text)
    shutil.copystat(CONFIG, temp)
    os.chown(temp, CONFIG.stat().st_uid, CONFIG.stat().st_gid)
    temp.replace(CONFIG)
    resolved = json.loads(dc('config', '--format', 'json'))['services']['proxy']
    assert resolved['image'] == tag
    mounts = [m for m in resolved['volumes'] if m['target'] == '/data']
    assert len(mounts) == 1 and mounts[0]['source'] == str(DATA)
    assert any(str(p['published']) == '8787' and p['target'] == 8787
               for p in resolved['ports'])


def verify(protocol, image):
    for _ in range(60):
        current = inspect('container', CONTAINER)
        assert current['Image'] == image
        if current['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(2)
    else:
        raise RuntimeError('Health deadline exceeded')
    # TLS and authenticated control only; no model requests or command execution.
    output = run('docker', 'exec', '-i', CONTAINER, 'node',
                 '--env-file=/data/config/service.env', '--input-type=module', '-',
                 input=VERIFY_JS.replace('__PROTOCOL__', str(protocol)))
    result = json.loads(output)
    assert result['protocol'] == protocol and result['authenticated']
    return result


VERIFY_JS = r"""
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {X509Certificate} from 'node:crypto';
import https from 'node:https';
const protocol = __PROTOCOL__;
const ca = readFileSync(process.env.PROXY_TLS_CERT);
const fingerprint = new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase();
assert.equal(fingerprint, '7c08ee9eaa52b39bdaf64b63fbfdbe163b4614519da315c5b5f68a1ea183a82e');
for (const name of ['DISABLE_TELEMETRY','DISABLE_ERROR_REPORTING','DISABLE_AUTOUPDATER']) assert.equal(process.env[name], '1');
assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
const tls = {ca, servername:process.env.PROXY_CERT_NAME, allowPartialTrustChain:true};
const health = await new Promise((resolve,reject) => {
  const request = https.get({host:'127.0.0.1',port:8787,path:'/health',...tls}, response => {
    let body=''; response.on('data', c => body+=c);
    response.on('end',()=>{try {assert.equal(response.statusCode,200);resolve(JSON.parse(body));} catch(e){reject(e);}});
  });
  request.on('error',reject); request.setTimeout(10000,()=>request.destroy(new Error('timeout')));
});
assert.equal(health.protocolVersion,protocol);
const {WebSocket} = createRequire('/app/apps/server/package.json')('ws');
await new Promise((resolve,reject)=>{
  const ws = new WebSocket('wss://127.0.0.1:8787/ws',tls);
  const timer=setTimeout(()=>finish(new Error('auth timeout')),10000);
  function finish(error){clearTimeout(timer);ws.terminate();error?reject(error):resolve();}
  ws.on('error',finish);
  ws.on('open',()=>ws.send(JSON.stringify({type:'auth',token:process.env.PROXY_TOKEN,protocolVersion:protocol,deviceName:'ubuntu-pilot-cutover-check'})));
  ws.on('message',bytes=>{try{const m=JSON.parse(bytes);if(m.type==='ready')finish();else if(m.type==='connection.error')finish(new Error('auth rejected'));}catch(e){finish(e);}});
});
console.log(JSON.stringify({protocol,authenticated:true,certificateSha256:fingerprint,trafficFlagsPreserved:true,modelRequests:0}));
"""


def rollback():
    manifest = json.loads((BACKUP / 'manifest.json').read_text())
    assert manifest['backupComplete'] and manifest['oldImageId'] == OLD
    print('Restoring old image, configuration and matching data snapshot.', flush=True)
    for name, expected in manifest['archives'].items():
        assert digest(BACKUP / name) == expected, 'Backup checksum mismatch'
    if not subprocess.run(['docker', 'image', 'inspect', OLD], stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0:
        run('docker', 'load', '-i', BACKUP / 'old-image.tar')
    run('docker', 'tag', OLD, OLD_TAG)
    dc('stop', 'proxy')
    dc('rm', '-f', 'proxy')
    failed = DATA.with_name(DATA.name + '.failed-pilot-' + str(time.time_ns()))
    DATA.rename(failed)
    DATA.mkdir(mode=0o700)
    run('tar', '--acls', '--xattrs', '--numeric-owner', '-xpf', BACKUP / 'data.tar', '-C', DATA)
    shutil.copy2(BACKUP / 'docker.env', CONFIG)
    os.chown(CONFIG, manifest['configUid'], manifest['configGid'])
    pin_image(OLD_TAG)
    dc('up', '-d', '--no-build', '--pull', 'never', 'proxy')
    result = verify(19, OLD)
    result.update(rolledBack=True, cutoverPerformed=False, failedDataPreservedAt=str(failed))
    write_json(STATE / 'cutover-result.json', result)
    print(json.dumps(result))


def cutover():
    assert not BACKUP.exists(), 'Existing backup found; do not overwrite it'
    preflight = json.loads((STATE / 'preflight-sanitized.json').read_text())
    current = inspect('container', CONTAINER)
    assert current['Image'] == OLD and current['State']['StartedAt'] == preflight['productionStartedAt']
    assert inspect('image', NEW)['Id'] == NEW
    assert (STATE / 'image-id.txt').read_text().strip() == NEW
    assert len(current['Mounts']) == 1 and current['Mounts'][0]['Source'] == str(DATA)
    assert DATA.is_dir() and not DATA.is_symlink() and (DATA / '.cc-desk-tunnel-data').is_file()
    cert = run('openssl', 'x509', '-in', DATA / 'tls/control.crt', '-noout', '-fingerprint', '-sha256')
    assert cert.split('=')[1].replace(':', '').lower() == CERT
    allocated = lambda path: int(run('du', '-sx', '-B1', path).split()[0])
    required = int(inspect('image', OLD)['Size'] * 1.3) + allocated(SOURCE) + allocated(DATA) * 2 + 512 * 1024**2
    assert shutil.disk_usage(STATE).free > required, 'Insufficient backup space'
    BACKUP.mkdir(mode=0o700)
    manifest = {'oldImageId': OLD, 'newImageId': NEW, 'backupComplete': False,
                'configUid': CONFIG.stat().st_uid, 'configGid': CONFIG.stat().st_gid}
    protected = {name: digest(DATA / name) for name in PROTECTED}
    run('docker', 'tag', OLD, OLD_TAG)
    run('docker', 'tag', NEW, NEW_TAG)
    print('1/3 Saving old image and source/configuration; service still running.', flush=True)
    run('docker', 'save', '-o', BACKUP / 'old-image.tar', OLD_TAG)
    run('tar', '--acls', '--xattrs', '--numeric-owner', '-cpf', BACKUP / 'source-config.tar', '-C', SOURCE, '.')
    shutil.copy2(CONFIG, BACKUP / 'docker.env')
    print('2/3 Stopping this node and taking full consistent data backup.', flush=True)
    stopped = False
    switching = False
    try:
        stopped = True
        dc('stop', 'proxy')
        assert not inspect('container', CONTAINER)['State']['Running']
        run('tar', '--acls', '--xattrs', '--numeric-owner', '-cpf', BACKUP / 'data.tar', '-C', DATA, '.')
        for archive in ('source-config.tar', 'data.tar', 'old-image.tar'):
            run('tar', '-tf', BACKUP / archive)
        manifest['archives'] = {name: digest(BACKUP / name)
                                for name in ('source-config.tar', 'data.tar', 'old-image.tar', 'docker.env')}
        assert protected == {name: digest(DATA / name) for name in PROTECTED}
        manifest['backupComplete'] = True
        write_json(BACKUP / 'manifest.json', manifest)
        print('3/3 Switching to tested image and checking TLS/protocol/authentication.', flush=True)
        switching = True
        pin_image(NEW_TAG)
        dc('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'proxy')
        result = verify(20, NEW)
        assert protected == {name: digest(DATA / name) for name in PROTECTED}
        result.update(cutoverPerformed=True, rolledBack=False, backupVerified=True,
                      backupDirectory=str(BACKUP), imageId=NEW, clientAcceptancePending=True)
        write_json(STATE / 'cutover-result.json', result)
        print(json.dumps(result))
        print('PASS. Protocol 20 service is running; Windows client acceptance remains pending.')
    except Exception:
        if switching:
            rollback()
        elif stopped:
            run('docker', 'start', CONTAINER)
            verify(19, OLD)
        raise


if __name__ == '__main__':
    os.umask(0o077)
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    assert sys.argv[1:] in (['--idle-confirmed'], ['--rollback'])
    log = STATE / 'cutover-private.log'
    try:
        saved_script = STATE / 'cutover.py'
        if Path(__file__).resolve() != saved_script.resolve():
            shutil.copyfile(__file__, saved_script)
        if sys.argv[1] == '--rollback':
            rollback()
        else:
            cutover()
    except Exception as error:
        import traceback
        with log.open('a') as stream:
            traceback.print_exc(file=stream)
            if isinstance(error, subprocess.CalledProcessError) and error.output:
                stream.write(error.output + '\n')
        raise SystemExit('Stopped (%s). Private diagnostics: %s; report only this message and any rollback result.' % (type(error).__name__, log))
