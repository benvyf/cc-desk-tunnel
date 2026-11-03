#!/usr/bin/env python3
"""Prepare/cut over signed Build 10 on the three reviewed Ubuntu nodes; keep offline rollback."""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import traceback

ROOT = Path('/var/lib/cc-runtime-upgrade')
BUILD, PROTOCOL = 10, 23
RUNTIME = 'node24-cli2.1.295-v2'
LOCK = '09eb7a3b1b2814c72a6362ea2c150f0c3a3d5eb987651c88d3808410e8877de7'
OLD_LOCK = '3c85257d8835fb9016bb739df2f06b2097a2f171c2941b8569aa45ea005c5176'
NODE_VERSION = '24.22.2'
NODE_SHA = '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75'
CLI = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
HELPER_SHA = '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0'
BASELINES = {
    '27876f345c2992abf77b925686aedee2af9b151babeef46af2486afb361009ac': 4,
    'fc8afc4c71fe556135fc356aca8186a104943afe021fdc27bd4f43d41a86cad6': 5,
    '7684ad406a43fab7d645b14476ccaa5c543a17565b07cef352145dc5328d1d38': 8,
    'cada4c8f6d0329ee2797a17373a9094c5fd68ce065e1ad7b2196448c75917f84': 9,
}


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_release(fresh, data, expected):
    release = fresh.verify_index(data)
    need((release['build'], release['protocol'], release['appVersion'], release['runtimeLevel'],
          release['packageLockSha256'], release['sha256']) ==
         (BUILD, PROTOCOL, '0.3.7', RUNTIME, LOCK, expected),
         'Signed target changed or is not the reviewed Build 10; obtain a new command')
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
    need(BASELINES.get(baseline['descriptor']) == baseline['build'] and
         baseline['node'] == '24.21.0' and baseline['lock'] == OLD_LOCK,
         'Unknown original application/runtime baseline; no change')
    return False


def provision_node(fresh, work):
    content = fresh.download(f'https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz', 80 * 1024**2)
    need(hashlib.sha256(content).hexdigest() == NODE_SHA, 'Node archive checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(content), mode='r:xz') as archive:
        archive.extractall(work / 'node-extract', filter='data')
    target = work / 'runtime/node'
    target.parent.mkdir(exist_ok=True)
    (work / f'node-extract/node-v{NODE_VERSION}-linux-x64').rename(target)
    for directory in [target.parent, target] + [p for p in target.rglob('*') if p.is_dir()]:
        directory.chmod(0o755)


def dockerfile(base):
    return f'''FROM {base}
USER root
RUN rm -rf /app /opt/runtime/node && install -d -o ccdesktunnel -g ccdesktunnel /app
COPY --chown=root:root runtime/node/ /opt/runtime/node/
ENV PATH=/opt/runtime/node/bin:/opt/runtime/cli/bin:$PATH
COPY --chown=ccdesktunnel:ccdesktunnel program/ /app/
WORKDIR /app
USER ccdesktunnel
RUN npm_config_nodedir=/opt/runtime/node npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol --no-audit --no-fund && npm cache clean --force
USER root
COPY program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint
COPY program/deploy/docker/healthcheck.mjs /app/healthcheck.mjs
COPY program/deploy/docker/runtime-level /opt/runtime/level
RUN chmod 755 /usr/local/bin/proxy-entrypoint && chown -R root:root /app /opt/runtime/node && chmod -R go-w /app /opt/runtime/node
USER ccdesktunnel
WORKDIR /data/workspace
'''


def candidate_check(image, release):
    script = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(process.versions.node,'24.22.2');a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[2]);
const bytes=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(hash(bytes),process.argv[1]);const d=JSON.parse(bytes);
for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
a.equal(f.readFileSync('/opt/runtime/level','utf8').trim(),'2');
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');"""
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint',
        '/opt/runtime/node/bin/node', image, '-e', script, release['descriptorSha256'], CLI],
        check=True, capture_output=True, timeout=90)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    review = load('message_upgrade_support', Path(__file__).with_name('upgrade-message-review.py'))
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
        helper = Path(__file__).with_name('server-bootstrap.py')
        need(hashlib.sha256(helper.read_bytes()).hexdigest() == HELPER_SHA, 'Support helper changed')
        shutil.copyfile(helper, ROOT / 'helper.py')
        b = load('runtime_bootstrap_support', ROOT / 'helper.py')
        fresh = load('runtime_signed_release', Path(__file__).with_name('fresh-install.py'))
        fresh.ROOT = ROOT
        b.CONTAINER = review.NODES[node]
        original = b.Engine().request('GET', '/containers/' + b.CONTAINER + '/json')
        source = review.adapt(b, original)
        b.validate_runtime(original)
        baseline = verify_runtime(b.CONTAINER, node)
        release = verify_release(fresh, b.download('/cc-updates/server/v1/channels/pilot/linux-x64.json', 128 * 1024), args.sha256)
        if check_baseline(baseline, release):
            b.live_status(b.CONTAINER, release)
            print('ALREADY_INSTALLED: Build 10 / protocol 23 / Node 24.22.2; no change.')
            return
        # The old CLI binary, SDK version and read-only policy were authenticated above. Never execute Claude.
        b.runtime_and_policy = lambda container: verify_runtime(container, node)
        work = Path(tempfile.mkdtemp(prefix='build10-', dir=ROOT)); work.chmod(0o755)
        program = work / 'program'
        print('1/4 Verifying signed Build 10; current service remains running.', flush=True)
        archive = b.download('/cc-updates/server/v1/artifacts/10/linux-x64/cc-desk-tunnel-server-0.3.7-build10.tar.gz', 64 * 1024**2)
        b.unpack(archive, program, release)
        need(hashlib.sha256((program / 'package-lock.json').read_bytes()).hexdigest() == LOCK and
             (program / 'deploy/docker/runtime-level').read_text().strip() == '2', 'Candidate runtime/dependencies differ')
        identity = json.loads((program / 'deploy/managed-server.json').read_bytes())
        need(identity['runtimeLevel'] == RUNTIME and identity['keys'] == b.KEYS and identity['origin'] == b.ORIGIN,
             'Candidate trust or runtime identity differs')
        if args.cleanup:
            subprocess.run(['docker', 'builder', 'prune', '--all', '--force'], check=True, timeout=300)
        size = sum(p.stat().st_size for p in b.DATA.rglob('*') if p.is_file() and not p.is_symlink())
        need(shutil.disk_usage(ROOT).free >= size * 2 + 2 * 1024**3, 'Insufficient backup/preparation space; no cutover')
        base = 'cc-space-runtime-base:' + original['Image'].split(':')[-1][:12]
        image = 'cc-space-runtime:build10-' + release['sha256'][:12] + '-' + original['Image'].split(':')[-1][:12]
        subprocess.run(['docker', 'tag', original['Image'], base], check=True, capture_output=True)
        inspected = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True)
        if inspected.returncode:
            provision_node(fresh, work)
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
        if not args.install:
            print('PREPARED: no service changed. Use --install for the idle cutover.')
            return
        legacy = load('runtime_cutover', Path(__file__).with_name('install-cc-space-037.py'))
        legacy.ROOT, legacy.NODE, legacy.BASE, legacy.IMAGE = ROOT, node, original['Image'], image
        legacy.DESCRIPTOR, legacy.TARGET = release['descriptorSha256'], {'build': BUILD, 'protocol': PROTOCOL}
        clone = b.clone_config
        def clone_candidate(current, target):
            need(all(current[k] == original[k] for k in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')), 'Original configuration changed')
            now = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob('*') if p.is_file()}
            need(now == source_hashes, 'Administrator policy changed; rollback required')
            return review.with_policy(clone(current, target), policy)
        b.clone_config = clone_candidate
        print('3/4 Checking idle state, disconnecting clients, cold backup and image/policy cutover.', flush=True)
        legacy.install(b, disconnect_clients=True)
        print('4/4 SUCCESS: ' + node + ' / Build 10 / protocol 23 / Node 24.22.2.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) or type(error).__name__ == 'InstallError' else type(error).__name__
        print('Upgrade stopped: ' + reason + '. Keep the backup directory and inspect the local log.', file=sys.stderr)
        for frame in traceback.extract_tb(error.__traceback__):
            print('  ' + Path(frame.filename).name + ':' + str(frame.lineno) + ' in ' + frame.name, file=sys.stderr)
        raise SystemExit(1)
