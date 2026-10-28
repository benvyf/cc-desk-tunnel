#!/usr/bin/env python3
"""Upgrade the existing ubuntu-cc Build 4 pilot to signed Build 5."""

import hashlib
import json
import os
import subprocess
import urllib.request


URL = 'https://api.ghostapi.org/cc-updates/admin/server-upgrade.cjs'
SCRIPT_SHA256 = 'c758f880c78f002ad946a8b9f26fc6f10243e6dcd384b8205aff7fcefca49281'
TARGET = {
    'build': 5,
    'sha256': 'f9431e97816c5eb5e1ed3144641b85c45037b928f836aab5fa08e4c3fe305990',
    'protocol': 22,
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    if os.name != 'posix' or os.geteuid() != 0:
        raise SystemExit('Run on ubuntu-cc: sudo python3 upgrade-cc-space-email.py')
    with urllib.request.build_opener(NoRedirect).open(URL, timeout=30) as response:
        script = response.read(65537)
    if len(script) > 65536 or hashlib.sha256(script).hexdigest() != SCRIPT_SHA256:
        raise SystemExit('Upgrade helper checksum mismatch; no installation requested.')
    program = 'const target = ' + json.dumps(TARGET) + ';\n' + script.decode('utf-8')
    print('Target: Linux Build 5 / protocol 22. Keep this terminal open.', flush=True)
    result = subprocess.run(
        [
            'docker', 'exec', '-i', 'cc-desk-tunnel-ba938975-proxy-1',
            '/opt/runtime/node/bin/node', '--env-file=/data/config/service.env',
            '--input-type=commonjs',
        ],
        input=program.encode('utf-8'),
    )
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
