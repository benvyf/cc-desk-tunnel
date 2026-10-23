#!/usr/bin/env python3
"""Known first Ubuntu bootstrap; public, self-contained and offline rollback capable.
No provider requests, CLI invocations, package installs or account credential reads.
"""
import argparse
import base64
import copy
import datetime
import gzip
import hashlib
import http.client
import io
import json
import os
import pathlib
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
ROOT = pathlib.Path('/var/lib/cc-server-bootstrap')
DATA = pathlib.Path('/srv/cc-desk-tunnel')
ORIGIN = 'https://api.ghostapi.org'
PRODUCT = 'cc-desk-tunnel-managed-server'
CONTAINER = 'cc-desk-tunnel-ba938975-proxy-1'
PROFILE = json.loads('{\n  "schema": 1,\n  "node": "ubuntu-cc",\n  "container": "cc-desk-tunnel-ba938975-proxy-1",\n  "knownOriginalBase": "sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f",\n  "files": {\n    "apps/desktop/package.json": "76ea20e0e2a32c579c18cabc4a93ac8f0740321417ef6bdbd46b70e5431d6da8",\n    "apps/server/package.json": "dbf63c8cf03b43ee8f6f27055544642dd60be1adab0db17c69d40dbd5729d09b",\n    "apps/server/src/claude-stream.ts": "d2bd1435add547dc61d6d3c6e4db42fb91fb443f4083608f5866962546664db1",\n    "apps/server/src/claude.ts": "d6030cac81e13c39231e5f10f69cdb1a46252753b53ddfb17b2d3ad81bd1fd83",\n    "apps/server/src/client-release.ts": "4d4845548d8e577bab079f9326ca25c3994e745ece83f9b7a9ec5e9bad175480",\n    "apps/server/src/config.ts": "e038a5df3706c2d050eba830880e627d6dd7fbe8711f35f8f8de2ad0e922bf6a",\n    "apps/server/src/device-terms.ts": "c65825d94abcd7e81c50514cd9c3d7d9f392a09430baefbf4e9a0522bb7760f9",\n    "apps/server/src/errors.ts": "2f39eeba21699f498d251507cc70110cb2455b161d2cb075679703fa8448c721",\n    "apps/server/src/legacy.ts": "6849c4c27678c8308e1c2456c091047071d0a7502425b757cb2eda489b2addee",\n    "apps/server/src/main.ts": "4d729d295dd67c28d17c6b209b9daeb72ed31bdced53f7e016cf6c6e149edb5b",\n    "apps/server/src/moderation.ts": "b849be7a7f2fc994a7a316e8bddf500f1ff72738745ea34f1700f0edd9169f3a",\n    "apps/server/src/native-account.ts": "f73433400fde0147491d6ca355ba1024e06a54dfe7bbec53c6b8f2474e13c17c",\n    "apps/server/src/native-controls.ts": "986386e1c4a2ca51e2c546c0a82be8bcc48f4ed2cea48049fd459c501229ec37",\n    "apps/server/src/native-input.ts": "e7031e2af48d890d32f66d2bafcfcc99021fcfb43c7594fc55ccccb649c8587b",\n    "apps/server/src/native-instructions.ts": "31b01bd3c65476408b1618dcb00a1e0bf59c9e2a058179f788c5ab1ef9d2a048",\n    "apps/server/src/native-moderation-hook.ts": "6d140f6e7b8e5602eed6b187fc3a47c675486b05caf187c66e7650749eb77973",\n    "apps/server/src/native-onboarding.ts": "6777362622817745be87480d79aa443811f231dc2dc576e1950dec4658d313f7",\n    "apps/server/src/native-settings.ts": "7eb0a58a361bf47eab0e6338f0c8dd8df803e10f1bd7f346a9649752a877b20f",\n    "apps/server/src/native-terminal-policy.ts": "50d5daf98a3a341b3af7d138e1bf4324b1bd7c984b68c1a47b8db7a584542c0c",\n    "apps/server/src/native-terminal.ts": "9ee3be7b9da983e83cecf33c1ae5d3a6da1762f2ad5cbd0ab00da7102fd7902c",\n    "apps/server/src/question.ts": "aa995fc6e5b110d3f8273549cab481734b729adede684e6d0809582b5455c026",\n    "apps/server/src/server.ts": "c99b4b322f6e94603f7e944998736d7298ce050ab01e4a83847c5d743843f0a6",\n    "apps/server/src/simulation.ts": "ef92114f4e25271569555b0e96256c18f8f550b6f247ff4a5600486a9f429d6d",\n    "apps/server/src/store.ts": "0f5aa51f63590f270f132b11257fb2e496f2859cec88f0d1835a63c416bc3554",\n    "apps/server/src/throttle.ts": "08e4663c214151424336c7afb3a9b4c5f70ebc44909c79f6b87106950d4ae4cc",\n    "apps/server/src/tunnel.ts": "e7c9f2bd7e51156dc6785248768dae8fc55f2c73d07007e30fcf5314a253f317",\n    "apps/server/src/updates.ts": "c56f5460e7e55bbabb190392774c1f6c54dd2a70b02d4959ecaf0c5606c47685",\n    "apps/server/src/usage.ts": "4bde92f9f877e4c579eead3fe4994f863a501663417403f0c8b9c42aaa9990dc",\n    "apps/server/src/web-access.ts": "18e480b94c4c29569ad27a4bf57c7838ea584ae20b812f68030cf7676cb571f6",\n    "apps/server/src/web-certificate.ts": "56e372003ce90535250e1f7706f24e19b07497e68f678580bc04a5243de97162",\n    "apps/server/src/web-commands.ts": "d075b9df14566686934ec179064246805bfb6c2ce7bdf9bac2576d32f1d3c8ae",\n    "apps/server/src/web-totp.ts": "a0eaf188fecc7970cdba3f54b568bdd04b34e52c69f2d5796c837d56448e25d0",\n    "package-lock.json": "db9f2582269b324f3a091eea0082a406e8e7a02bd4b748a155dac419b0f025d8",\n    "package.json": "a1c10a8383c88b20a6cd824bc62de697efb04121898c64d604f18e13815f5b37",\n    "packages/protocol/src/index.ts": "711208ba8c362491dfe038c621cc4ef5f1a9cc580c74e9e29b83d955c1736c30",\n    "packages/protocol/src/web-certificate.ts": "e958aa1226b10101ca91da23e161afd2db7972ba5764245a8f25749dbebd55ff",\n    "packages/protocol/src/web.ts": "27011dd28fcaff36afed63bc3a6c75a274ce0ad9493479e314d494ad32cd628c",\n    "apps/server/src/account-monitor.ts": "ffe2820fdc04700ed63523facc8b0dbde600cb36c84bb7fbdcfc731d937795c9",\n    "packages/protocol/src/account-monitor.ts": "b372a9c52cb90d8ab558444ad6de5ab4adc19447934995bf36b691d6d9c1ee4e"\n  },\n  "note": "Known first Ubuntu after passive monitor patch; current derived image need not equal original base."\n}')
KEYS = {'managed-vps-2026-10-23': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAH4kVnTl+XgMx+Up2F5Om4YlRfZVi+1bXed67n+Q+yGI=\n-----END PUBLIC KEY-----\n'}


class InstallError(Exception):
    pass


class EngineError(InstallError):
    def __init__(self, status):
        self.status = status
        super().__init__('Docker operation failed (HTTP %s).' % status)


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


class Engine:
    def request(self, method, path, data=None):
        conn = UnixConnection('localhost', timeout=180)
        try:
            # The daemon selects its supported API version for unversioned paths.
            conn.request(method, path,
                         body=None if data is None else json.dumps(data).encode(),
                         headers={'Content-Type': 'application/json'})
            response = conn.getresponse()
            content = response.read()
            if not 200 <= response.status < 300:
                # Docker errors can contain env values; never echo their body.
                raise EngineError(response.status)
            return json.loads(content) if content else {}
        finally:
            conn.close()


def busy(processes):
    for row in processes:
        args = ' '.join(row)
        if re.search(r'(?i)(claude|anthropic|[/\\]cli\.js)', args):
            return True
        # Unknown Node worker may be an SDK run. Allow only the actual server and local healthcheck.
        if re.search(r'(^|[ /])node(?:js)?(?:\s|$)', args) and not (
                any(p in args for p in ('apps/server/src/main.ts', 'apps/server/src/managed-main.ts', 'apps/server/src/managed-server-main.ts', '/app/healthcheck.mjs'))):
            return True
    return False


def endpoints(original):
    result = {}
    for name, network in original['NetworkSettings']['Networks'].items():
        entry = {k: copy.deepcopy(network[k]) for k in ['IPAMConfig', 'Links', 'Aliases', 'DriverOpts']
                 if network.get(k) is not None}
        if 'Aliases' in entry:
            entry['Aliases'] = [a for a in entry['Aliases'] if a not in (original['Id'], original['Id'][:12])]
        result[name] = entry
    return result


def frozen_idle(original):
    # A connected client or pending external review may have work queued even before
    # a Claude subprocess exists. Inspect locally, without touching provider APIs.
    pid = original['State']['Pid']
    for name in ('tcp', 'tcp6'):
        for line in pathlib.Path('/proc/%s/net/%s' % (pid, name)).read_text().splitlines()[1:]:
            if line.split()[3] == '01':
                raise InstallError('CC still has an active network connection. Close all CC clients, wait a moment, then retry.')
    database = pathlib.Path('/srv/cc-desk-tunnel/state/sessions.sqlite')
    if not database.is_file():
        raise InstallError('Expected local session state is missing; automatic installation refused.')
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
        if any(json.loads(row[0]).get('activeRun') for row in db.execute('SELECT metadata FROM sessions')):
            raise InstallError('CC has an active or waiting run. Finish it before installing.')


def restore(engine, original, replacement=None):
    old = original['Id']
    if replacement:
        engine.request('DELETE', '/containers/' + replacement + '?force=true')
    # Do not restore data.tar.gz: any data written by the replacement must be retained.
    current = engine.request('GET', '/containers/' + old + '/json')
    if current.get('Name') != original['Name']:
        engine.request('POST', '/containers/' + old + '/rename?name=' + urllib.parse.quote(original['Name'].lstrip('/'), safe=''))
    connected = current.get('NetworkSettings', {}).get('Networks', {})
    for name, endpoint in endpoints(original).items():
        if name not in connected:
            engine.request('POST', '/networks/' + urllib.parse.quote(name, safe='') + '/connect',
                           {'Container': old, 'EndpointConfig': endpoint})
    engine.request('POST', '/containers/' + old + '/update', {'RestartPolicy': original['HostConfig']['RestartPolicy']})
    current = engine.request('GET', '/containers/' + old + '/json')
    if not current['State'].get('Running'):
        engine.request('POST', '/containers/' + old + '/start')


def command(args, log, **kwargs):
    with open(log, 'ab') as output:
        result = subprocess.run(args, stdout=output, stderr=output, timeout=300, **kwargs)
    if result.returncode:
        raise InstallError('Offline Docker build/test failed; private details saved in ' + str(log))


def checked_sources(container, expected):
    # Reads source only, never reads account files or starts Claude.
    program = "const fs=require('fs'),c=require('crypto');let a=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.fromEntries(Object.keys(a).map(p=>[p,c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))))"
    result = subprocess.run(['docker', 'exec', container, 'node', '-e', program, json.dumps(expected)],
                            capture_output=True, timeout=30)
    if result.returncode or json.loads(result.stdout) != expected:
        raise InstallError('Runtime source differs from the reviewed version; nothing has been changed.')


def wait_healthy(engine, container):
    for _ in range(90):
        state = engine.request('GET', '/containers/' + container + '/json')['State']
        if not state.get('Running'):
            raise InstallError('New CC container did not stay running.')
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        if state.get('Health', {}).get('Status') == 'unhealthy':
            break
        time.sleep(1)
    raise InstallError('Local CC health check failed.')


def clone_config(original, image):
    config = copy.deepcopy(original['Config'])
    config['Image'] = image
    config['HostConfig'] = copy.deepcopy(original['HostConfig'])
    config['NetworkingConfig'] = {'EndpointsConfig': endpoints(original)}
    return config


def validate_runtime(original):
    c, h = original['Config'], original['HostConfig']
    if not original['State'].get('Running') or original['State'].get('Paused'):
        raise InstallError('Expected running, unpaused CC container.')
    if c.get('Entrypoint') != ['/usr/bin/tini', '-g', '--', '/usr/local/bin/proxy-entrypoint'] or c.get('Cmd') != ['server']:
        raise InstallError('Unknown startup configuration; manual image upgrade required.')
    if c.get('User') not in ('ccdesktunnel', '1000', '1000:1000') or c.get('WorkingDir') != '/data/workspace' or not c.get('Healthcheck'):
        raise InstallError('Unknown runtime identity or health check.')
    if h.get('AutoRemove') or h.get('VolumesFrom') or h.get('PublishAllPorts') or h.get('Privileged'):
        raise InstallError('Unsupported container privileges, volumes or dynamic ports.')
    if h.get('NetworkMode') in ('host', 'none') or h.get('NetworkMode', '').startswith('container:') or not original['NetworkSettings']['Networks']:
        raise InstallError('Unsupported network configuration.')
    if h.get('RestartPolicy', {}).get('Name') not in ('always', 'unless-stopped'):
        raise InstallError('A Docker restart policy is required.')
    if any(v.get('HostPort', '') in ('', '0') for a in h.get('PortBindings', {}).values() for v in (a or [])):
        raise InstallError('Dynamic ports are not supported.')
    mounts = original.get('Mounts', [])
    expected = {'/data': ('/srv/cc-desk-tunnel', True), '/etc/claude-code': ('/etc/claude-code', False)}
    if len(mounts) != 2 or {m['Destination'] for m in mounts} != set(expected):
        raise InstallError('Unknown mounts; manual image upgrade required.')
    for m in mounts:
        source, rw = expected[m['Destination']]
        if m['Type'] != 'bind' or m['Source'] != source or bool(m.get('RW')) != rw:
            raise InstallError('Expected data and read-only policy bind mounts.')


def download(path, limit):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect).open(ORIGIN + path, timeout=30) as response:
        if response.status != 200:
            raise InstallError('VPS download failed.')
        data = response.read(limit + 1)
    if len(data) > limit:
        raise InstallError('VPS download exceeded its limit.')
    return data


def strict(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise InstallError('Unexpected signed metadata fields.')
    return value


def positive(value):
    if type(value) is not int or not 0 < value <= 9007199254740991:
        raise InstallError('Invalid signed integer.')


def digest(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        raise InstallError('Invalid signed digest.')


def verify_index(data, image, build, sha):
    if len(data) > 128 * 1024:
        raise InstallError('Signed index too large.')
    envelope = strict(json.loads(data), ('payload', 'keyId', 'signature'))
    if envelope['keyId'] not in KEYS:
        raise InstallError('Unknown signing key.')
    # Node crypto from the current local image verifies only bytes supplied on stdin.
    # No mounts, inherited account env, Claude or network can be consulted.
    program = "const c=require('crypto');let a=JSON.parse(require('fs').readFileSync(0));for(let k of ['payload','signature']){if(!/^[A-Za-z0-9_-]+$/.test(a.e[k])||Buffer.from(a.e[k],'base64url').toString('base64url')!==a.e[k])process.exit(1)}if(Buffer.from(a.e.signature,'base64url').length!==64||!c.verify(null,Buffer.from(a.e.payload,'base64url'),a.key,Buffer.from(a.e.signature,'base64url')))process.exit(1)"
    result = subprocess.run(['docker', 'run', '--rm', '-i', '--network=none', '--read-only', '--memory=128m', '--cpus=0.5', '--pids-limit=32', '--entrypoint', '/opt/runtime/node/bin/node', image, '-e', program],
                            input=json.dumps({'e': envelope, 'key': KEYS[envelope['keyId']]}).encode(), capture_output=True, timeout=30)
    if result.returncode:
        raise InstallError('Ed25519 signature verification failed.')
    payload = strict(json.loads(base64.urlsafe_b64decode(envelope['payload'] + '===')), ('schema', 'product', 'channel', 'platform', 'arch', 'revision', 'issuedAt', 'expiresAt', 'release'))
    if [payload[k] for k in ('schema', 'product', 'channel', 'platform', 'arch')] != [1, PRODUCT, 'pilot', 'linux', 'x64']:
        raise InstallError('Wrong Linux release identity.')
    positive(payload['revision'])
    for k in ('issuedAt', 'expiresAt'):
        if not isinstance(payload[k], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', payload[k]):
            raise InstallError('Invalid release time.')
    issued, expires = [datetime.datetime.fromisoformat(payload[k].replace('Z', '+00:00')).timestamp() for k in ('issuedAt', 'expiresAt')]
    if issued > time.time() + 60 or expires <= time.time() or not 0 < expires - issued <= 31 * 86400:
        raise InstallError('Release expired or issued in the future.')
    r = strict(payload['release'], ('build', 'appVersion', 'protocol', 'sourceCommit', 'size', 'sha256', 'packageLockSha256', 'runtimeLevel', 'compatibility', 'descriptorSha256'))
    for k in ('build', 'protocol', 'size'): positive(r[k])
    for k in ('sha256', 'packageLockSha256', 'descriptorSha256'): digest(r[k])
    if r['build'] != build or r['sha256'] != sha or r['size'] > 64 * 1024 * 1024:
        raise InstallError('Confirmed release changed. Generate a new console command.')
    if not re.fullmatch(r'[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-zA-Z0-9.]{1,40})?', r['appVersion']) or not re.fullmatch('[a-f0-9]{40}', r['sourceCommit']):
        raise InstallError('Invalid release version/source.')
    if r['runtimeLevel'] != 'node24-cli2.1.295-v1' or r['packageLockSha256'] != PROFILE['files']['package-lock.json']:
        raise InstallError('Release requires a manual runtime/dependency upgrade.')
    if not isinstance(r['compatibility'], dict):
        raise InstallError('Invalid compatibility map.')
    for value in r['compatibility'].values(): digest(value)
    return payload


def unpack(data, target, release):
    if len(data) != release['size'] or len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != release['sha256']:
        raise InstallError('Archive hash/size mismatch.')
    # Bound decompression before tar parsing; never let tarfile materialize an unbounded bomb.
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as gz:
        raw = gz.read(256 * 1024 * 1024 + 1)
    if len(raw) > 256 * 1024 * 1024:
        raise InstallError('Expanded archive too large.')
    files, offset = {}, 0
    while offset + 512 <= len(raw):
        h = raw[offset:offset + 512]; offset += 512
        if not any(h):
            if any(raw[offset:]): raise InstallError('Tar trailing bytes.')
            break
        if h[257:263] != b'ustar\0' or h[156:157] not in (b'0', b'\0'):
            raise InstallError('Only regular USTAR entries allowed.')
        try:
            checksum = int(h[148:156].split(b'\0')[0].strip(), 8)
            size = int(h[124:136].split(b'\0')[0].strip(), 8)
            name = h[:100].split(b'\0')[0].decode('ascii')
            prefix = h[345:500].split(b'\0')[0].decode('ascii')
        except (ValueError, UnicodeError):
            raise InstallError('Malformed USTAR header.')
        path = prefix + '/' + name if prefix else name
        if checksum != sum(h[:148]) + 8 * 32 + sum(h[156:]) or not re.fullmatch(r'[A-Za-z0-9_.@/+-]{1,200}', path) or any(p in ('', '.', '..', 'node_modules') for p in path.split('/')) or path in files:
            raise InstallError('Unsafe/duplicate archive path or header.')
        if size < 0 or size > 256 * 1024 * 1024 or offset + size > len(raw) or len(files) > 10000:
            raise InstallError('Archive bounds exceeded.')
        files[path] = raw[offset:offset + size]
        offset += (size + 511) // 512 * 512
    else:
        raise InstallError('Missing tar end marker.')
    db = files.get('SERVER-RELEASE.json', b'')
    if len(db) > 4 * 1024 * 1024 or hashlib.sha256(db).hexdigest() != release['descriptorSha256']:
        raise InstallError('Descriptor hash mismatch.')
    d = strict(json.loads(db), ('schema', 'product', 'build', 'appVersion', 'protocol', 'sourceCommit', 'files'))
    if d['schema'] != 1 or d['product'] != PRODUCT or any(d[k] != release[k] for k in ('build', 'appVersion', 'protocol', 'sourceCommit')) or not isinstance(d['files'], dict) or set(files) != set(d['files']) | {'SERVER-RELEASE.json'}:
        raise InstallError('Descriptor identity/inventory mismatch.')
    for path, entry in d['files'].items():
        strict(entry, ('size', 'sha256'))
        if type(entry['size']) is not int or entry['size'] != len(files[path]) or entry['sha256'] != hashlib.sha256(files[path]).hexdigest():
            raise InstallError('Inventory file mismatch.')
    if target.exists(): raise InstallError('Stage already exists.')
    target.mkdir(mode=0o755)
    for path, content in files.items():
        p = target / path; p.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        p.write_bytes(content); p.chmod(0o644)
    for directory in [target] + [p for p in target.rglob('*') if p.is_dir()]:
        directory.chmod(0o755)
    return d


def dockerfile(base):
    if not re.fullmatch('[a-z0-9:/.-]+', base): raise InstallError('Unsafe local image tag.')
    return ('FROM ' + base + '\nUSER root\nCOPY --chown=root:root program/ /app/\n'
            'COPY --chown=root:root program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint\n'
            'COPY --chown=root:root program/deploy/docker/runtime-level /opt/runtime/level\n'
            'RUN chmod 755 /usr/local/bin/proxy-entrypoint && chmod -R go-w /app /opt/runtime\nUSER ccdesktunnel\n')


PERSISTENCE = ('store', 'usage', 'web-access', 'native-settings', 'native-onboarding',
               'native-instructions', 'web-certificate', 'web-totp', 'device-terms', 'native-account',
               'claude', 'legacy')


def validate_target(program, release):
    pinned = ['apps/server/src/' + name + '.ts' for name in PERSISTENCE] + [
        'packages/protocol/src/index.ts', 'packages/protocol/src/web.ts', 'packages/protocol/src/web-certificate.ts']
    for p in pinned:
        if hashlib.sha256((program / p).read_bytes()).hexdigest() != PROFILE['files'][p]:
            raise InstallError('Persistence compatibility changed; manual image procedure required.')
    if hashlib.sha256((program / 'package-lock.json').read_bytes()).hexdigest() != release['packageLockSha256']:
        raise InstallError('Target dependencies changed.')
    expected = ['apps/server/src/' + name + '.ts' for name in ('store', 'usage', 'web-access', 'native-settings', 'native-onboarding', 'native-instructions', 'native-moderation-hook', 'moderation', 'errors', 'native-deployment', 'native-terminal-policy', 'web-certificate', 'web-totp', 'device-terms', 'claude', 'legacy', 'native-account')] + ['packages/protocol/src/index.ts', 'packages/protocol/src/web.ts', 'packages/protocol/src/web-certificate.ts']
    if set(release['compatibility']) != set(expected):
        raise InstallError('Unknown compatibility closure.')
    for p in expected:
        content = (program / p).read_bytes()
        if p == 'packages/protocol/src/index.ts':
            content, count = re.subn(rb'(?m)^export const PROTOCOL_VERSION = [0-9]+;(?=\r?$)', b'export const PROTOCOL_VERSION = 0;', content)
            if count != 1: raise InstallError('Invalid protocol declaration.')
        if hashlib.sha256(content).hexdigest() != release['compatibility'][p]:
            raise InstallError('Compatibility inventory mismatch.')
    identity = json.loads((program / 'deploy/managed-server.json').read_text())
    if identity.get('keys') != KEYS or identity.get('origin') != ORIGIN or identity.get('build') != release['build']:
        raise InstallError('Unknown immutable server trust identity.')
    if (program / 'deploy/docker/runtime-level').read_text().strip() != '1':
        raise InstallError('Unknown runtime level.')


def runtime_and_policy(container):
    # The original pilot has no installer stamp. Pin the reviewed official binary bytes.
    program = r"""const fs=require('fs'),c=require('crypto'),a=require('assert');
    a.equal(process.versions.node.split('.')[0],'24');a.equal(process.arch,'x64');
    for(const p of ['/opt/runtime/node/bin/node','/opt/runtime/cli/bin/claude','/etc/claude-code/managed-settings.json','/etc/claude-code/moderation-node.json']){const s=fs.statSync(p);a(s.isFile()&&s.uid===0&&!(s.mode&18))}
    a.equal(c.createHash('sha256').update(fs.readFileSync('/opt/runtime/cli/bin/claude')).digest('hex'),'4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358');
    a.equal(JSON.parse(fs.readFileSync('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json')).version,'0.3.286');
    const p=JSON.parse(fs.readFileSync('/etc/claude-code/managed-settings.json'));a(p.disableAllHooks!==true);
    for(const p of [process.env.HOME||'/data/home',process.env.PROXY_DATA_DIR||'/data/state',process.env.CLAUDE_CONFIG_DIR||require('path').join(process.env.HOME||'/data/home','.claude')]){const v=require('path').resolve(p);a(v.startsWith('/data/')&&!v.startsWith('/data/managed-server'),'External writable data requires manual image procedure')}
    const hook={hooks:[{type:'command',command:'/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts',timeout:10,onFailure:'block'}]};
    for(const e of ['UserPromptSubmit','PostToolBatch','UserPromptExpansion','PreCompact'])a(p.hooks[e].some(g=>require('util').isDeepStrictEqual(g,hook)));
    const m=JSON.parse(fs.readFileSync('/etc/claude-code/moderation-node.json')),u=new URL(m.endpoint);a(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/cc-updates/v1/moderation/check'&&/^[A-Za-z0-9_-]{1,128}$/.test(m.nodeId)&&/^[A-Za-z0-9_-]{43}$/.test(m.token));
    a(fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').some(l=>{let f=l.split(' ');return f[4]==='/etc/claude-code'&&f[5].split(',').includes('ro')}));"""
    result = subprocess.run(['docker', 'exec', container, '/opt/runtime/node/bin/node', '--env-file=/data/config/service.env', '-e', program], capture_output=True, timeout=30)
    if result.returncode:
        raise InstallError('Current runtime or administrator policy is not the reviewed configuration.')


SMOKE = r"""import{spawn}from'node:child_process';import{mkdirSync,existsSync}from'node:fs';import assert from'node:assert/strict';
for(const p of ['/data/home','/data/workspace'])mkdirSync(p,{recursive:true});
const token='offline-bootstrap-service-token-123456';
const child=spawn('/opt/runtime/node/bin/node',['/app/apps/server/src/managed-main.ts'],{cwd:'/data/workspace',env:{PATH:'/opt/runtime/node/bin:/usr/bin:/bin',HOME:'/data/home',PROXY_TOKEN:token,PROXY_DATA_DIR:'/data/state',PROXY_TLS_MODE:'reverse-proxy',PROXY_PORT:'8787'},stdio:['ignore','pipe','pipe']});
let logs='';for(const s of[child.stdout,child.stderr])s.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',r));
try{let ready;const end=Date.now()+30000;while(Date.now()<end){assert.equal(child.exitCode,null,'Supervisor exited');try{const r=await fetch('http://127.0.0.1:8787/cc-managed/server/v1/status',{headers:{authorization:'Bearer '+token}});if(r.status===200){const s=await r.json();if(s.phase==='idle'){ready=s;break}}}catch{}await new Promise(r=>setTimeout(r,100))}
assert(ready,'Readiness timeout');assert.equal(ready.current.build,Number(process.argv[2]));assert.equal(ready.current.protocol,Number(process.argv[3]));assert.equal((await fetch('http://127.0.0.1:8787/health')).status,200);assert.notEqual((await fetch('http://127.0.0.1:8787/')).status,503);
child.kill('SIGTERM');assert.equal(await Promise.race([exited,new Promise((_,j)=>setTimeout(()=>j(Error('Shutdown timeout')),6000).unref())]),0);assert.equal(existsSync('/data/claude-was-invoked'),false);console.log('Offline supervisor readiness, health, SIGTERM; zero CLI invocations');
}finally{if(child.exitCode===null)child.kill('SIGKILL')}
"""


def offline_preflight(image, work, release, log):
    fixtures = work / 'fixtures'; fixtures.mkdir(exist_ok=True)
    policy = fixtures / 'policy'; policy.mkdir(exist_ok=True)
    (policy / 'managed-settings.json').write_bytes((work / 'program/deploy/docker/managed-settings.json').read_bytes())
    (policy / 'moderation-node.json').write_text(json.dumps({'endpoint': 'https://example.invalid/cc-updates/v1/moderation/check', 'nodeId': 'offline', 'token': 'x' * 43}))
    sentinel = fixtures / 'claude'; sentinel.write_text('#!/bin/sh\ntouch /data/claude-was-invoked\nexit 93\n'); sentinel.chmod(0o755)
    smoke = fixtures / 'smoke.mjs'; smoke.write_text(SMOKE)
    for p in (fixtures, policy): p.chmod(0o755)
    for p in policy.iterdir(): p.chmod(0o644)
    smoke.chmod(0o644)
    command(['docker', 'run', '--rm', '--network=none', '--read-only', '--memory=384m', '--cpus=0.5', '--pids-limit=128',
             '--tmpfs', '/tmp:rw,size=128m', '--tmpfs', '/data:rw,uid=1000,gid=1000,size=128m',
             '--mount', 'type=bind,src=' + str(policy) + ',dst=/etc/claude-code,readonly',
             '--mount', 'type=bind,src=' + str(sentinel) + ',dst=/opt/runtime/cli/bin/claude,readonly',
             '--mount', 'type=bind,src=' + str(smoke) + ',dst=/smoke.mjs,readonly',
             '--user', '1000:1000', '--workdir', '/app', '--entrypoint', '/opt/runtime/node/bin/node', image,
             '/smoke.mjs', str(release['build']), str(release['protocol'])], log)


def live_status(container, release, allow_newer=False):
    # Only management status and /health over container loopback; no WebSocket or provider endpoints.
    program = r"""import assert from'node:assert/strict';import{readFileSync}from'node:fs';import http from'node:http';import https from'node:https';
    const e=process.env,tls=e.PROXY_TLS_MODE!=='reverse-proxy',port=Number(e.PROXY_PORT||8787);
    const request=(path)=>new Promise((resolve,reject)=>{let r=(tls?https:http).get({hostname:'127.0.0.1',port,path,headers:{authorization:'Bearer '+e.PROXY_TOKEN},...(tls?{ca:readFileSync(e.PROXY_TLS_CERT),checkServerIdentity:()=>undefined}:{}),timeout:5000},s=>{let b='';s.on('data',c=>{b+=c;if(b.length>16384)s.destroy(Error('Response limit'))});s.on('error',reject);s.on('end',()=>resolve({status:s.statusCode,body:b}))});r.on('error',reject);r.on('timeout',()=>r.destroy(Error('Timeout')))});
    let ready;for(let n=0;n<30;n++){try{const r=await request('/cc-managed/server/v1/status');if(r.status===200){let s=JSON.parse(r.body);if(s.phase==='idle'||process.argv[3]==='allow-newer'&&['committed','rolled-back'].includes(s.phase)){ready=s;break}}}catch{}await new Promise(r=>setTimeout(r,500))}
    assert(ready,'Readiness timeout');if(process.argv[3]==='allow-newer'){assert(Number.isSafeInteger(ready.current.build)&&ready.current.build>=Number(process.argv[1]));assert(Number.isSafeInteger(ready.current.protocol)&&ready.current.protocol>0)}else{assert.equal(ready.current.build,Number(process.argv[1]));assert.equal(ready.current.protocol,Number(process.argv[2]))}assert.equal((await request('/health')).status,200);"""
    result = subprocess.run(['docker', 'exec', container, '/opt/runtime/node/bin/node', '--env-file=/data/config/service.env', '--input-type=module', '-e', program, str(release['build']), str(release['protocol']), 'allow-newer' if allow_newer else 'exact'], capture_output=True, timeout=30)
    if result.returncode:
        raise InstallError('Managed supervisor local readiness failed.')
    checked_sources(container, {'SERVER-RELEASE.json': release['descriptorSha256']})


def replace(engine, original, work, release):
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + os.urandom(4).hex()
    backup = ROOT / ('backup-' + stamp); backup.mkdir(mode=0o700)
    (backup / 'original.json').write_text(json.dumps(original))
    (backup / 'rollback.py').write_bytes(pathlib.Path(__file__).read_bytes())
    log = backup / 'offline-build.log'
    paused, changed, replacement = False, False, None
    try:
        current = engine.request('GET', '/containers/' + original['Id'] + '/json')
        if any(current[k] != original[k] for k in ('Config', 'HostConfig', 'Mounts')):
            raise InstallError('Container configuration changed during preparation.')
        engine.request('POST', '/containers/' + original['Id'] + '/pause'); paused = True
        if busy(engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20pid,args')['Processes']):
            raise InstallError('A task started during preparation. Close CC clients and retry.')
        frozen_idle(original)
        size = sum(p.stat().st_size for p in DATA.rglob('*') if p.is_file() and not p.is_symlink())
        if shutil.disk_usage(ROOT).free < size * 2 + 512 * 1024 * 1024:
            raise InstallError('Insufficient local backup space.')
        changed = True
        engine.request('POST', '/containers/' + original['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
        for name in endpoints(original):
            engine.request('POST', '/networks/' + urllib.parse.quote(name, safe='') + '/disconnect', {'Container': original['Id'], 'Force': True})
        engine.request('POST', '/containers/' + original['Id'] + '/kill?signal=SIGKILL'); paused = False
        for attempt in range(30):
            if not engine.request('GET', '/containers/' + original['Id'] + '/json')['State'].get('Running'):
                break
            time.sleep(1)
        else:
            raise InstallError('Old container did not exit; cold backup refused.')
        with tarfile.open(backup / 'data.tar.gz', 'w:gz', dereference=False) as archive:
            archive.add(DATA, arcname='data')
        tag = 'cc-bootstrap-snapshot:' + stamp.lower()
        snapshot = engine.request('POST', '/commit?container=' + original['Id'] + '&pause=false&repo=cc-bootstrap-snapshot&tag=' + stamp.lower())['Id']
        (backup / 'snapshot-id').write_text(snapshot)
        (work / 'Dockerfile').write_text(dockerfile(tag))
        (work / '.dockerignore').write_text('fixtures\n')
        final = 'cc-desk-tunnel:managed-bootstrap-' + stamp.lower()
        command(['docker', 'build', '--pull=false', '--network=none', '--memory=384m', '-t', final, str(work)], log)
        image = engine.request('GET', '/images/' + urllib.parse.quote(final, safe='') + '/json')['Id']
        offline_preflight(image, work, release, log)
        engine.request('POST', '/containers/' + original['Id'] + '/rename?name=' + CONTAINER + '-managed-backup-' + stamp.lower())
        intent = {'image': image, 'nonce': os.urandom(16).hex(), 'originalId': original['Id']}
        durable_json(backup / 'replacement-intent.json', intent)
        config = clone_config(original, image)
        config['Labels'] = {**(config.get('Labels') or {}), 'org.cc-desk-tunnel.bootstrap': intent['nonce']}
        replacement = engine.request('POST', '/containers/create?name=' + CONTAINER, config)['Id']
        durable_json(backup / 'replacement-record.json', {'id': replacement})
        (backup / 'replacement-id').write_text(replacement)
        engine.request('POST', '/containers/' + replacement + '/start')
        wait_healthy(engine, replacement)
        live_status(CONTAINER, release)
        record = {'containerId': replacement, 'imageId': image, 'release': release, 'backup': str(backup)}
        temporary = ROOT / 'installed.tmp'; temporary.write_text(json.dumps(record)); temporary.replace(ROOT / 'installed.json')
    except BaseException:
        if paused: engine.request('POST', '/containers/' + original['Id'] + '/unpause')
        if changed:
            if replacement is None:
                replacement, _ = recovery_container(engine, backup, original)
            restore(engine, original, replacement)
            print('Original container restored. Current business data retained.')
        raise
    print('Managed server installed. Local readiness passed; no Claude/provider queries made.')
    print('Local backup: ' + str(backup))
    print('Manual offline rollback: sudo python3 ' + str(backup / 'rollback.py') + ' --rollback ' + str(backup))


def durable_json(path, value):
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w') as stream:
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    if os.name == 'posix':
        fd = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)


def recovery_container(engine, backup, original):
    record = backup / 'replacement-record.json'
    legacy = backup / 'replacement-id'
    replacement = json.loads(record.read_text())['id'] if record.exists() else legacy.read_text().strip() if legacy.exists() else None
    try:
        current = engine.request('GET', '/containers/' + CONTAINER + '/json')
    except EngineError as error:
        if error.status != 404: raise
        current = None
    # An interrupted install may have stopped/renamed the old container but not created a new one.
    # No unknown container may be deleted, even if it occupies the service name.
    if current and current['Id'] not in (replacement, original['Id']):
        intent_path = backup / 'replacement-intent.json'
        intent = json.loads(intent_path.read_text()) if intent_path.exists() else None
        if not (intent and intent.get('originalId') == original['Id'] and
                current.get('Image') == intent.get('image') and
                re.fullmatch(r'[a-f0-9]{32}', intent.get('nonce', '')) and
                current.get('Config', {}).get('Labels', {}).get('org.cc-desk-tunnel.bootstrap') == intent['nonce']):
            raise InstallError('Current container has changed; automatic rollback refused.')
        replacement = current['Id']
        durable_json(record, {'id': replacement})
    return replacement if current and current['Id'] == replacement else None, current


def rollback(engine, backup):
    backup = pathlib.Path(backup).resolve()
    if backup.parent != ROOT or not backup.name.startswith('backup-') or backup.is_symlink():
        raise InstallError('Unexpected rollback directory.')
    original = json.loads((backup / 'original.json').read_text())
    replacement, current = recovery_container(engine, backup, original)
    if current and current['State'].get('Running'):
        active = current['Id']
        paused = current['State'].get('Paused')
        if not paused: engine.request('POST', '/containers/' + active + '/pause')
        try:
            if busy(engine.request('GET', '/containers/' + active + '/top?ps_args=-eo%20pid,args')['Processes']):
                raise InstallError('Finish all tasks and close CC clients before rollback.')
            frozen_idle(current)
        except BaseException:
            if not paused: engine.request('POST', '/containers/' + active + '/unpause')
            raise
        if active == original['Id']:
            engine.request('POST', '/containers/' + active + '/unpause')
    # A prior successful recovery already removed the recorded replacement.
    restore(engine, original, replacement if current and current['Id'] == replacement else None)
    (ROOT / 'installed.json').unlink(missing_ok=True)
    print('Original container restored offline. Current business data retained.')


def install(args, engine, work):
    if socket.gethostname().split('.')[0] != PROFILE['node']:
        raise InstallError('Only the reviewed first Ubuntu (ubuntu-cc) is supported.')
    original = engine.request('GET', '/containers/' + CONTAINER + '/json')
    validate_runtime(original)
    marker = ROOT / 'installed.json'
    if marker.exists():
        record = json.loads(marker.read_text())
        if record['containerId'] == original['Id'] and record['imageId'] == original['Image']:
            live_status(CONTAINER, record['release'], allow_newer=True)
            print('Managed bootstrap is already installed. Use CC for subsequent confirmed program updates.')
            return
        raise InstallError('Previous bootstrap state exists; administrator review required.')
    checked_sources(CONTAINER, PROFILE['files'])
    runtime_and_policy(CONTAINER)
    if busy(engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20pid,args')['Processes']):
        raise InstallError('Finish all tasks and close CC clients before installing.')
    index = download('/cc-updates/server/v1/channels/pilot/linux-x64.json', 128 * 1024)
    payload = verify_index(index, original['Image'], args.build, args.sha256)
    release = payload['release']
    path = '/cc-updates/server/v1/artifacts/{build}/linux-x64/cc-desk-tunnel-server-{appVersion}-build{build}.tar.gz'.format(**release)
    archive = download(path, 64 * 1024 * 1024)
    unpack(archive, work / 'program', release)
    validate_target(work / 'program', release)
    # Offline preflight before downtime uses the actual current image, never the stale base/checkout.
    tag = 'cc-bootstrap-preflight:' + os.urandom(8).hex()
    engine.request('POST', '/images/' + urllib.parse.quote(original['Image'], safe='') + '/tag?repo=cc-bootstrap-preflight&tag=' + tag.split(':')[1])
    (work / 'Dockerfile').write_text(dockerfile(tag))
    (work / '.dockerignore').write_text('fixtures\n')
    candidate = 'cc-bootstrap-candidate:' + tag.split(':')[1]
    command(['docker', 'build', '--pull=false', '--network=none', '--memory=384m', '-t', candidate, str(work)], ROOT / 'preflight.log')
    offline_preflight(candidate, work, release, ROOT / 'preflight.log')
    checked_sources(CONTAINER, PROFILE['files'])
    runtime_and_policy(CONTAINER)
    if datetime.datetime.fromisoformat(payload['expiresAt'].replace('Z', '+00:00')).timestamp() <= time.time():
        raise InstallError('Signed index expired during preflight; refresh the command.')
    replace(engine, original, work, release)


def main():
    import fcntl
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', type=int)
    parser.add_argument('--sha256')
    parser.add_argument('--rollback')
    args = parser.parse_args()
    if os.geteuid() != 0: raise InstallError('Run with sudo.')
    os.umask(0o077)
    if ROOT.exists() and (ROOT.is_symlink() or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o077):
        raise InstallError('Unsafe bootstrap backup directory.')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(ROOT / 'install.lock', 'w') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise InstallError('Another bootstrap operation is running.')
        if args.rollback:
            rollback(Engine(), args.rollback)
            return
        positive(args.build); digest(args.sha256)
        with tempfile.TemporaryDirectory(prefix='work-', dir=ROOT) as d:
            install(args, Engine(), pathlib.Path(d))


if __name__ == '__main__':
    try: main()
    except KeyboardInterrupt:
        print('Bootstrap cancelled; check the local backup before retrying.', file=sys.stderr); sys.exit(1)
    except InstallError as error:
        print(str(error), file=sys.stderr); sys.exit(1)
    except Exception:
        print('Bootstrap failed. Automatic rollback was attempted after downtime; check the private local backup. No container credentials are printed.', file=sys.stderr); sys.exit(1)
