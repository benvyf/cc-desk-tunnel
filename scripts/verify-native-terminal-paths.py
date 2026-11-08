#!/usr/bin/env python3
"""Extend the accepted ubuntu-cc candidate with restricted command expansion and offline PTY checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import socket
import subprocess
import traceback

PREVIOUS = Path('/var/lib/cc-native-terminal-pilot-85876c41ffce')
PREVIOUS_IMAGE = 'sha256:7154d370f8e551098a41db4a6ed58fb6d127a0852cb0fd474c6860b4f10122eb'
BASE = 'sha256:c132c31b978f47bcf5783cf374b841eddd86d6eef343cca751426691406d6e24'
PRODUCTION = 'cc-desk-tunnel-ba938975-proxy-1'


def prepare(commit, state):
    # Reuse only the exact public helper and immutable image already accepted on this node.
    helper = PREVIOUS / 'source/scripts/prepare-native-terminal-pilot.py'
    assert hashlib.sha256(helper.read_bytes()).hexdigest() == '51960152ab46260646345a3f4081b97ae0f5700ad0f722604f4d111d9b58c771'
    shared = runpy.run_path(str(helper), run_name='native_candidate_helpers')
    run, inspect, identity, file_hash = (shared[name] for name in ('run', 'inspect', 'identity', 'file_hash'))
    accepted = json.loads((PREVIOUS / 'result.json').read_text())
    assert accepted['imageId'] == PREVIOUS_IMAGE and accepted['productionUnchanged']
    assert accepted['managedPolicyVerified'] and accepted['sdkCompatible']
    assert accepted['realModelRequests'] == accepted['realJevRequests'] == 0
    assert inspect('image', accepted['image'])['Id'] == PREVIOUS_IMAGE
    before = inspect('container', PRODUCTION)
    assert before['Image'] == BASE and before['State']['Health']['Status'] == 'healthy'
    saved = state / 'production-before.json'
    if saved.exists():
        assert identity(json.loads(saved.read_text())) == identity(before), 'Production changed; inspect before retry'
    else:
        saved.write_text(json.dumps(before))

    print('1/3 Fetching pinned public continuation; reusing the accepted official CLI and SDK.', flush=True)
    source = state / 'source'
    if not source.exists():
        run('git', 'clone', '--quiet', '--no-checkout', 'https://github.com/benvyf/cc-desk-tunnel.git', source)
    run('git', '-C', source, 'checkout', '--quiet', '--detach', commit)
    assert run('git', '-C', source, 'rev-parse', 'HEAD') == commit
    assert not run('git', '-C', source, 'status', '--porcelain')
    context = state / 'context'
    context.mkdir(exist_ok=True, mode=0o755)
    hook = context / 'native-moderation-hook.ts'
    shutil.copyfile(source / 'apps/server/src/native-moderation-hook.ts', hook)
    hook.chmod(0o644)
    (context / 'Dockerfile').write_text('FROM ' + accepted['image'] + '\n' +
        'COPY --chown=root:root native-moderation-hook.ts /app/apps/server/src/native-moderation-hook.ts\n')
    image = 'cc-desk-tunnel:native-paths-' + commit[:12]
    print('2/3 Building one-file overlay without network; checking unchanged protected files/settings.', flush=True)
    with (state / 'build.log').open('w') as log:
        subprocess.run(['docker', 'build', '--pull=false', '--network=none', '-t', image, str(context)],
                       stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
    protected = ('/opt/runtime/cli/bin/claude', '/opt/runtime/node/bin/node',
        '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', '/app/apps/server/src/claude.ts',
        '/app/apps/server/src/native-account.ts', '/app/apps/server/src/native-terminal.ts',
        '/app/apps/server/src/moderation.ts', '/app/apps/server/src/config.ts', '/app/apps/server/src/server.ts',
        '/app/apps/server/src/native-terminal-policy.ts', '/etc/claude-code/managed-settings.json',
        '/usr/local/bin/proxy-entrypoint')
    for path in protected:
        assert file_hash(PREVIOUS_IMAGE, path) == file_hash(image, path), 'Protected file changed: ' + path
    previous_config, next_config = inspect('image', PREVIOUS_IMAGE)['Config'], inspect('image', image)['Config']
    for key in ('Env', 'Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Healthcheck'):
        assert previous_config.get(key) == next_config.get(key), 'Runtime configuration changed: ' + key

    lab = shared['fixtures'](source, state)
    sandbox = ['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--memory=512m', '--pids-limit=128',
        '--tmpfs=/tmp:rw,nosuid,size=128m', '-v', str(lab) + ':/lab:ro',
        '-v', str(lab / 'node-fixture.json') + ':/etc/claude-code/moderation-node.json:ro',
        '-v', '/usr/bin/script:/opt/pty-script:ro', '-e', 'LAB_CLI=/opt/runtime/cli/bin/claude',
        '--entrypoint', '/opt/runtime/node/bin/node']

    def check(name, flags):
        output = run(*sandbox, *flags, image, '/lab/check-native-hook-pty.mjs', timeout=300)
        (state / (name + '.log')).write_text(output + '\n')
        return json.loads(next(line.removeprefix('NATIVE_PTY_LAB_RESULT ') for line in output.splitlines()
                              if line.startswith('NATIVE_PTY_LAB_RESULT ')))

    print('3/3 Checking native prompts, answers, compact, queued input, permission feedback, command restriction and resume offline.', flush=True)
    basic = check('pty-sdk', ['-e', 'LAB_SDK=1'])
    assert all(basic.get(key) is True for key in ('nativePromptReviewed', 'nativeQuestionAnswerReviewed',
               'compactInstructionsReviewed', 'sdkCompatible'))
    assert all(basic.get(key) is False for key in ('rejectedPromptReachedSimulatedModel',
               'rejectedAnswerReachedSimulatedModel', 'rejectedCompactReachedSimulatedModel'))
    extended = check('extended-paths', ['-e', 'LAB_EXTENDED_ONLY=1'])
    assert all(extended.get(key) is True for key in ('queuedPromptReviewed', 'unsupportedCommandExpansionBlocked',
               'resumedHistoryReviewed', 'permissionDenialFeedbackReviewed', 'permissionAmendFeedbackReviewed'))
    assert basic['realModelRequests'] == extended['realModelRequests'] == 0
    assert basic['realJevRequests'] == extended['realJevRequests'] == 0
    assert identity(inspect('container', PRODUCTION)) == identity(before), 'Production identity changed'
    assert inspect('container', PRODUCTION)['State']['Health']['Status'] == 'healthy'
    result = {**basic, **extended, 'sdkCompatible': basic['sdkCompatible'],
        'sourceCommit': commit, 'image': image, 'imageId': inspect('image', image)['Id'],
        'officialCliVersion': '2.1.295', 'previousCandidate': PREVIOUS_IMAGE,
        'protectedFilesAndRuntimeUnchanged': True, 'productionUnchanged': True, 'cutoverPerformed': False,
        'inputPathAcceptancePassed': True, 'stateDirectory': str(state),
        'restrictions': ['direct-prompt-command-expansions-blocked'],
        'realModelRequests': 0, 'realJevRequests': 0}
    (state / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    print('PASS. Restricted native candidate verified offline; production unchanged. Activation still requires a separate idle cutover.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    assert re.fullmatch('[a-f0-9]{40}', args.source)
    os.umask(0o077)
    state = Path('/var/lib/cc-native-terminal-paths-' + args.source[:12])
    state.mkdir(exist_ok=True, mode=0o700)
    try:
        prepare(args.source, state)
    except Exception as error:
        details = traceback.format_exc()
        if isinstance(error, subprocess.CalledProcessError) and error.output:
            details += '\n' + error.output
        # PTY output contains cursor queries/control sequences. Never replay it on `tail`.
        (state / 'prepare-error.log').write_text(json.dumps({'error': details}, ensure_ascii=True) + '\n')
        raise SystemExit('Native path verification stopped; production unchanged. Private diagnostics: ' + str(state))
