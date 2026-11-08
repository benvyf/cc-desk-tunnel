#!/usr/bin/env python3
"""Explain the differences found by the first offline network check."""
import json
import os
from pathlib import Path
import socket
import subprocess

STATE = Path('/var/lib/cc-desk-tunnel-pilot-4a39bc3')
CONTAINER = 'cc-desk-tunnel-ba938975-proxy-1'
OLD = 'sha256:8b9d684a84664ad27a7d97d808a8a8a057940b6ca3f5c080d6bc2182792d2390'
NEW = 'sha256:e3275f6f27d5a39b1468123573930285d68cbbcada741b76eefbc7692ab5a553'
SOURCE_JS = r"""
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const result={};
for(const name of ['claude.ts','native-terminal.ts','config.ts']) {
 const raw=readFileSync('/app/apps/server/src/'+name,'utf8');
 const normalized=raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
 result[name]={normalizedSha256:createHash('sha256').update(normalized).digest('hex'),
  crlfLines:(raw.match(/\r\n/g)||[]).length,lines:normalized.split('\n').length};
}
console.log(JSON.stringify(result));
"""


def run(*args, input=None):
    return subprocess.check_output(args, input=input, text=True, stderr=subprocess.DEVNULL)


def main():
    assert os.geteuid() == 0 and socket.gethostname().split('.')[0] == 'ubuntu-cc'
    old = json.loads((STATE / 'production-before.inspect.json').read_text())[0]
    current = json.loads(run('docker', 'inspect', CONTAINER))[0]
    assert old['Image'] == OLD and current['Image'] == NEW
    sources = []
    for image in (OLD, NEW):
        sources.append(json.loads(run('docker', 'run', '--rm', '--pull', 'never',
                                      '--network', 'none', '--read-only', '--entrypoint', 'node',
                                      '-i', image, '--input-type=module', '-', input=SOURCE_JS)))
    routing = {}
    for key in ('NetworkMode', 'Dns', 'DnsSearch', 'ExtraHosts'):
        before, after = old['HostConfig'].get(key), current['HostConfig'].get(key)
        summary = lambda value: {'type': type(value).__name__,
                                 'entries': len(value or []), 'empty': not bool(value)}
        routing[key] = {'old': summary(before), 'new': summary(after),
                        'rawEqual': before == after,
                        'equalTreatingMissingAsEmpty': (before or []) == (after or [])}
        if key == 'NetworkMode':
            routing[key].update(oldValue=before, newValue=after)
    report = {'oldSource': sources[0], 'newSource': sources[1], 'routingDetails': routing,
              'normalizedSourceEqual': {name: sources[0][name]['normalizedSha256'] == sources[1][name]['normalizedSha256']
                                        for name in sources[0]},
              'modelRequests': 0, 'externalProbes': 0, 'productionChanged': False}
    (STATE / 'network-risk-details-sanitized.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        raise SystemExit('Offline detail check failed (%s); production was not changed.' % type(error).__name__)
