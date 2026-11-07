#!/usr/bin/env python3
"""Prepare/cut over signed Build 20 on the three reviewed Ubuntu nodes; keep offline rollback."""
import argparse
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
BUILD, PROTOCOL = 20, 24
RUNTIME = 'node24-cli2.1.295-v3'
BASE_LOCK = '09eb7a3b1b2814c72a6362ea2c150f0c3a3d5eb987651c88d3808410e8877de7'
PREVIOUS_LOCK = 'ebf38fe28262d97e04e506b70fde86b89b20431262a5a50ca695c9c886830b92'
LOCK = '71e609c6c17673611360fe51dffc15dc3a205350e0acec6478f058a1ed7e630c'
NODE_VERSION = '24.22.2'
CLI = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
HELPER_SHA = '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0'
BASE_DESCRIPTOR = 'a366fbcf992cf5c76393e42a5f61231f079b13f3e67dffdd9bf673e5c8a3b94a'
BASELINES = {
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
PROGRAM = Path(__file__).resolve().parents[2]



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
         'Signed target changed or is not the reviewed Build 20; obtain a new command')
    return release


VERIFY_RUNTIME = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[1]);
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');
const bytes=f.readFileSync('/app/SERVER-RELEASE.json'),d=JSON.parse(bytes);
for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
for(const p of ['/opt/runtime/node/bin/node','/opt/runtime/cli/bin/claude','/etc/claude-code/managed-settings.json','/etc/claude-code/moderation-node.json']){const s=f.statSync(p);a(s.isFile()&&s.uid===0&&!(s.mode&18))}
const m=JSON.parse(f.readFileSync('/etc/claude-code/moderation-node.json'));a.equal(m.nodeId,process.argv[2]);
const u=new URL(m.endpoint);a(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/cc-updates/v1/moderation/check'&&/^[A-Za-z0-9_-]{43}$/.test(m.token));
const p=JSON.parse(f.readFileSync('/etc/claude-code/managed-settings.json'));a(p.disableAllHooks!==true);
const hook={hooks:[{type:'command',command:'/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts',timeout:10,onFailure:'block'}]};a(p.hooks.UserPromptSubmit.some(g=>require('util').isDeepStrictEqual(g,hook)));
for(const p of [process.env.HOME||'/data/home',process.env.PROXY_DATA_DIR||'/data/state',process.env.CLAUDE_CONFIG_DIR||'/data/home/.claude'])a(require('path').resolve(p).startsWith('/data/'));
console.log(JSON.stringify({descriptor:hash(bytes),build:d.build,protocol:d.protocol,node:process.versions.node,lock:hash(f.readFileSync('/app/package-lock.json'))}));"""


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
         baseline['node'] == NODE_VERSION and baseline['lock'] == (LOCK if baseline['build'] in (15, 16, 18, 19) else PREVIOUS_LOCK if baseline['build'] in (13, 14) else BASE_LOCK),
         'Unknown original application/runtime baseline; no change')
    return False


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
    script = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(process.versions.node,'24.22.2');a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[2]);
const bytes=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(hash(bytes),process.argv[1]);const d=JSON.parse(bytes);
for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
a.equal(f.readFileSync('/opt/runtime/level','utf8').trim(),'3');
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');"""
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint',
        '/opt/runtime/node/bin/node', image, '-e', script, release['descriptorSha256'], CLI],
        check=True, capture_output=True, timeout=90)
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint',
        '/opt/runtime/node/bin/node', image, '/app/deploy/docker/terminal-runtime.mjs', '--probe'],
        check=True, capture_output=True, timeout=30)


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
    need(os.geteuid() == 0 and node in review.NODES, 'Use sudo on ubuntu-cc / 02 / 03 only; 04/05/06 are not included')
    need(re.fullmatch('[a-f0-9]{64}', args.sha256), 'Invalid target digest')
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    review.protected(ROOT, True)
    need(not ROOT.stat().st_mode & 0o077, 'Expected a private root-only upgrade directory')
    import fcntl
    with (ROOT / 'upgrade.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_recovery_records()
        helper = PROGRAM / 'apps/update-service/web/server-bootstrap.py'
        need(hashlib.sha256(helper.read_bytes()).hexdigest() == HELPER_SHA, 'Support helper changed')
        shutil.copyfile(helper, ROOT / 'helper.py')
        b = load('runtime_bootstrap_support', ROOT / 'helper.py')
        fresh = load('runtime_signed_release', PROGRAM / 'apps/update-service/web/fresh-install.py')
        fresh.ROOT = ROOT
        for module in (b, fresh):
            original_download = module.download
            module.download = lambda *a, _download=original_download, **kw: retry_download(_download, *a, **kw)
        b.CONTAINER = review.NODES[node]
        original = b.Engine().request('GET', '/containers/' + b.CONTAINER + '/json')
        source = review.adapt(b, original)
        b.validate_runtime(original)
        baseline = verify_runtime(b.CONTAINER, node)
        release = verify_release(fresh, b.download('/cc-updates/server/v1/channels/pilot/linux-x64.json', 128 * 1024), args.sha256)
        need(release == confirmed, 'Published release changed; refresh and confirm again')
        if check_baseline(baseline, release):
            b.live_status(b.CONTAINER, release)
            print('ALREADY_INSTALLED: Build 20 / protocol 24 / Node 24.22.2; no change.')
            return
        legacy = load('runtime_cutover', PROGRAM / 'scripts/install-cc-space-037.py')
        legacy.ROOT, legacy.DATA, legacy.NODE = ROOT, b.DATA, node
        legacy.check_idle(b, original)
        if baseline['build'] >= 14:
            retain_previous_backup(b.CONTAINER)
        # All entrypoints, including the management-center host updater, must
        # reclaim safe cache without relying on callers to pass --cleanup.
        keep_image = f'cc-space-runtime:build{BUILD}-' + release['sha256'][:12] + '-' + original['Image'].split(':')[-1][:12]
        cleanup = load('host_update_cleanup', PROGRAM / 'deploy/host-update/cleanup.py')
        cleanup.clean(ROOT, PROGRAM, keep_image)
        legacy.check_space(reserve=2 * 1024**3)
        # The old CLI binary, SDK version and read-only policy were authenticated above. Never execute Claude.
        b.runtime_and_policy = lambda container: verify_runtime(container, node)
        work = Path(tempfile.mkdtemp(prefix=f'build{BUILD}-', dir=ROOT)); work.chmod(0o755)
        program = work / 'program'
        print('1/4 Verifying signed Build 20; current service remains running.', flush=True)
        archive = b.download(f"/cc-updates/server/v1/artifacts/{BUILD}/linux-x64/cc-desk-tunnel-server-{release['appVersion']}-build{BUILD}.tar.gz", 64 * 1024**2)
        b.unpack(archive, program, release)
        need(hashlib.sha256((program / 'package-lock.json').read_bytes()).hexdigest() == LOCK and
             (program / 'deploy/docker/runtime-level').read_text().strip() == '3', 'Candidate runtime/dependencies differ')
        identity = json.loads((program / 'deploy/managed-server.json').read_bytes())
        need(identity['runtimeLevel'] == RUNTIME and identity['keys'] == b.KEYS and identity['origin'] == b.ORIGIN,
             'Candidate trust or runtime identity differs')
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
            review.logged(['docker', 'build', '--pull=false', '-t', image, str(work)], work / 'build.log', timeout=1800)
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
        finish_preparation(legacy)
        if not args.install:
            print('PREPARED: no service changed. Use --install for the idle cutover.')
            return
        legacy.ROOT, legacy.NODE, legacy.BASE, legacy.IMAGE = ROOT, node, original['Image'], image
        legacy.DESCRIPTOR, legacy.TARGET = release['descriptorSha256'], {'build': BUILD, 'protocol': PROTOCOL}
        clone = b.clone_config
        def validate_cutover(current):
            need(review.same_configuration(current, original), 'Original configuration changed')
            now = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
            need(now == source_hashes, 'Administrator policy changed; rollback required')
        b.validate_cutover = validate_cutover
        def clone_candidate(current, target):
            validate_cutover(current)
            return review.with_policy(clone(current, target), policy)
        b.clone_config = clone_candidate
        print('3/4 Checking idle state, disconnecting clients, cold backup and image/policy cutover.', flush=True)
        legacy.install(b, disconnect_clients=True)
        retain_previous_backup(b.CONTAINER)
        print('4/4 SUCCESS: ' + node + ' / Build 20 / protocol 24 / Node 24.22.2.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) or type(error).__name__ == 'InstallError' else type(error).__name__
        print('Upgrade stopped: ' + reason + '. Keep the backup directory and inspect the local log.', file=sys.stderr)
        for frame in traceback.extract_tb(error.__traceback__):
            print('  ' + Path(frame.filename).name + ':' + str(frame.lineno) + ' in ' + frame.name, file=sys.stderr)
        raise SystemExit(1)
