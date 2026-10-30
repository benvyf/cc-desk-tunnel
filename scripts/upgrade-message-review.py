#!/usr/bin/env python3
"""Install the signed message-only review image on ubuntu-cc / 02 / 03."""
import argparse
import copy
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

ROOT = Path('/var/lib/cc-message-review-upgrade')
BUILD = 9
LOCK = '3c85257d8835fb9016bb739df2f06b2097a2f171c2941b8569aa45ea005c5176'
CLI = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
BASELINES = {
    '27876f345c2992abf77b925686aedee2af9b151babeef46af2486afb361009ac': 4,
    'fc8afc4c71fe556135fc356aca8186a104943afe021fdc27bd4f43d41a86cad6': 5,
    '7684ad406a43fab7d645b14476ccaa5c543a17565b07cef352145dc5328d1d38': 8,
}
NODES = {
    'ubuntu-cc': 'cc-desk-tunnel-ba938975-proxy-1',
    'ubuntu-cc-02': 'cc-desk-tunnel-96ccb91a-proxy-1',
    'ubuntu-cc-03': 'cc-desk-tunnel-4b35c593-proxy-1',
}


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def protected(path, directory=False):
    need(path.is_absolute() and not any(p.is_symlink() for p in (path, *path.parents)), 'Unsafe managed path')
    info = path.stat()
    need(info.st_uid == 0 and not info.st_mode & 0o022 and
         (path.is_dir() if directory else path.is_file()), 'Expected root-owned protected file or directory')


def adapt(support, original):
    # All original structural checks remain; accept this node's protected policy source.
    mounts = original.get('Mounts', [])
    policy = [m for m in mounts if m['Destination'] == '/etc/claude-code']
    need(len(policy) == 1 and policy[0]['Type'] == 'bind' and not policy[0]['RW'], 'Expected one read-only policy bind')
    source = Path(policy[0]['Source'])
    protected(source, True)
    protected(source / 'managed-settings.json')
    protected(source / 'moderation-node.json')
    validate = support.validate_runtime

    def validate_current(value):
        need(value['Id'] == original['Id'] and value['Image'] == original['Image'] and
             value['Mounts'] == mounts, 'Original container or mounts changed')
        normalized = copy.deepcopy(value)
        for mount in normalized['Mounts']:
            if mount['Destination'] == '/etc/claude-code':
                mount['Source'] = '/etc/claude-code'
        validate(normalized)
    support.validate_runtime = validate_current
    return source


VERIFY_RUNTIME = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict');
const hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(process.versions.node.split('.')[0],'24');a.equal(process.arch,'x64');
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[1]);
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');
const bytes=f.readFileSync('/app/SERVER-RELEASE.json'),d=JSON.parse(bytes);
a.equal(hash(f.readFileSync('/app/package-lock.json')),process.argv[2]);
for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
for(const p of ['/opt/runtime/node/bin/node','/opt/runtime/cli/bin/claude','/etc/claude-code/managed-settings.json','/etc/claude-code/moderation-node.json']){const s=f.statSync(p);a(s.isFile()&&s.uid===0&&!(s.mode&18))}
const m=JSON.parse(f.readFileSync('/etc/claude-code/moderation-node.json'));a.equal(m.nodeId,process.argv[3]);
const u=new URL(m.endpoint);a(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/cc-updates/v1/moderation/check'&&/^[A-Za-z0-9_-]{43}$/.test(m.token));
for(const p of [process.env.HOME||'/data/home',process.env.PROXY_DATA_DIR||'/data/state',process.env.CLAUDE_CONFIG_DIR||'/data/home/.claude'])a(require('path').resolve(p).startsWith('/data/'));
console.log(JSON.stringify({descriptor:hash(bytes),build:d.build,protocol:d.protocol}));"""


def verify_runtime(container, node):
    result = subprocess.run(['docker', 'exec', container, '/opt/runtime/node/bin/node',
        '--env-file=/data/config/service.env', '-e', VERIFY_RUNTIME, CLI, LOCK, node],
        check=True, capture_output=True, timeout=90)
    return json.loads(result.stdout)


def candidate_check(image, release):
    check = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict'),hash=b=>c.createHash('sha256').update(b).digest('hex');
const b=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(hash(b),process.argv[1]);const d=JSON.parse(b);
for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[2]);"""
    subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint',
        '/opt/runtime/node/bin/node', image, '-e', check, release['descriptorSha256'], CLI],
        check=True, capture_output=True, timeout=90)


def logged(args, log, timeout=600):
    with log.open('ab') as output:
        process = subprocess.Popen(args, stdout=output, stderr=output)
        started = time.monotonic()
        try:
            while True:
                try:
                    need(process.wait(timeout=15) == 0, 'Build failed; inspect ' + str(log))
                    return
                except subprocess.TimeoutExpired:
                    elapsed = int(time.monotonic() - started)
                    print('RUNNING: ' + str(elapsed) + 's; log=' + str(log), flush=True)
                    need(elapsed < timeout, 'Build timed out; inspect the preparation log')
        except BaseException:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            raise


def policy_copy(source, destination, program):
    # Never change the old bind: switching the new container's bind makes rollback paired.
    for path in source.rglob('*'):
        protected(path, path.is_dir())
    shutil.copytree(source, destination)
    destination.chmod(0o755)
    config = load('message_policy', program / 'deploy/configure-moderation.py')
    policy = config.message_policy(json.loads((source / 'managed-settings.json').read_bytes()))
    (destination / 'managed-settings.json').write_text(json.dumps(policy, indent=2) + '\n')
    (destination / 'managed-settings.json').chmod(0o644)
    (destination / 'moderation-node.json').chmod(0o644)
    return policy


def with_policy(config, policy):
    result = copy.deepcopy(config)
    host = result['HostConfig']
    count = 0
    for i, binding in enumerate(host.get('Binds') or []):
        parts = binding.split(':')
        if len(parts) >= 2 and parts[1] == '/etc/claude-code':
            need(len(parts) == 3 and parts[2] == 'ro', 'Unexpected policy bind options')
            host['Binds'][i] = str(policy) + ':/etc/claude-code:ro'
            count += 1
    for mount in host.get('Mounts') or []:
        if mount.get('Target') == '/etc/claude-code':
            need(mount.get('Type') == 'bind' and mount.get('ReadOnly'), 'Unexpected policy mount options')
            mount['Source'] = str(policy)
            count += 1
    need(count == 1, 'Expected exactly one replaceable policy binding')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    node = socket.gethostname().split('.')[0]
    need(os.geteuid() == 0 and node in NODES, 'Use sudo on ubuntu-cc / 02 / 03 only')
    need(re.fullmatch('[a-f0-9]{64}', args.sha256), 'Invalid target digest')
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    protected(ROOT, True)
    import fcntl
    with (ROOT / 'upgrade.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        support_path = Path(__file__).with_name('server-bootstrap.py')
        need(hashlib.sha256(support_path.read_bytes()).hexdigest() ==
             '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0', 'Support helper changed')
        shutil.copyfile(support_path, ROOT / 'helper.py')
        b = load('bootstrap_support', ROOT / 'helper.py')
        b.CONTAINER = NODES[node]
        b.PROFILE['files']['package-lock.json'] = LOCK
        engine = b.Engine()
        original = engine.request('GET', '/containers/' + b.CONTAINER + '/json')
        source = adapt(b, original)
        b.validate_runtime(original)
        baseline = verify_runtime(b.CONTAINER, node)
        index = b.download('/cc-updates/server/v1/channels/pilot/linux-x64.json', 128 * 1024)
        release = b.verify_index(index, original['Image'], BUILD, args.sha256)['release']
        if baseline['descriptor'] == release['descriptorSha256']:
            b.live_status(b.CONTAINER, release, allow_newer=True)
            subprocess.run(['docker', 'exec', b.CONTAINER, '/opt/runtime/node/bin/node', '--input-type=module',
                '-e', "import{assertNativeTerminalPolicy}from'/app/apps/server/src/native-terminal-policy.ts';assertNativeTerminalPolicy('/opt/runtime/cli/bin/claude')"], check=True, capture_output=True, timeout=20)
            print('ALREADY_INSTALLED: Build 9 / protocol 22 / message-only review; no change.')
            return
        need(BASELINES.get(baseline['descriptor']) == baseline['build'], 'Unknown original application baseline; no change')
        # The old helper's four-event policy validation is for the old baseline only.
        b.runtime_and_policy(b.CONTAINER)
        work = Path(tempfile.mkdtemp(prefix='build9-', dir=ROOT)); work.chmod(0o755)
        program = work / 'program'; program.mkdir(mode=0o755)
        print('1/4 Verifying signed Build 9 and existing runtime; old service remains running.', flush=True)
        archive = b.download('/cc-updates/server/v1/artifacts/9/linux-x64/cc-desk-tunnel-server-0.3.7-build9.tar.gz', 64 * 1024 * 1024)
        b.unpack(archive, program, release)
        image = 'cc-space-message-review:build9-' + release['sha256'][:12]
        if args.cleanup:
            subprocess.run(['docker', 'builder', 'prune', '--all', '--force'], check=True, timeout=300)
        size = sum(p.stat().st_size for p in b.DATA.rglob('*') if p.is_file() and not p.is_symlink())
        need(shutil.disk_usage(ROOT).free >= size * 2 + 1024**3, 'Insufficient backup/preparation space; no change')
        tag = 'cc-space-message-base:' + original['Image'].split(':')[-1][:12]
        subprocess.run(['docker', 'tag', original['Image'], tag], check=True, capture_output=True)
        (work / 'Dockerfile').write_text('FROM ' + tag + '\nUSER root\nCOPY --chown=root:root program/ /app/\nCOPY program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint\nRUN chmod 755 /usr/local/bin/proxy-entrypoint && chmod -R go-w /app\nUSER ccdesktunnel\n')
        inspected = subprocess.run(['docker', 'image', 'inspect', image, original['Image']], capture_output=True)
        if inspected.returncode:
            logged(['docker', 'build', '--pull=false', '--network=none', '-t', image, str(work)], work / 'build.log')
            inspected = subprocess.run(['docker', 'image', 'inspect', image, original['Image']], check=True, capture_output=True)
        candidate, base = json.loads(inspected.stdout)
        layers = base['RootFS']['Layers']
        need(layers and candidate['RootFS']['Layers'][:len(layers)] == layers, 'Candidate base layers changed')
        image = candidate['Id']
        candidate_check(image, release)
        b.offline_preflight(image, work, release, work / 'preflight.log')
        policy = work / 'policy'
        source_hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in source.rglob('*') if p.is_file()}
        policy_copy(source, policy, program)
        need(source_hashes == {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in source.rglob('*') if p.is_file()}, 'Administrator policy changed during preparation')
        print('2/4 Offline image preflight passed; copied message-only policy prepared.', flush=True)
        if not args.install:
            print('PREPARED: use --install for idle cutover; no service changed.')
            return
        legacy = load('message_cutover', Path(__file__).with_name('install-cc-space-037.py'))
        legacy.ROOT, legacy.NODE = ROOT, node
        legacy.BASE, legacy.IMAGE = original['Image'], image
        legacy.DESCRIPTOR, legacy.TARGET = release['descriptorSha256'], {'build': BUILD, 'protocol': 22}
        clone = b.clone_config
        def clone_candidate(current, target):
            need(all(current[k] == original[k] for k in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts')),
                 'Original configuration changed')
            now = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in source.rglob('*') if p.is_file()}
            need(now == source_hashes, 'Administrator policy changed; rollback required')
            return with_policy(clone(current, target), policy)
        b.clone_config = clone_candidate
        print('3/4 Checking idle state, disconnecting clients, cold backup and paired image/policy cutover.', flush=True)
        legacy.install(b, disconnect_clients=True)
        print('4/4 SUCCESS: ' + node + ' / Build 9 / protocol 22 / review only new chat and terminal messages.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Upgrade stopped: ' + type(error).__name__ + '. Keep the backup directory and inspect the local log.', file=sys.stderr)
        for frame in traceback.extract_tb(error.__traceback__):
            print('  ' + Path(frame.filename).name + ':' + str(frame.lineno) + ' in ' + frame.name, file=sys.stderr)
        raise SystemExit(1)
