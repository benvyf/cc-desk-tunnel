#!/usr/bin/env python3
"""Upgrade confirmed ubuntu-cc / 02 / 03 baselines with verified Build 8 and offline rollback."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import socket
import shutil
import subprocess
import tempfile
import tarfile
import traceback
import urllib.request

ROOT = Path('/var/lib/cc-space-terminal-upgrade')
ORIGIN = 'https://api.ghostapi.org'
BASE_DESCRIPTOR = '27876f345c2992abf77b925686aedee2af9b151babeef46af2486afb361009ac'
RUNTIME_LOCK = '3c85257d8835fb9016bb739df2f06b2097a2f171c2941b8569aa45ea005c5176'
TARGET_BUILD = 8


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def download(path, limit):
    with urllib.request.urlopen(ORIGIN + path, timeout=90) as response:
        if response.geturl() != ORIGIN + path:
            raise RuntimeError('Redirect refused')
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('Download size limit')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', help='Cut over only after offline checks')
    parser.add_argument('--cleanup', action='store_true', help='Remove unused Docker build cache before checking space')
    args = parser.parse_args()
    node = socket.gethostname().split('.')[0]
    if os.geteuid() != 0 or node not in ('ubuntu-cc', 'ubuntu-cc-02', 'ubuntu-cc-03'):
        parser.error('Run with sudo on a confirmed ubuntu-cc / 02 / 03 host')
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o077:
        raise RuntimeError('Unsafe backup directory')
    import fcntl
    with open(ROOT / 'upgrade.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        legacy = load('terminal_cutover', Path(__file__).with_name('install-cc-space-037.py'))
        profile = legacy.select_node(node)
        b = legacy.helper(ROOT / 'helper.py', download=True)
        # The reviewed 0.3.7 image already contains these exact dependencies.
        b.PROFILE['files']['package-lock.json'] = RUNTIME_LOCK
        engine = b.Engine()
        current = engine.request('GET', '/containers/' + b.CONTAINER + '/json')
        if profile and current['Image'] != profile['image']:
            raise RuntimeError('The confirmed node image changed; no upgrade requested')
        b.validate_runtime(current)
        b.runtime_and_policy(b.CONTAINER)
        # Pin the confirmed on-disk descriptor, independently of the managed child's Build.
        baseline = legacy.REBUILT_DESCRIPTOR if profile else BASE_DESCRIPTOR
        check = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict');
const bytes=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(c.createHash('sha256').update(bytes).digest('hex'),process.argv[1]);
const d=JSON.parse(bytes);a.equal(d.files['package-lock.json'].sha256,process.argv[2]);for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(c.createHash('sha256').update(b).digest('hex'),v.sha256)}"""
        subprocess.run(['docker', 'exec', b.CONTAINER, '/opt/runtime/node/bin/node', '-e', check, baseline, RUNTIME_LOCK], check=True, capture_output=True, timeout=90)
        index = download('/cc-updates/server/v1/channels/pilot/linux-x64.json', 128 * 1024)
        envelope = json.loads(index)
        import base64
        untrusted = json.loads(base64.urlsafe_b64decode(envelope['payload'] + '==='))['release']
        if untrusted['build'] != TARGET_BUILD or untrusted['protocol'] != 22:
            raise RuntimeError(f'Expected Linux Build {TARGET_BUILD} / protocol 22; obtain a matching upgrade command')
        release = b.verify_index(index, current['Image'], TARGET_BUILD, untrusted['sha256'])['release']
        if args.cleanup:
            print('CLEANUP: removing unused Docker build cache; containers, images and backups are retained.', flush=True)
            subprocess.run(['docker', 'builder', 'prune', '--all', '--force'], check=True, timeout=300)
        size = sum(p.stat().st_size for p in legacy.DATA.rglob('*') if p.is_file() and not p.is_symlink())
        required = size * 2 + 1024 * 1024 * 1024
        free = shutil.disk_usage(ROOT).free
        print(f'SPACE_CHECK: available {free / 1024**3:.2f} GiB; required before preparation {required / 1024**3:.2f} GiB.', flush=True)
        if free < required:
            raise RuntimeError('Insufficient free space before preparation; no installation requested')
        work = Path(tempfile.mkdtemp(prefix=f'terminal-build{TARGET_BUILD}-', dir='/var/tmp'))
        work.chmod(0o755)
        archive = work / 'server.tar.gz'
        archive.write_bytes(download(f'/cc-updates/server/v1/artifacts/{TARGET_BUILD}/linux-x64/cc-desk-tunnel-server-0.3.7-build{TARGET_BUILD}.tar.gz', 64 * 1024 * 1024))
        if hashlib.sha256(archive.read_bytes()).hexdigest() != release['sha256']:
            raise RuntimeError('Archive digest mismatch')
        program = work / 'program'
        program.mkdir(mode=0o755)
        # The verified signature/hash pin the exact archive and inventory.
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts:
                    raise RuntimeError('Unexpected archive entry')
                dest = program / member.name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(bundle.extractfile(member).read())
                dest.chmod(0o644)
        for directory in program.rglob('*'):
            if directory.is_dir(): directory.chmod(0o755)
        descriptor = program / 'SERVER-RELEASE.json'
        if hashlib.sha256(descriptor.read_bytes()).hexdigest() != release['descriptorSha256']:
            raise RuntimeError('Descriptor digest mismatch')
        d = json.loads(descriptor.read_bytes())
        if (d['build'], d['protocol'], d['sourceCommit']) != (TARGET_BUILD, 22, release['sourceCommit']):
            raise RuntimeError('Unexpected candidate identity')
        for path, info in d['files'].items():
            data = (program / path).read_bytes()
            if len(data) != info['size'] or hashlib.sha256(data).hexdigest() != info['sha256']:
                raise RuntimeError('Candidate inventory mismatch')
        image = f'cc-space-terminal:build{TARGET_BUILD}-' + release['sha256'][:12]
        inspected = subprocess.run(['docker', 'image', 'inspect', image, current['Image']], capture_output=True, timeout=30)
        if inspected.returncode:
            base_tag = 'cc-space-terminal-base:' + current['Image'].split(':')[-1][:12]
            subprocess.run(['docker', 'tag', current['Image'], base_tag], check=True, capture_output=True)
            (work / 'Dockerfile').write_text('FROM ' + base_tag + '\nUSER root\nCOPY --chown=root:root program/ /app/\nCOPY --chown=root:root program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint\nRUN chmod 755 /usr/local/bin/proxy-entrypoint && chmod -R go-w /app\nUSER ccdesktunnel\n')
            with open(work / 'preflight.log', 'ab') as log:
                subprocess.run(['docker', 'build', '--network=none', '--pull=false', '-t', image, str(work)], check=True, stdout=log, stderr=log, timeout=600)
            inspected = subprocess.run(['docker', 'image', 'inspect', image, current['Image']], check=True, capture_output=True, timeout=30)
        else:
            print('Existing candidate found; verifying it without rebuilding.', flush=True)
        candidate, base = json.loads(inspected.stdout)
        layers = base['RootFS']['Layers']
        if not layers or candidate['RootFS']['Layers'][:len(layers)] != layers:
            raise RuntimeError('Candidate does not inherit the confirmed base image')
        # Pin the immutable image ID, verify signed application bytes, and rerun offline preflight on every retry.
        image = candidate['Id']
        verify = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict');
const hash=b=>c.createHash('sha256').update(b).digest('hex'),bytes=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(hash(bytes),process.argv[1]);
const d=JSON.parse(bytes);for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);a.equal(b.length,v.size);a.equal(hash(b),v.sha256)}
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),'4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358');"""
        subprocess.run(['docker', 'run', '--rm', '--network=none', '--read-only', '--entrypoint', '/opt/runtime/node/bin/node', image, '-e', verify, release['descriptorSha256']], check=True, capture_output=True, timeout=90)
        b.offline_preflight(image, work, release, work / 'preflight.log')
        free = shutil.disk_usage(ROOT).free
        required = size * 2 + 512 * 1024 * 1024
        print(f'SPACE_CHECK: available {free / 1024**3:.2f} GiB; required for backup {required / 1024**3:.2f} GiB.', flush=True)
        if free < required:
            raise RuntimeError('Insufficient free space after preparation; no installation requested')
        after = engine.request('GET', '/containers/' + b.CONTAINER + '/json')
        if after['Id'] != current['Id'] or not after['State']['Running']:
            raise RuntimeError('Original container changed during preparation')
        print(f'OFFLINE_PREFLIGHT_OK: Build {TARGET_BUILD} / protocol 22; zero Claude invocations. Logs: ' + str(work / 'preflight.log'), flush=True)
        if not args.install:
            print('Preparation only. Run again with --install after closing clients and Claude tasks.')
            return
        legacy.ROOT, legacy.BASE, legacy.IMAGE = ROOT, current['Image'], image
        legacy.DESCRIPTOR, legacy.TARGET = release['descriptorSha256'], {'build': TARGET_BUILD, 'protocol': 22}
        legacy.install(b)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Upgrade stopped: ' + type(error).__name__ + '. Keep backups and preflight logs; inspect locally before retry.', flush=True)
        # File/function locations are enough to locate failures without exposing Docker env or credentials.
        for frame in traceback.extract_tb(error.__traceback__):
            print(f'  {Path(frame.filename).name}:{frame.lineno} in {frame.name}', flush=True)
        raise SystemExit(1)
