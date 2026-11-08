#!/usr/bin/env python3
"""Read-only, sanitized inventory before the authorized ubuntu-cc cutover."""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess

STATE = Path('/var/lib/cc-desk-tunnel-pilot-4a39bc3')
PRODUCTION = 'cc-desk-tunnel-ba938975-proxy-1'
IMAGE = 'cc-desk-tunnel:pilot-4a39bc3'


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()


def inspect(kind, name):
    return json.loads(run('docker', kind, 'inspect', name))[0]


def main():
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    result = json.loads((STATE / 'result.json').read_text())
    assert result['productionUnchanged'] and result['protocol'] == 20
    current = inspect('container', PRODUCTION)
    previous = json.loads((STATE / 'production-before.inspect.json').read_text())[0]
    for key in ('Id', 'Image'):
        assert current[key] == previous[key], 'Production identity changed'
    assert current['State']['StartedAt'] == previous['State']['StartedAt']
    image = inspect('image', IMAGE)
    assert image['Id'] == (STATE / 'image-id.txt').read_text().strip()
    mounts = [{key: m[key] for key in ('Type', 'Source', 'Destination', 'RW')}
              for m in current['Mounts']]
    data_mounts = [m for m in mounts if m['Destination'] == '/data']
    assert len(data_mounts) == 1 and data_mounts[0]['Type'] == 'bind'
    data = Path(data_mounts[0]['Source'])
    labels = current['Config'].get('Labels') or {}
    flags = ('DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER',
             'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    flag_sources = {}
    env = dict(item.split('=', 1) for item in current['Config']['Env'] if '=' in item)
    service = data / 'config/service.env'
    for line in service.read_text().splitlines():
        match = re.match(r'^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$', line)
        if match:
            env[match[1]] = match[2].strip().strip('\"\'')
    def safe_flags(values):
        return {key: ('1' if str(values[key]) == '1' else 'set-other-value')
                for key in flags if key in values}
    flag_sources['containerAndServiceEnv'] = safe_flags(env)
    settings_paths = [data / 'home/.claude/settings.json', data / 'config/provider.json']
    for path in settings_paths:
        if path.is_file():
            flag_sources[str(path.relative_to(data))] = safe_flags(
                json.loads(path.read_text()).get('env', {}))
    # Only read installed version manifests and invoke CLI --version; no sessions/models.
    versions = json.loads(run('docker', 'exec', PRODUCTION, 'node', '--input-type=module', '-e', r"""
import {readFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const versions = {};
for (const root of ['/app', '/data/program']) {
  const p = root + '/apps/desktop/package.json';
  if (existsSync(p)) versions[root] = JSON.parse(readFileSync(p)).version;
}
try {
  const cli = execFileSync('claude', ['--version'], {encoding:'utf8', timeout:15000, stdio:['ignore','pipe','pipe']});
  versions.cli = cli.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unrecognized';
} catch { versions.cli = 'unavailable'; }
console.log(JSON.stringify(versions));
"""))
    report = {
        'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'hostname': 'ubuntu-cc', 'productionContainer': PRODUCTION,
        'productionImageId': current['Image'], 'testedImageId': image['Id'],
        'productionStartedAt': current['State']['StartedAt'],
        'productionHealth': current['State'].get('Health', {}).get('Status'),
        'compose': {key: labels.get('com.docker.compose.' + key)
                    for key in ('project', 'service', 'project.working_dir', 'project.config_files', 'project.environment_file')},
        'mounts': mounts, 'ports': current['HostConfig']['PortBindings'],
        'versions': versions, 'trafficFlags': flag_sources,
        'otelVariableNames': sorted(key for key in env if key.startswith('OTEL_')),
        'dataAllocatedBytes': int(run('du', '-sx', '-B1', str(data)).split()[0]),
        'oldImageBytes': inspect('image', current['Image'])['Size'],
        'backupFilesystemFreeBytes': shutil.disk_usage(STATE).free,
        'modelRequests': 0, 'cutoverPerformed': False,
    }
    target = STATE / 'preflight-sanitized.json'
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Raw subprocess output and file contents can contain credentials.
        raise SystemExit('Inventory failed (%s); production was not changed.' % type(error).__name__)
