#!/usr/bin/env python3
"""Prepare a pinned official CLI/native-review candidate; never stop or reconfigure production."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tarfile
import traceback
import urllib.request

PRODUCTION = 'cc-desk-tunnel-ba938975-proxy-1'
BASE = 'sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24'
VERSION = '2.1.295'
INTEGRITY = 'nC9RZ6ZArEavyAiFdEtGK6/XPhjfE79tP2tCh+PjmRUxSO/6W3IuXv/rmo8c6u2UzHyvgKodRj1z6UcBGlbnyA=='
ARCHIVE_SHA256 = 'd45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95'
OVERLAY = ('server.ts', 'config.ts', 'native-moderation-hook.ts', 'native-terminal-policy.ts')
POLICY_PATH = '/etc/claude-code/managed-settings.json'


def run(*args, timeout=240):
    return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()


def inspect(kind, name):
    return json.loads(run('docker', kind, 'inspect', name))[0]


def identity(container):
    return [container['Id'], container['Image'], container['State']['StartedAt']]


def image_run(image, *command):
    return run('docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
               '--security-opt=no-new-privileges', '--entrypoint', command[0], image, *command[1:])


def file_hash(image, path):
    return image_run(image, 'sha256sum', path).split()[0]


def official_binary(state, context):
    archive = state / ('claude-code-linux-x64-' + VERSION + '.tgz')
    if not archive.exists():
        url = 'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-' + VERSION + '.tgz'
        with urllib.request.urlopen(url, timeout=90) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
    content = archive.read_bytes()
    assert hashlib.sha256(content).hexdigest() == ARCHIVE_SHA256, 'Official archive SHA256 mismatch'
    assert base64.b64encode(hashlib.sha512(content).digest()).decode() == INTEGRITY, 'Official archive SRI mismatch'
    with tarfile.open(archive) as tar:
        member = tar.getmember('package/claude')
        assert member.isfile(), 'Official binary missing'
        with tar.extractfile(member) as source, (context / 'claude').open('wb') as target:
            shutil.copyfileobj(source, target)
    (context / 'claude').chmod(0o755)


def fixtures(source, state):
    lab = state / 'fixtures'
    lab.mkdir(exist_ok=True, mode=0o755)
    lab.chmod(0o755)
    for name in ('check-native-hook-cli.mjs', 'check-native-hook-pty.mjs',
                 'native-hook-lab-command.mjs', 'check-moderation-pilot.mjs'):
        shutil.copyfile(source / 'scripts' / name, lab / name)
    # This CA and token are disposable test fixtures, never production material.
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', lab / 'fixture-ca.key', '-out', lab / 'fixture-ca.crt')
    (lab / 'node-fixture.json').write_text(json.dumps({
        'endpoint': 'https://127.0.0.1:18443/cc-updates/v1/moderation/check',
        'nodeId': 'offline-node', 'token': 'x' * 43}))
    (lab / 'fault-policy.json').write_text(json.dumps({'hooks': {'UserPromptSubmit': [{'hooks': [{
        'type': 'command', 'command': '/opt/runtime/node/bin/node /lab/native-hook-lab-command.mjs',
        'timeout': 3, 'onFailure': 'block',
    }]}]}}))
    for path in lab.iterdir():
        path.chmod(0o644)
    return lab


def prepare(commit, state):
    before = inspect('container', PRODUCTION)
    assert before['Image'] == BASE and before['State']['Health']['Status'] == 'healthy', 'Unexpected production image/health'
    saved = state / 'production-before.json'
    if saved.exists():
        assert identity(json.loads(saved.read_text())) == identity(before), 'Production changed; inspect before retry'
    else:
        saved.write_text(json.dumps(before))
    assert image_run(BASE, '/bin/sh', '-c', 'if test -e /etc/claude-code/managed-settings.json; then echo present; else echo absent; fi') == 'absent', 'Existing managed policy needs a reviewed merge'
    source = state / 'source'
    print('1/4 Fetching pinned public source and verifying official CLI archive.', flush=True)
    if not source.exists():
        run('git', 'clone', '--quiet', '--no-checkout', 'https://github.com/benvyf/cc-desk-tunnel.git', source)
    run('git', '-C', source, 'checkout', '--quiet', '--detach', commit)
    assert run('git', '-C', source, 'rev-parse', 'HEAD') == commit
    assert not run('git', '-C', source, 'status', '--porcelain')
    context = state / 'context'
    context.mkdir(exist_ok=True, mode=0o755)
    for name in OVERLAY:
        shutil.copyfile(source / 'apps/server/src' / name, context / name)
        (context / name).chmod(0o644)
    official_binary(state, context)
    # Generate exactly the policy used by the server validator, with the base Node runtime.
    policy = run('docker', 'run', '--rm', '--network=none', '--read-only',
        '-v', str(context / 'native-terminal-policy.ts') + ':/tmp/policy.ts:ro',
        '--entrypoint', '/opt/runtime/node/bin/node', BASE, '--input-type=module', '-e',
        "import {nativeTerminalPolicy} from '/tmp/policy.ts'; console.log(JSON.stringify(nativeTerminalPolicy()));")
    json.loads(policy)
    (context / 'managed-settings.json').write_text(policy + '\n')
    (context / 'managed-settings.json').chmod(0o644)
    base_tag = 'cc-desk-tunnel:native-review-base-c132c31b978f'
    run('docker', 'tag', BASE, base_tag)
    user = inspect('image', BASE)['Config']['User']
    assert user == 'ccdesktunnel', 'Unexpected base user'
    (context / 'Dockerfile').write_text(
        'FROM ' + base_tag + '\nUSER root\n' +
        ''.join('COPY --chown=root:root ' + name + ' /app/apps/server/src/' + name + '\n' for name in OVERLAY) +
        'COPY --chown=root:root claude /tmp/official-claude\n' +
        'COPY --chown=root:root managed-settings.json /etc/claude-code/managed-settings.json\n' +
        'RUN cp --remove-destination /tmp/official-claude /opt/runtime/cli/bin/claude && ' +
        'chown root:root /opt/runtime/cli/bin/claude && chmod 755 /opt/runtime/cli/bin/claude && rm /tmp/official-claude\n' +
        'USER ' + user + '\n')
    image = 'cc-desk-tunnel:native-review-' + commit[:12]
    print('2/4 Building overlay offline; keeping SDK, account code and runtime settings.', flush=True)
    with (state / 'build.log').open('w') as log:
        subprocess.run(['docker', 'build', '--pull=false', '--network=none', '-t', image, str(context)],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
    for path in ('/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', '/app/apps/server/src/claude.ts',
                 '/app/apps/server/src/native-account.ts', '/app/apps/server/src/native-terminal.ts',
                 '/app/apps/server/src/moderation.ts', '/usr/local/bin/proxy-entrypoint', '/opt/runtime/node/bin/node'):
        assert file_hash(BASE, path) == file_hash(image, path), 'Protected file changed: ' + path
    old_config, new_config = inspect('image', BASE)['Config'], inspect('image', image)['Config']
    for key in ('Env', 'Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Healthcheck'):
        assert old_config.get(key) == new_config.get(key), 'Image runtime setting changed: ' + key
    lab = fixtures(source, state)
    sandbox = ['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--memory=512m', '--pids-limit=128',
        '--tmpfs=/tmp:rw,nosuid,size=128m', '-v', str(lab) + ':/lab:ro',
        '-v', str(lab / 'node-fixture.json') + ':/etc/claude-code/moderation-node.json:ro',
        '--entrypoint', '/opt/runtime/node/bin/node']

    def check(name, args=(), extra=()):
        output = run(*sandbox, *extra, image, *args, timeout=240)
        (state / (name + '.log')).write_text(output + '\n')
        return output

    print('3/4 Checking managed policy, fail-closed CLI and default terminal restriction.', flush=True)
    check('policy', ['--input-type=module', '-e',
        "import {assertNativeTerminalReview} from '/app/apps/server/src/native-terminal-policy.ts'; console.log(assertNativeTerminalReview('claude'));"])
    basic = check('existing-gate', ['/lab/check-moderation-pilot.mjs'])
    assert 'PILOT_RESULT ' in basic and '"terminalDisabled":true' in basic
    fault_mount = ['-v', str(lab / 'fault-policy.json') + ':' + POLICY_PATH + ':ro',
                   '-e', 'LAB_CLI=/opt/runtime/cli/bin/claude']
    faults = check('cli-faults', ['/lab/check-native-hook-cli.mjs'], fault_mount)
    flags = check('cli-flags', ['/lab/check-native-hook-cli.mjs'], fault_mount + ['-e', 'LAB_FLAGS_ONLY=1'])
    assert 'NATIVE_HOOK_LAB_RESULT ' in faults and 'NATIVE_HOOK_LAB_RESULT ' in flags
    print('4/4 Testing actual native PTY answers/compaction and existing SDK against loopback stubs.', flush=True)
    pty = check('pty-sdk', ['/lab/check-native-hook-pty.mjs'],
        ['-v', '/usr/bin/script:/opt/pty-script:ro', '-e', 'LAB_SDK=1', '-e', 'LAB_CLI=/opt/runtime/cli/bin/claude'])
    result = json.loads(next(line.removeprefix('NATIVE_PTY_LAB_RESULT ') for line in pty.splitlines()
                             if line.startswith('NATIVE_PTY_LAB_RESULT ')))
    assert all(result.get(key) is True for key in ('nativeQuestionAnswerReviewed', 'compactInstructionsReviewed', 'sdkCompatible'))
    assert result['rejectedAnswerReachedSimulatedModel'] is False and result['rejectedCompactReachedSimulatedModel'] is False
    assert identity(inspect('container', PRODUCTION)) == identity(before), 'Production identity changed'
    assert inspect('container', PRODUCTION)['State']['Health']['Status'] == 'healthy', 'Production health changed'
    result.update(sourceCommit=commit, image=image, imageId=inspect('image', image)['Id'],
        officialCliVersion=VERSION, archiveSha256=ARCHIVE_SHA256, sdkAndAccountCodeUnchanged=True,
        runtimeSettingsUnchanged=True, managedPolicyVerified=True, defaultTerminalStillDisabled=True,
        productionUnchanged=True, cutoverPerformed=False, stateDirectory=str(state),
        activationReady=False, pendingNativePaths=['permission-feedback', 'queued-prompts', 'skills-and-resume'])
    (state / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    print('PASS. Candidate prepared only; production unchanged. Further input-path checks required before activation.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    assert re.fullmatch('[a-f0-9]{40}', args.source)
    assert run('uname', '-m') == 'x86_64'
    os.umask(0o077)
    state = Path('/var/lib/cc-native-terminal-pilot-' + args.source[:12])
    state.mkdir(exist_ok=True, mode=0o700)
    try:
        prepare(args.source, state)
    except Exception:
        (state / 'prepare-error.log').write_text(traceback.format_exc())
        raise SystemExit('Preparation stopped; production was not changed. Private diagnostics: ' + str(state))
