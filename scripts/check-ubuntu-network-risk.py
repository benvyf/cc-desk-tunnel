#!/usr/bin/env python3
"""Compare old/new network inputs offline; never starts Claude or sends requests."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile

STATE = Path('/var/lib/cc-desk-tunnel-pilot-4a39bc3')
DATA = Path('/srv/cc-desk-tunnel')
CONTAINER = 'cc-desk-tunnel-ba938975-proxy-1'
OLD = 'sha256:8b9d684a84664ad27a7d97d808a8a8a057940b6ca3f5c080d6bc2182792d2390'
NEW = 'sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553'
KEYS = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy',
        'https_proxy', 'all_proxy', 'no_proxy', 'ANTHROPIC_BASE_URL',
        'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE',
        'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY')
IMAGE_JS = r"""
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
const files=['/opt/runtime/cli/bin/claude',
 '/app/apps/server/src/claude.ts','/app/apps/server/src/native-terminal.ts',
 '/app/apps/server/src/native-account.ts','/app/apps/server/src/native-onboarding.ts',
 '/app/apps/server/src/usage.ts','/app/apps/server/src/config.ts'];
const hashes=Object.fromEntries(files.map(p=>[p,existsSync(p)?createHash('sha256').update(readFileSync(realpathSync(p))).digest('hex'):null]));
const pkg='/opt/runtime/cli/lib/node_modules/@anthropic-ai/claude-code/package.json';
console.log(JSON.stringify({cliVersion:existsSync(pkg)?JSON.parse(readFileSync(pkg)).version:null,hashes}));
"""


def run(*args, input=None):
    return subprocess.check_output(args, input=input, text=True, stderr=subprocess.DEVNULL)


def image_info(image):
    # No production data/credentials mounted; networking explicitly disabled.
    return json.loads(run('docker', 'run', '--rm', '--network', 'none', '--read-only',
                          '--entrypoint', 'node', '-i', image, '--input-type=module', '-', input=IMAGE_JS))


def main():
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    old = json.loads((STATE / 'production-before.inspect.json').read_text())[0]
    current = json.loads(run('docker', 'inspect', CONTAINER))[0]
    assert old['Image'] == OLD and current['Image'] == NEW
    before, after = image_info(OLD), image_info(NEW)
    env = lambda container: dict(v.split('=', 1) for v in container['Config']['Env'] if '=' in v)
    old_env, current_env = env(old), env(current)
    differences = [k for k in KEYS if old_env.get(k) != current_env.get(k)]
    files = ('config/service.env', 'config/provider.json', 'home/.claude/settings.json')
    unchanged = {}
    with tarfile.open(STATE / 'production-backup/data.tar') as archive:
        for name in files:
            try:
                previous = archive.extractfile('./' + name).read()
            except KeyError:
                previous = None
            path = DATA / name
            now = path.read_bytes() if path.is_file() else None
            unchanged[name] = previous == now
    configured = set(current_env)
    for name in ('config/provider.json', 'home/.claude/settings.json'):
        path = DATA / name
        if path.is_file():
            configured.update(json.loads(path.read_text()).get('env', {}))
    for line in (DATA / 'config/service.env').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            configured.add(line.split('=', 1)[0].strip().removeprefix('export '))
    credentials = DATA / 'home/.claude/.credentials.json'
    oauth = json.loads(credentials.read_text()).get('claudeAiOauth', {}) if credentials.is_file() else {}
    networks = lambda container: {k: v.get('NetworkID') for k, v in container['NetworkSettings']['Networks'].items()}
    report = {
        'oldCliVersion': before['cliVersion'], 'newCliVersion': after['cliVersion'],
        'embeddedFileBytesEqual': {p: value is not None and value == after['hashes'][p]
                                   for p, value in before['hashes'].items()},
        'dockerNetworkSame': networks(old) == networks(current),
        'dockerRoutingOptionsSame': all(old['HostConfig'].get(k) == current['HostConfig'].get(k)
                                        for k in ('NetworkMode', 'Dns', 'DnsSearch', 'ExtraHosts')),
        'containerNetworkSettingDifferences': differences,
        'persistentNetworkConfigurationUnchanged': unchanged,
        'configuredRoutingVariableNames': [k for k in KEYS if k in configured],
        'credentialKindsPresent': {
            'officialCliOAuthStored': bool(oauth.get('accessToken')),
            'apiOrAuthEnvironmentKeyNames': [k for k in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN') if k in configured],
        },
        'modelRequests': 0, 'externalProbes': 0,
        'actualModelEgressVerified': False, 'accountEnforcementGuarantee': False,
    }
    (STATE / 'network-risk-sanitized.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        raise SystemExit('Read-only comparison failed (%s); no production changes or model requests.' % type(error).__name__)
