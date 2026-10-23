#!/usr/bin/env python3
"""Cut over only the accepted ubuntu-cc native-review image; retain data on rollback."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import time
import traceback

COMMIT = 'ff5743958cb8fd7529b59364d8930168c0e53fc6'
IMAGE = 'sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f'
BASE = 'sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24'
TAG = 'cc-desk-tunnel:native-paths-ff5743958cb8'
STATE = Path('/var/lib/cc-native-terminal-paths-ff5743958cb8')
WORK = STATE / 'activation'
BACKUP = WORK / 'backup'
MANAGED = WORK / 'managed'
DATA = Path('/srv/cc-desk-tunnel')
SOURCE = Path('/opt/cc-desk-tunnel')
CONFIG = SOURCE / '.local/docker.env'
COMPOSE = SOURCE / 'deploy/docker/compose.yaml'
SERVICE_ENV = DATA / 'config/service.env'
NODE_CONFIG = DATA / 'config/moderation-node.json'
PROJECT = 'cc-desk-tunnel-ba938975'
CONTAINER = PROJECT + '-proxy-1'
ENDPOINT = 'https://api.ghostapi.org/cc-updates/v1/moderation/check'
POLICY_TARGET = '/etc/claude-code'
ENV_KEY = 'PROXY_NATIVE_TERMINAL_REVIEW'
BACKUP_FILES = ('docker.env', 'service.env', 'compose.yaml')
PROTECTED = ('config/moderation-node.json', 'config/provider.json', 'tls/control.crt',
             'tls/control.key', 'home/.claude/settings.json',
             'home/.claude/.credentials.json', 'home/.claude.json')
EVENTS = ('UserPromptSubmit', 'PostToolBatch', 'UserPromptExpansion', 'PreCompact')
POLICY = {'hooks': {event: [{'hooks': [{'type': 'command',
    'command': '/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts',
    'timeout': 10, 'onFailure': 'block'}]}] for event in EVENTS}}


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, input=None, timeout=180):
    return subprocess.check_output([str(arg) for arg in args], input=input, text=True,
                                   stderr=subprocess.STDOUT, timeout=timeout).strip()


def inspect(kind, name):
    return json.loads(run('docker', kind, 'inspect', name))[0]


def dc(*args, config=None, compose=None):
    config = CONFIG if config is None else config
    compose = COMPOSE if compose is None else compose
    # Staged files must resolve relative paths exactly like the original Compose file.
    return run('docker', 'compose', '--project-directory', COMPOSE.parent,
               '--env-file', config, '-p', PROJECT, '-f', compose, *args)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def regular(path):
    need(path.is_absolute(), 'Expected an absolute managed path')
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'Managed paths must not contain symlinks')
    need(stat.S_ISREG(path.stat().st_mode), 'Expected a regular managed file')


def root_directory(path, mode):
    path.mkdir(mode=mode, exist_ok=True)
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'Managed directory must not contain symlinks')
    info = path.stat()
    need(info.st_uid == 0 and stat.S_ISDIR(info.st_mode), 'Managed directory must be root owned')
    path.chmod(mode)


def replace_file(path, data):
    """Replace one regular file atomically, preserving its existing owner and permissions."""
    regular(path)
    owner = path.stat()
    descriptor, temporary = tempfile.mkstemp(prefix='.native-review-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            if hasattr(os, 'fchown'):
                os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
            os.chmod(temporary, stat.S_IMODE(owner.st_mode))
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private_file(path, data, mode=0o600):
    if path.exists():
        regular(path)
        need(path.stat().st_uid == 0, 'Private state must be root owned')
    else:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        os.close(descriptor)
    replace_file(path, data)
    path.chmod(mode)


def write_json(path, value):
    private_file(path, (json.dumps(value, indent=2) + '\n').encode())


def env_pattern(key):
    return re.compile(rb'^[ \t]*(?:export[ \t]+)?' + key.encode() + rb'[ \t]*=[^\n]*', re.M)


def assignment(content, key):
    matches = list(env_pattern(key).finditer(content))
    need(len(matches) <= 1, 'Duplicate managed environment setting: ' + key)
    return matches[0].group() if matches else None


def env_value(content, key):
    line = assignment(content, key)
    return None if line is None else line.split(b'=', 1)[1].strip().strip(b'\'"').decode()


def set_assignment(content, key, line):
    old = assignment(content, key)
    if old is None:
        if line is None:
            return content
        return content + (b'' if not content or content.endswith(b'\n') else b'\n') + line + b'\n'
    if line is None:
        return re.sub(env_pattern(key).pattern + rb'\n?', b'', content, count=1, flags=re.M)
    return env_pattern(key).sub(lambda _: line, content, count=1)


def mount_block():
    return ('      - type: bind\n        source: ' + str(MANAGED) +
            '\n        target: /etc/claude-code\n        read_only: true\n'
            '        bind:\n          create_host_path: false\n').encode()


def add_mount(content):
    anchor = b'    volumes:\n      - "${DATA_DIR:?Run manage.sh init}:/data"\n'
    need(content.count(anchor) == 1 and b'/etc/claude-code' not in content,
         'Unexpected Compose volume layout; inspect instead of guessing')
    return content.replace(anchor, anchor + mount_block(), 1)


def mounts(container):
    return sorted((m['Type'], m['Source'], m['Destination'], m['RW']) for m in container['Mounts'])


def check_container_layout(container, enabled):
    expected = [('bind', str(DATA), '/data', True)]
    if enabled:
        expected.append(('bind', str(MANAGED), POLICY_TARGET, False))
    need(mounts(container) == sorted(expected), 'Unexpected production data/policy mount')
    labels = container['Config'].get('Labels') or {}
    need(labels.get('com.docker.compose.project') == PROJECT and
         labels.get('com.docker.compose.service') == 'proxy', 'Unexpected Compose owner')


def protected_hashes():
    result = {}
    for name in PROTECTED:
        path = DATA / name
        if path.exists():
            regular(path)
            result[name] = digest(path)
    return result


def check_protected(expected):
    need(protected_hashes() == expected, 'Account, node configuration or TLS files changed')


def runtime_unchanged(before, after):
    need(after['Config']['Env'] == before['Config']['Env'], 'Container environment changed')
    for key in ('NetworkMode', 'Dns', 'DnsSearch', 'ExtraHosts', 'PortBindings',
                'SecurityOpt', 'CapDrop', 'RestartPolicy', 'ReadonlyRootfs', 'Privileged'):
        need(after['HostConfig'].get(key) == before['HostConfig'].get(key),
             'Container routing/security setting changed: ' + key)


def accepted():
    result = json.loads((STATE / 'result.json').read_text())
    need(result.get('sourceCommit') == COMMIT and result.get('imageId') == IMAGE,
         'Accepted candidate identity mismatch')
    yes = ('inputPathAcceptancePassed', 'protectedFilesAndRuntimeUnchanged', 'productionUnchanged',
           'nativePromptReviewed', 'nativeQuestionAnswerReviewed', 'compactInstructionsReviewed',
           'sdkCompatible', 'queuedPromptReviewed', 'unsupportedCommandExpansionBlocked',
           'resumedHistoryReviewed', 'permissionDenialFeedbackReviewed', 'permissionAmendFeedbackReviewed')
    no = ('cutoverPerformed', 'rejectedPromptReachedSimulatedModel',
          'rejectedAnswerReachedSimulatedModel', 'rejectedCompactReachedSimulatedModel')
    need(all(result.get(key) is True for key in yes) and
         all(result.get(key) is False for key in no), 'Candidate acceptance is incomplete')
    need(result.get('realModelRequests') == result.get('realJevRequests') == 0,
         'Candidate was not verified offline')
    need(result.get('restrictions') == ['direct-prompt-command-expansions-blocked'],
         'Unexpected candidate restriction')
    need(inspect('image', TAG)['Id'] == IMAGE, 'Candidate tag changed')
    return result


OFFLINE_JS = r'''
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertNativeTerminalReview,nativeTerminalPolicy} from '/app/apps/server/src/native-terminal-policy.ts';
assert.deepEqual(JSON.parse(readFileSync('/etc/claude-code/managed-settings.json','utf8')),nativeTerminalPolicy());
assert.equal(assertNativeTerminalReview('claude'),'/opt/runtime/cli/bin/claude');
console.log('OFFLINE_POLICY_OK');
'''


def stage():
    for path in (CONFIG, COMPOSE, SERVICE_ENV, NODE_CONFIG):
        regular(path)
    need(DATA.is_dir() and not DATA.is_symlink() and (DATA / '.cc-desk-tunnel-data').is_file(),
         'Production data marker missing')
    need(env_value(SERVICE_ENV.read_bytes(), 'PROXY_MODERATION_CONFIG') == '/data/config/moderation-node.json',
         'Existing chat moderation configuration must remain enabled')
    need(env_value(SERVICE_ENV.read_bytes(), ENV_KEY) in (None, '0'), 'Native review is already configured')
    node = json.loads(NODE_CONFIG.read_text())
    need(set(node) == {'endpoint', 'nodeId', 'token'} and node['endpoint'] == ENDPOINT and
         node['nodeId'] == 'ubuntu-cc' and isinstance(node['token'], str) and
         re.fullmatch(r'[A-Za-z0-9_-]{43}', node['token']), 'Invalid existing node configuration')
    root_directory(MANAGED, 0o755)
    policy = run('docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
                 '--security-opt=no-new-privileges', '--entrypoint', 'cat', IMAGE,
                 POLICY_TARGET + '/managed-settings.json')
    need(json.loads(policy) == POLICY, 'Candidate policy differs from the accepted command hooks')
    private_file(MANAGED / 'managed-settings.json', (policy + '\n').encode(), 0o644)
    private_file(MANAGED / 'moderation-node.json', NODE_CONFIG.read_bytes(), 0o644)
    need(run('docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
             '--security-opt=no-new-privileges', '--memory=512m', '--pids-limit=128',
             '--tmpfs=/tmp:rw,nosuid,size=64m',
             '--mount', 'type=bind,src=' + str(MANAGED) + ',dst=' + POLICY_TARGET + ',readonly',
             '--entrypoint', '/opt/runtime/node/bin/node', IMAGE,
             '--input-type=module', '-e', OFFLINE_JS) == 'OFFLINE_POLICY_OK',
         'Offline mounted-policy verification failed')
    before = json.loads(dc('config', '--format', 'json'))
    need(set(before['services']) == {'proxy'}, 'Unexpected Compose services')
    need(inspect('image', before['services']['proxy']['image'])['Id'] == BASE,
         'Compose no longer selects the current chat-moderation image')
    volumes = before['services']['proxy']['volumes']
    need(len(volumes) == 1 and volumes[0].get('type') == 'bind' and
         volumes[0].get('source') == str(DATA) and volumes[0].get('target') == '/data' and
         not volumes[0].get('read_only'), 'Unexpected Compose data volume')
    need(assignment(CONFIG.read_bytes(), 'PROXY_IMAGE') is not None, 'Managed image assignment missing')
    private_file(WORK / 'docker.next.env', set_assignment(CONFIG.read_bytes(), 'PROXY_IMAGE',
                 ("PROXY_IMAGE='" + TAG + "'").encode()))
    private_file(WORK / 'service.next.env', set_assignment(SERVICE_ENV.read_bytes(), ENV_KEY,
                 (ENV_KEY + '=1').encode()))
    private_file(WORK / 'compose.next.yaml', add_mount(COMPOSE.read_bytes()))
    expected = copy.deepcopy(before)
    expected['services']['proxy']['image'] = TAG
    actual = json.loads(dc('config', '--format', 'json', config=WORK / 'docker.next.env',
                           compose=WORK / 'compose.next.yaml'))
    new_volumes = actual['services']['proxy'].get('volumes', [])
    additions = [v for v in new_volumes if v.get('target') == POLICY_TARGET]
    need(len(additions) == 1, 'Staged policy mount missing or duplicated')
    added = additions[0]
    need(set(added) <= {'type', 'source', 'target', 'read_only', 'bind'} and
         added.get('type') == 'bind' and added.get('source') == str(MANAGED) and
         added.get('read_only') is True and
         set(added.get('bind', {})) <= {'create_host_path'} and
         not added.get('bind', {}).get('create_host_path', False), 'Staged policy mount is not read only')
    expected['services']['proxy']['volumes'].append(added)
    need(actual == expected, 'Staged Compose changes more than the image and read-only policy mount')
    return protected_hashes()


IDLE_JS = r'''
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const db=new DatabaseSync(join(process.env.PROXY_DATA_DIR,'sessions.sqlite'),{readOnly:true});
const {n}=db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(metadata,'$.activeRun') IS NOT NULL").get();
db.close();
let connections=0;
for(const path of ['/proc/net/tcp','/proc/net/tcp6']) {
  for(const row of readFileSync(path,'utf8').trim().split('\n').slice(1)) {
    const fields=row.trim().split(/\s+/);
    if(fields[3]==='01' && Number.parseInt(fields[1].split(':').at(-1),16)===8787)connections++;
  }
}
console.log('NATIVE_ACTIVATION_RESULT '+JSON.stringify({activeRuns:n,controlConnections:connections}));
'''


def parse_report(output):
    rows = [line.removeprefix('NATIVE_ACTIVATION_RESULT ') for line in output.splitlines()
            if line.startswith('NATIVE_ACTIVATION_RESULT ')]
    need(len(rows) == 1, 'Missing or ambiguous verification report')
    return json.loads(rows[0])


def idle():
    value = parse_report(run('docker', 'exec', '-i', CONTAINER, 'node',
        '--env-file=/data/config/service.env', '--input-type=module', '-', input=IDLE_JS))
    need(value == {'activeRuns': 0, 'controlConnections': 0},
         'Node is busy or a client is still connected; no cutover performed')


VERIFY_JS = r'''
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import https from 'node:https';
const enabled=__ENABLED__;
const {environmentConfig}=await import('/app/apps/server/src/config.ts');
const {options}=environmentConfig(process.env,'/data/state');
assert.equal(Boolean(options.nativeTerminalReview),enabled);
assert.equal(options.moderation.nodeId,'ubuntu-cc');
assert.equal(options.moderation.endpoint,'https://api.ghostapi.org/cc-updates/v1/moderation/check');
let managedPolicyVerified=false;
if(enabled){
  const {assertNativeTerminalReview}=await import('/app/apps/server/src/native-terminal-policy.ts');
  assertNativeTerminalReview(options.claude.executable);
  const native=JSON.parse(readFileSync('/etc/claude-code/moderation-node.json','utf8'));
  const chat=JSON.parse(readFileSync('/data/config/moderation-node.json','utf8'));
  assert.equal(native.nodeId,chat.nodeId);assert.equal(native.endpoint,chat.endpoint);
  assert.ok(native.token===chat.token,'Node credential mismatch');
  managedPolicyVerified=true;
}
const cli=execFileSync('/opt/runtime/cli/bin/claude',['--version'],{encoding:'utf8',timeout:5000}).trim();
assert.equal(cli,enabled?'2.1.295 (Claude Code)':'2.1.293 (Claude Code)');
const sdk=JSON.parse(readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json','utf8')).version;
assert.equal(sdk,'0.3.286');
const ca=readFileSync(process.env.PROXY_TLS_CERT);
assert.equal(new X509Certificate(ca).fingerprint256.replaceAll(':','').toLowerCase(),
 '7c08ee9eaa52b39bdaf64b63fbfdbe163b4614519da315c5b5f68a1ea183a82e');
const tls={ca,servername:process.env.PROXY_CERT_NAME,allowPartialTrustChain:true};
const health=await new Promise((resolve,reject)=>{
 const req=https.get({host:'127.0.0.1',port:8787,path:'/health',...tls},res=>{
  let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{
   assert.equal(res.statusCode,200);resolve(JSON.parse(text));}catch(e){reject(e);}});
 });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('Health timeout')));
});
assert.equal(health.protocolVersion,20);assert.equal(health.adapter,'claude-code');
const {WebSocket}=createRequire('/app/apps/server/package.json')('ws');
await new Promise((resolve,reject)=>{
 const ws=new WebSocket('wss://127.0.0.1:8787/ws',tls);
 const timer=setTimeout(()=>done(new Error('Control authentication timeout')),10000);
 function done(error){clearTimeout(timer);ws.terminate();error?reject(error):resolve();}
 ws.on('error',done);
 ws.on('open',()=>ws.send(JSON.stringify({type:'auth',protocolVersion:20,
  token:process.env.PROXY_TOKEN,deviceName:'native-activation-check'})));
 ws.on('message',bytes=>{try{
  const m=JSON.parse(bytes);
  if(m.type==='connection.error')throw new Error('Control authentication failed');
  if(m.type==='ready')done();
 }catch(e){done(e);}});
});
// No terminal.open, messages, compact, continue or moderation HTTP request.
console.log('NATIVE_ACTIVATION_RESULT '+JSON.stringify({protocol:20,controlAuthenticated:true,tlsUnchanged:true,
 chatModerationEnabled:true,nativeTerminalReviewEnabled:enabled,managedPolicyVerified,
 officialCliVersion:enabled?'2.1.295':'2.1.293',sdkVersion:sdk,
 realModelRequests:0,realJevRequests:0,realTerminalOpened:false}));
'''


def verify(image, enabled):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        current = inspect('container', CONTAINER)
        need(current['Image'] == image, 'Unexpected running image')
        if current['State'].get('Health', {}).get('Status') == 'healthy':
            break
        time.sleep(1)
    else:
        raise RuntimeError('Service health deadline exceeded')
    check_container_layout(current, enabled)
    return parse_report(run('docker', 'exec', '-i', CONTAINER, 'node',
        '--env-file=/data/config/service.env', '--input-type=module', '-',
        input=VERIFY_JS.replace('__ENABLED__', str(enabled).lower()), timeout=45))


def preflight():
    accepted()
    need(not BACKUP.exists(), 'An activation backup already exists; inspect or use rollback')
    current = inspect('container', CONTAINER)
    recorded = json.loads((STATE / 'production-before.json').read_text())
    need([current['Id'], current['Image'], current['State']['StartedAt']] ==
         [recorded['Id'], BASE, recorded['State']['StartedAt']],
         'Production identity changed since candidate verification')
    need(current['State']['Running'] and current['State']['Health']['Status'] == 'healthy',
         'Current production is not healthy')
    check_container_layout(current, False)
    base_config, candidate_config = inspect('image', BASE)['Config'], inspect('image', IMAGE)['Config']
    for key in ('Env', 'Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Healthcheck'):
        need(base_config.get(key) == candidate_config.get(key),
             'Candidate image runtime configuration changed: ' + key)
    need(not any(e.startswith(ENV_KEY + '=') for e in current['Config']['Env']),
         'Container environment overrides the native-review setting')
    protected = stage()
    verify(BASE, False)
    return current, protected


def backup(before, protected):
    root_directory(BACKUP, 0o700)
    paths = (CONFIG, SERVICE_ENV, COMPOSE)
    for name, path in zip(BACKUP_FILES, paths):
        private_file(BACKUP / name, path.read_bytes())
    private_file(BACKUP / 'production.json', (json.dumps(before) + '\n').encode())
    manifest = {'sourceCommit': COMMIT, 'baseImage': BASE, 'imageId': IMAGE,
                'protected': protected, 'backupComplete': False,
                'files': {name: digest(BACKUP / name) for name in (*BACKUP_FILES, 'production.json')}}
    write_json(BACKUP / 'manifest.json', manifest)
    return manifest


def restore_settings(dry_run=False):
    manifest = json.loads((BACKUP / 'manifest.json').read_text())
    need(manifest['baseImage'] == BASE and manifest['imageId'] == IMAGE and
         manifest['sourceCommit'] == COMMIT, 'Backup identity mismatch')
    for path in (CONFIG, SERVICE_ENV, COMPOSE):
        regular(path)
    original_image = env_value((BACKUP / 'docker.env').read_bytes(), 'PROXY_IMAGE')
    need(original_image and inspect('image', original_image)['Id'] == BASE,
         'Original image tag changed or is unavailable; inspect before rollback')
    # The data archive is never restored automatically, even for a later rollback.
    for name in (*BACKUP_FILES, 'production.json'):
        need(digest(BACKUP / name) == manifest['files'][name], 'Backup checksum mismatch')
    edits = ((CONFIG, 'docker.env', 'docker.next.env', 'PROXY_IMAGE'),
             (SERVICE_ENV, 'service.env', 'service.next.env', ENV_KEY))
    replacements = []
    for path, old_name, next_name, key in edits:
        original = (BACKUP / old_name).read_bytes()
        deployed = (WORK / next_name).read_bytes()
        current = path.read_bytes()
        old_line, new_line, current_line = (assignment(value, key) for value in (original, deployed, current))
        need(current_line in (old_line, new_line), 'Managed setting changed after activation: ' + key)
        target = original if current == deployed else set_assignment(current, key, old_line)
        replacements.append((path, target))
    original, deployed, current = ((BACKUP / 'compose.yaml').read_bytes(),
                                  (WORK / 'compose.next.yaml').read_bytes(), COMPOSE.read_bytes())
    if current == deployed:
        target = original
    elif mount_block() in current:
        need(current.count(mount_block()) == 1, 'Unexpected policy mount changes')
        target = current.replace(mount_block(), b'', 1)
    else:
        need(b'/etc/claude-code' not in current, 'Policy mount was modified; inspect before rollback')
        target = current
    replacements.append((COMPOSE, target))
    # Resolve every conflict before changing any configuration file.
    if not dry_run:
        for path, content in replacements:
            replace_file(path, content)
    return manifest


def rollback(automatic=False):
    found = run('docker', 'container', 'ls', '--all', '--filter',
                'name=^/' + CONTAINER + '$', '--format', '{{.ID}}')
    need('\n' not in found, 'Ambiguous production container')
    current = inspect('container', CONTAINER) if found else None
    if current is not None:
        need(current['Image'] in (BASE, IMAGE), 'Unexpected image; refuse to roll it back')
        check_container_layout(current, current['Image'] == IMAGE)
    if not automatic and current is not None and current['State']['Running']:
        idle()
    # Validate the backup and all merge conflicts before stopping a working service.
    # restore_settings is applied only after stop, so precompute with dry_run below.
    restore_settings(dry_run=True)
    dc('stop', 'proxy')
    restore_settings()
    try:
        dc('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'proxy')
        result = verify(BASE, False)
        before = json.loads((BACKUP / 'production.json').read_text())
        runtime_unchanged(current if current is not None else before, inspect('container', CONTAINER))
    except Exception:
        raise RuntimeError('Rollback could not verify the original service; private diagnostics required') from None
    result.update(rolledBack=True, cutoverPerformed=False, dataRestored=False,
                  imageId=BASE, backupDirectory=str(BACKUP), rollbackAutomatic=automatic)
    write_json(WORK / 'activation-result.json', result)
    print(json.dumps(result), flush=True)
    return result


def activate():
    print('1/4 Checking accepted image, existing node configuration and mounted policy offline.', flush=True)
    before, protected = preflight()
    idle()
    allocated = int(run('du', '-sb', DATA).split()[0])
    need(shutil.disk_usage(WORK).free > allocated * 2 + 512 * 1024**2, 'Insufficient local backup space')
    manifest = backup(before, protected)
    stopped = changed = False
    try:
        print('2/4 Stopping this idle node and creating a consistent local data archive.', flush=True)
        idle()
        check_protected(protected)
        stopped = True
        dc('stop', 'proxy')
        need(not inspect('container', CONTAINER)['State']['Running'], 'Service did not stop')
        run('tar', '--acls', '--xattrs', '--numeric-owner', '--sparse', '-cpf',
            BACKUP / 'data.tar', '-C', DATA, '.', timeout=1800)
        run('tar', '-tf', BACKUP / 'data.tar', timeout=1800)
        manifest['files']['data.tar'] = digest(BACKUP / 'data.tar')
        manifest['backupComplete'] = True
        write_json(BACKUP / 'manifest.json', manifest)
        # A post-stop hook or another administrator must not change any staged input.
        for name, path in zip(BACKUP_FILES, (CONFIG, SERVICE_ENV, COMPOSE)):
            need(digest(path) == manifest['files'][name], 'Configuration changed during backup')
        check_protected(protected)
        need(inspect('image', TAG)['Id'] == IMAGE, 'Candidate tag changed during backup')
        print('3/4 Installing only the accepted image, review opt-in and read-only managed mount.', flush=True)
        changed = True
        for path, name in ((CONFIG, 'docker.next.env'), (SERVICE_ENV, 'service.next.env'),
                           (COMPOSE, 'compose.next.yaml')):
            replace_file(path, (WORK / name).read_bytes())
        dc('up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'proxy')
        print('4/4 Verifying health, TLS, control authentication and policy; no terminal/model input.', flush=True)
        result = verify(IMAGE, True)
        runtime_unchanged(before, inspect('container', CONTAINER))
        check_protected(protected)
        result.update(cutoverPerformed=True, rolledBack=False, imageId=IMAGE, sourceCommit=COMMIT,
                      readOnlyPolicyMountVerified=True, credentialsAndRoutingUnchanged=True,
                      backupDirectory=str(BACKUP), clientAcceptancePending=True)
        write_json(WORK / 'activation-result.json', result)
        print(json.dumps(result), flush=True)
        print('PASS. Reviewed native terminal enabled; real user/client acceptance remains pending.', flush=True)
    except Exception:
        if changed:
            rollback(automatic=True)
        elif stopped:
            run('docker', 'start', CONTAINER)
            verify(BASE, False)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true', help='Stage and check; do not stop or reconfigure production')
    group.add_argument('--activate', action='store_true')
    group.add_argument('--rollback', action='store_true')
    parser.add_argument('--idle-confirmed', action='store_true', help='User currently confirms idle and all clients disconnected')
    args = parser.parse_args()
    need(os.name == 'posix' and os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc',
         'Run as root on ubuntu-cc only')
    need(args.check or args.idle_confirmed, 'Activation and rollback require a fresh idle/client-disconnect confirmation')
    os.umask(0o077)
    root_directory(STATE, 0o700)
    root_directory(WORK, 0o700)
    import fcntl
    with (WORK / 'activation.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        saved = WORK / 'activate-native-terminal.py'
        if Path(__file__).resolve() != saved.resolve():
            if BACKUP.exists():
                need(saved.is_file() and saved.read_bytes() == Path(__file__).read_bytes(),
                     'Keep the saved activation/rollback script for this cutover')
            else:
                private_file(saved, Path(__file__).read_bytes(), 0o700)
        try:
            if args.check:
                preflight()
                report = dict(preflightPassed=True, productionUnchanged=True, cutoverPerformed=False,
                              imageId=IMAGE, realModelRequests=0, realJevRequests=0)
                write_json(WORK / 'preflight-result.json', report)
                print(json.dumps(report), flush=True)
            elif args.rollback:
                rollback()
            else:
                activate()
        except Exception as error:
            details = traceback.format_exc()
            if isinstance(error, subprocess.CalledProcessError) and error.output:
                details += '\n' + error.output
            write_json(WORK / 'activation-error.json', {'error': details})
            raise SystemExit('Operation stopped. Check any rollback JSON above. Private diagnostics: ' + str(WORK))


if __name__ == '__main__':
    main()
