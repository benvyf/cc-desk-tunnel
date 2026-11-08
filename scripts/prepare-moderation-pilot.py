#!/usr/bin/env python3
"""Build a source-only overlay and run offline checks. Never stop production or run Claude."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import traceback

PRODUCTION = 'cc-desk-tunnel-ba938975-proxy-1'
BASE = 'sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553'
OVERLAY = ('server.ts', 'config.ts', 'moderation.ts')


def run(*args, input=None):
    return subprocess.check_output([str(arg) for arg in args], input=input, text=True, stderr=subprocess.STDOUT).strip()


def inspect(kind, name):
    return json.loads(run('docker', kind, 'inspect', name))[0]


def identity(container):
    return [container['Id'], container['Image'], container['State']['StartedAt']]


def file_hash(image, path):
    # Hash bytes, never execute the CLI or give this container production data/network access.
    return run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', image, path).split()[0]


def prepare(commit, state):
    before = inspect('container', PRODUCTION)
    assert before['Image'] == BASE and before['State']['Health']['Status'] == 'healthy', 'Unexpected production image/health'
    saved = state / 'production-before.json'
    if saved.exists():
        assert identity(json.loads(saved.read_text())) == identity(before), 'Production changed; inspect before retry'
    else:
        saved.write_text(json.dumps(before))
    source = Path('/opt/cc-moderation-source-' + commit[:12])
    if not source.exists():
        print('1/3 Fetching pinned public source.', flush=True)
        run('git', 'clone', '--quiet', '--no-checkout', 'https://github.com/benvyf/cc-desk-tunnel.git', source)
    run('git', '-C', source, 'checkout', '--quiet', '--detach', commit)
    assert run('git', '-C', source, 'rev-parse', 'HEAD') == commit
    assert not run('git', '-C', source, 'status', '--porcelain')
    context = state / 'context'
    context.mkdir(exist_ok=True, mode=0o755)
    for name in OVERLAY:
        shutil.copyfile(source / 'apps/server/src' / name, context / name)
        (context / name).chmod(0o644)
    shutil.copyfile(source / 'scripts/check-moderation-pilot.mjs', context / 'check.mjs')
    (context / 'check.mjs').chmod(0o644)
    base_tag = 'cc-desk-tunnel:moderation-base-e3275f6f27d5'
    run('docker', 'tag', BASE, base_tag)
    (context / 'Dockerfile').write_text(
        'FROM ' + base_tag + '\n' +
        ''.join('COPY --chown=root:root ' + name + ' /app/apps/server/src/' + name + '\n' for name in OVERLAY) +
        'COPY --chown=root:root check.mjs /app/.moderation-check.mjs\n')
    image = 'cc-desk-tunnel:moderation-' + commit[:12]
    print('2/3 Building source-only overlay; no installs or build network.', flush=True)
    with (state / 'build.log').open('w') as log:
        subprocess.run(['docker', 'build', '--pull=false', '--network=none', '-t', image, str(context)], stdout=log, stderr=subprocess.STDOUT, check=True)
    protected_paths = ['/opt/runtime/cli/bin/claude', '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
                       '/app/apps/server/src/claude.ts', '/app/apps/server/src/native-account.ts',
                       '/app/apps/server/src/native-terminal.ts', '/usr/local/bin/proxy-entrypoint']
    for path in protected_paths:
        assert file_hash(BASE, path) == file_hash(image, path), 'Protected image file changed: ' + path
    for key in ('Env', 'Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Healthcheck'):
        assert inspect('image', BASE)['Config'].get(key) == inspect('image', image)['Config'].get(key), 'Image runtime setting changed'
    print('3/3 Running simulation in an isolated container: no network, no production mounts.', flush=True)
    output = run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '/app/.moderation-check.mjs')
    (state / 'offline-test.log').write_text(output + '\n')
    result = json.loads(next(line[len('PILOT_RESULT '):] for line in output.splitlines() if line.startswith('PILOT_RESULT ')))
    assert all(result[key] is True for key in ('blockedBeforePersistence', 'simulatedAllow', 'continueHistoryReviewed', 'terminalDisabled', 'timeoutClosed'))
    assert result['modelRequests'] == 0
    assert identity(inspect('container', PRODUCTION)) == identity(before), 'Production identity changed'
    key = state / 'enroll_ed25519'
    if not key.exists():
        run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'cc-ubuntu-moderation-enrollment', '-f', key)
    key.chmod(0o600)
    result.update(sourceCommit=commit, image=image, imageId=inspect('image', image)['Id'],
                  protectedImageFilesEqual=True, productionUnchanged=True, cutoverPerformed=False,
                  stateDirectory=str(state))
    (state / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    print('ENROLLMENT_PUBLIC_KEY ' + key.with_suffix('.pub').read_text().strip(), flush=True)
    print('PASS. Production unchanged. Return result and enrollment PUBLIC key only; never return private files.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    assert re.fullmatch('[a-f0-9]{40}', args.source)
    os.umask(0o077)
    state = Path('/var/lib/cc-moderation-pilot-' + args.source[:12])
    state.mkdir(exist_ok=True, mode=0o700)
    try:
        prepare(args.source, state)
    except Exception:
        (state / 'prepare-error.log').write_text(traceback.format_exc())
        raise SystemExit('Preparation stopped; production was not changed. Private diagnostics: ' + str(state))
