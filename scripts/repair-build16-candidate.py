#!/usr/bin/env python3
"""Restore one proven-corrupt Build 16 Web asset in an unused local candidate.

This is not an installer. The unchanged signed updater must validate and perform
the later idle cutover. No accounts, service configuration, or Claude invocation.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile

ROOT = Path('/var/lib/cc-runtime-upgrade')
TAG = 'cc-space-runtime:build16-baff75da710a-c0627fd6a4fd'
DESCRIPTOR = 'bb97e49caf492f82abfe898b6c32bd0b017977d4b29f95e1aed015be5f722682'
ASSET = 'apps/server/web/assets/UniGB-UTF16-H-DKjbEwc0.bcmap'
CLI = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
CHECK = r"""const f=require('fs'),c=require('crypto'),a=require('assert/strict');
const hash=b=>c.createHash('sha256').update(b).digest('hex');
a.equal(process.versions.node,'24.22.2');
a.equal(hash(f.readFileSync('/opt/runtime/cli/bin/claude')),process.argv[2]);
const bytes=f.readFileSync('/app/SERVER-RELEASE.json');a.equal(hash(bytes),process.argv[1]);
const d=JSON.parse(bytes);a.equal(d.build,16);a.equal(d.protocol,24);
a.equal(hash(f.readFileSync('/usr/local/bin/proxy-entrypoint')),d.files['deploy/docker/entrypoint.sh'].sha256);
a.equal(f.readFileSync('/opt/runtime/level','utf8').trim(),'2');
a.equal(JSON.parse(f.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');
const mismatches=[];
for(const[p,v]of Object.entries(d.files)){const b=f.readFileSync('/app/'+p);if(b.length!==v.size||hash(b)!==v.sha256)mismatches.push(p)}
console.log(JSON.stringify(mismatches));"""


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, timeout=180,
                          capture_output=True, **kwargs).stdout


def check(image):
    return json.loads(docker('run', '--rm', '--pull=never', '--network=none', '--read-only',
                            '--entrypoint', '/opt/runtime/node/bin/node', image,
                            '-e', CHECK, DESCRIPTOR, CLI))


def build_context(program):
    require(program.resolve() == program, 'Program path must not contain symlinks')
    descriptor_path = program / 'SERVER-RELEASE.json'
    require(descriptor_path.resolve() == descriptor_path, 'Linked descriptor refused')
    data = descriptor_path.read_bytes()
    require(hashlib.sha256(data).hexdigest() == DESCRIPTOR, 'Not the published Build 16 descriptor')
    descriptor = json.loads(data)
    path = program / ASSET
    require(path.resolve() == path, 'Linked resource refused')
    asset = path.read_bytes()
    expected = descriptor['files'][ASSET]
    require(len(asset) == expected['size'] and hashlib.sha256(asset).hexdigest() == expected['sha256'],
            'Staged source asset differs from the authenticated inventory')
    return asset


def context(image, asset):
    require(image.startswith('sha256:') and len(image) == 71 and
            all(c in '0123456789abcdef' for c in image[7:]), 'Expected pinned image ID')
    # BuildKit can interpret a naked sha256 image ID as a registry repository.
    # main() creates this local alias and checks its identity before the build.
    recipe = ('FROM cc-space-repair-base:' + image[7:] +
              '\nCOPY --chown=0:0 replacement /app/' + ASSET + '\n').encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, data in [('Dockerfile', recipe), ('replacement', asset)]:
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.uid, entry.gid = len(data), 0o644, 0, 0
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def unused(image):
    ids = docker('ps', '-aq').decode().split()
    for start in range(0, len(ids), 64):
        containers = json.loads(docker('inspect', *ids[start:start + 64]))
        require(all(c['Image'] != image for c in containers),
                'Candidate is used by a running or stopped container; repair refused')


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--program', type=Path, required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc',
            'Use sudo on ubuntu-cc only')
    program = args.program.absolute()
    require(program.parent.parent == ROOT and program.parent.name.startswith('build16-') and
            program.name == 'program', 'Expected the existing Build 16 staging directory')
    require(ROOT.resolve() == ROOT, 'Linked upgrade root refused')
    lock_path = ROOT / 'upgrade.lock'
    require(lock_path.resolve() == lock_path, 'Linked upgrade lock refused')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        asset = build_context(program)
        image = json.loads(docker('image', 'inspect', TAG))[0]['Id']
        unused(image)
        bad = check(image)
        if not bad:
            print('ALREADY_VALID: candidate passes the complete signed inventory; no change')
            return
        require(bad == [ASSET], 'Mismatch set changed; repair refused: ' + json.dumps(bad))
        audit = ROOT / ('candidate-repair-' + str(os.getpid()) + '.json')
        with audit.open('x') as stream:
            os.chmod(audit, 0o600)
            json.dump({'imageBefore': image, 'candidateTag': TAG, 'restoredFile': ASSET,
                       'state': 'prepared', 'sourceSha256': hashlib.sha256(asset).hexdigest()}, stream)
        # Recheck immediately before replacing the unused local candidate tag.
        unused(image)
        require(json.loads(docker('image', 'inspect', TAG))[0]['Id'] == image,
                'Candidate tag changed; no build requested')
        try:
            base_tag = 'cc-space-repair-base:' + image[7:]
            docker('tag', image, base_tag)
            require(json.loads(docker('image', 'inspect', base_tag))[0]['Id'] == image,
                    'Local repair base identity mismatch')
            result = docker('build', '--pull=false', '--network=none', '-t', TAG, '-',
                            input=context(image, asset))
            (ROOT / (audit.stem + '.log')).write_bytes(result)
            repaired = json.loads(docker('image', 'inspect', TAG))[0]['Id']
            require(check(repaired) == [], 'Repaired image did not pass full validation')
        except BaseException as error:
            details = (getattr(error, 'stdout', None) or b'') + (getattr(error, 'stderr', None) or b'')
            if details:
                (ROOT / (audit.stem + '.log')).write_bytes(details)
            report = json.loads(audit.read_bytes())
            report.update(state='failed', errorType=type(error).__name__)
            audit.write_text(json.dumps(report) + '\n')
            docker('tag', image, TAG)
            raise
        finally:
            # Untag only this dedicated alias; Docker retains layers required by either candidate.
            docker('image', 'rm', 'cc-space-repair-base:' + image[7:])
        report = json.loads(audit.read_bytes())
        report.update(state='validated', imageAfter=repaired, allSignedFilesVerified=True)
        audit.write_text(json.dumps(report) + '\n')
        print('REPAIRED: full signed inventory, Node, CLI hash, SDK and entrypoint verified.')
        print('Original service and backups unchanged. Audit: ' + str(audit))
        print('Create a new Build 16 update task; the signed updater will revalidate this candidate.')


if __name__ == '__main__':
    main()
