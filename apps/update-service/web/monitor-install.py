#!/usr/bin/env python3
"""First-node passive monitor installer. Uses only Python stdlib and local Docker.

No provider calls, package-manager downloads, or account credential reads.
Backups and Docker snapshots remain on the Ubuntu host, never uploaded.
"""
import argparse
import copy
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

NODE = 'ubuntu-cc'
CONTAINER = 'cc-desk-tunnel-ba938975-proxy-1'
BASE = 'sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f'
ROOT = pathlib.Path('/var/lib/cc-monitor-install')


class InstallError(Exception):
    pass


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
                raise InstallError('Docker operation failed (HTTP %s).' % response.status)
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
                'apps/server/src/main.ts' in args or '/app/healthcheck.mjs' in args):
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


def clone_config(original, image, env):
    config = copy.deepcopy(original['Config'])
    config['Image'] = image
    config['Env'] = [v for v in config.get('Env', []) if v.split('=', 1)[0] not in env]
    config['Env'].extend(k + '=' + v for k, v in env.items())
    config['HostConfig'] = copy.deepcopy(original['HostConfig'])
    config['NetworkingConfig'] = {'EndpointsConfig': endpoints(original)}
    return config


def validate_runtime(original):
    host = original['HostConfig']
    mode = host.get('NetworkMode', '')
    if not original['State'].get('Running') or original['State'].get('Paused'):
        raise InstallError('CC container must be running and not paused.')
    if host.get('AutoRemove') or host.get('VolumesFrom') or mode in ('host', 'none') or mode.startswith('container:'):
        raise InstallError('Unsupported container configuration; nothing has been changed.')
    if host.get('PublishAllPorts') or any(b.get('HostPort', '') in ('', '0')
            for bindings in host.get('PortBindings', {}).values() for b in (bindings or [])):
        raise InstallError('Dynamic port bindings require a separate reviewed installer.')
    mounts = original.get('Mounts', [])
    data = [m for m in mounts if m['Destination'] == '/data']
    if len(data) != 1 or data[0]['Type'] != 'bind' or data[0]['Source'] != '/srv/cc-desk-tunnel':
        raise InstallError('Expected /srv/cc-desk-tunnel bind mount at /data.')
    for mount in mounts:
        if mount['Type'] != 'bind':
            raise InstallError('Only existing bind mounts are supported by this installer.')
        if mount.get('RW') and mount['Destination'] != '/data':
            raise InstallError('Additional writable mounts require a separate reviewed installer.')
        if mount['Destination'] == '/app' or mount['Destination'].startswith('/app/'):
            raise InstallError('Runtime source mounts are not supported.')


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


def unpack(bytes_, destination):
    with tarfile.open(fileobj=io.BytesIO(bytes_), mode='r:gz') as archive:
        if sum(m.size for m in archive.getmembers()) > 4 * 1024 * 1024:
            raise InstallError('Unexpected package size.')
        for member in archive.getmembers():
            p = pathlib.PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()):
                raise InstallError('Unsafe package entry.')
        archive.extractall(destination, filter='data') if sys.version_info >= (3, 12) else archive.extractall(destination)


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


def install(args, engine, work):
    if socket.gethostname().split('.')[0] != NODE:
        raise InstallError('This command is prepared only for the FIRST Ubuntu (ubuntu-cc).')
    original = engine.request('GET', '/containers/' + CONTAINER + '/json')
    validate_runtime(original)
    # A successful installation is idempotent. It does not consume a fresh grant.
    marker = ROOT / 'installed.json'
    if marker.exists():
        record = json.loads(marker.read_text(encoding='utf-8'))
        if record['containerId'] == original['Id'] and original['Image'] == record['imageId']:
            checked_sources(CONTAINER, record['sources'])
            print('Passive monitor already installed. Await normal CC activity for fresh reports.')
            return
    if original['Image'] != BASE:
        raise InstallError('Container image does not match the reviewed v0.3.6 image.')
    if busy(engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20args')['Processes']):
        raise InstallError('Claude/SDK task is running. Finish it and close all CC clients, then retry.')
    if not original.get('Config', {}).get('Healthcheck'):
        raise InstallError('Existing local health check is required.')
    print('Checking the first Ubuntu; downloading one private installation bundle from VPS...')
    request = urllib.request.Request(args.origin + '/cc-updates/admin/api/monitor/enrollment/redeem',
                                    data=b'{}', method='POST', headers={
                                        'Authorization': 'Bearer ' + args.code,
                                        'Content-Type': 'application/json'})
    # Do not forward an enrollment credential across a redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        bundle = response.read(1024 * 1024 + 1)
    if hashlib.sha256(bundle).hexdigest() != args.sha256:
        raise InstallError('Private package verification failed. Generate a new command.')
    unpack(bundle, work)
    manifest = json.loads((work / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['node'] != NODE or manifest['baseImage'] != BASE or manifest['version'] != '0.3.6':
        raise InstallError('Package is for another node/version.')
    checked_sources(CONTAINER, manifest['before'])
    env = {}
    for line in (work / 'monitor.env').read_text(encoding='utf-8').splitlines():
        if line:
            k, v = line.split('=', 1)
            env[k] = v
    if set(env) != {'PROXY_MONITOR_URL', 'PROXY_MONITOR_NODE_ID', 'PROXY_MONITOR_TOKEN'} or env['PROXY_MONITOR_NODE_ID'] != NODE or env['PROXY_MONITOR_URL'] != args.origin + '/cc-updates/admin/api/monitor/report' or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', env['PROXY_MONITOR_TOKEN']):
        raise InstallError('Invalid private monitor configuration.')
    for path, digest in manifest['after'].items():
        if hashlib.sha256((work / 'patch' / path).read_bytes()).hexdigest() != digest:
            raise InstallError('Patch source verification failed.')
    # Archives built on Windows can carry mode 0666. Runtime code must remain
    # root-owned and unwritable by the unprivileged CC/Claude container user.
    for tree in ('patch', 'tests'):
        for path in (work / tree).rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    backup = ROOT / ('backup-' + stamp)
    backup.mkdir(mode=0o700)
    log = backup / 'offline-build.log'
    candidate = 'cc-monitor-offline-test:' + stamp.lower()
    local_base = 'cc-monitor-local-base:' + stamp.lower()
    engine.request('POST', '/images/' + BASE + '/tag?repo=cc-monitor-local-base&tag=' + stamp.lower())
    # BuildKit treats a raw sha256 image ID in FROM as a registry repository.
    # A verified local tag avoids that registry resolution and needs no download.
    (work / 'Dockerfile').write_text('FROM ' + local_base + '\nCOPY --chown=root:root patch/ /app/\nCOPY tests/ /app/apps/server/test/\n', encoding='utf-8')
    (work / '.dockerignore').write_text('monitor.env\n', encoding='utf-8')
    print('Verifying the patch offline with simulated tests (no account mounts or network)...')
    command(['docker', 'build', '--pull=false', '--network=none', '-t', candidate, str(work)], log)
    command(['docker', 'run', '--rm', '--network=none', '--workdir', '/app', '--entrypoint', 'node', candidate, '--test',
             'apps/server/test/account-monitor.test.ts', 'apps/server/test/native-controls.test.ts',
             'apps/server/test/monitor-moderation.test.ts'], log)
    # Keep only the six reviewed source files in the final image; tests stay out.
    (backup / 'original.json').write_text(json.dumps(original), encoding='utf-8')
    installer = pathlib.Path(__file__).read_bytes() if '__file__' in globals() else None
    # Bootstrap exec sets __file__ to a temporary, verified copy before calling install.
    if installer:
        (backup / 'rollback.py').write_bytes(installer)
    paused = False
    changed = False
    replacement = None
    try:
        # Freeze all processes, then check again before disconnecting clients. No new run can start here.
        engine.request('POST', '/containers/' + original['Id'] + '/pause')
        paused = True
        if busy(engine.request('GET', '/containers/' + original['Id'] + '/top?ps_args=-eo%20args')['Processes']):
            raise InstallError('A task started during preparation. Nothing installed; close CC clients and retry.')
        frozen_idle(original)
        changed = True
        for name in endpoints(original):
            engine.request('POST', '/networks/' + urllib.parse.quote(name, safe='') + '/disconnect', {'Container': original['Id'], 'Force': True})
        # Never unfreeze the old server: buffered WebSocket input or an awaited
        # review could otherwise start a new Claude process before SIGTERM arrives.
        # All CLI/network/session gates above passed. SQLite's WAL is preserved in
        # the complete cold data backup and recovers normally after restart.
        engine.request('POST', '/containers/' + original['Id'] + '/kill?signal=SIGKILL')
        paused = False
        print('Saving local backup and preserving the existing container configuration...')
        data = pathlib.Path('/srv/cc-desk-tunnel')
        size = sum(p.stat().st_size for p in data.rglob('*') if p.is_file() and not p.is_symlink())
        if shutil.disk_usage(ROOT).free < size * 2 + 512 * 1024 * 1024:
            raise InstallError('Insufficient disk space for the local backup.')
        with tarfile.open(backup / 'data.tar.gz', 'w:gz', dereference=False) as archive:
            archive.add(data, arcname='data')
        # Snapshot the writable container layer too (local only); do not lose tools/settings outside /data.
        snapshot = engine.request('POST', '/commit?container=' + original['Id'] + '&pause=false&repo=cc-monitor-local-snapshot&tag=' + stamp.lower())['Id']
        (backup / 'snapshot-id').write_text(snapshot, encoding='utf-8')
        (work / 'Dockerfile').write_text('FROM cc-monitor-local-snapshot:' + stamp.lower() + '\nCOPY --chown=root:root patch/ /app/\n', encoding='utf-8')
        final = 'cc-desk-tunnel:passive-monitor-' + stamp.lower()
        command(['docker', 'build', '--pull=false', '--network=none', '-t', final, str(work)], log)
        image = engine.request('GET', '/images/' + urllib.parse.quote(final, safe='') + '/json')['Id']
        oldname = CONTAINER + '-monitor-backup-' + stamp.lower()
        engine.request('POST', '/containers/' + original['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
        engine.request('POST', '/containers/' + original['Id'] + '/rename?name=' + oldname)
        created = engine.request('POST', '/containers/create?name=' + CONTAINER, clone_config(original, image, env))
        replacement = created['Id']
        (backup / 'replacement-id').write_text(replacement, encoding='utf-8')
        engine.request('POST', '/containers/' + replacement + '/start')
        wait_healthy(engine, replacement)
        expected = {**manifest['before'], **manifest['after']}
        checked_sources(CONTAINER, expected)
        marker.write_text(json.dumps({'containerId': replacement, 'imageId': image, 'sources': expected,
                                      'backup': str(backup)}), encoding='utf-8')
    except BaseException:
        if paused:
            engine.request('POST', '/containers/' + original['Id'] + '/unpause')
        if changed:
            restore(engine, original, replacement)
            print('Original CC container restored. Current business data retained.')
        raise
    print('Passive monitor installed; local health check passed. No Claude queries were made.')
    print('Next: open CC normally. The VPS account page updates after CC next obtains account/quota data.')
    print('Local backup: ' + str(backup))
    print('Manual rollback: sudo python3 ' + str(backup / 'rollback.py') + ' --rollback ' + str(backup))


def main():
    import fcntl
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin')
    parser.add_argument('--code')
    parser.add_argument('--sha256')
    parser.add_argument('--rollback')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise InstallError('Run this command with sudo.')
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(ROOT / 'install.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError('Another monitor installation is already running.')
        engine = Engine()
        if args.rollback:
            backup = pathlib.Path(args.rollback).resolve()
            if backup.parent != ROOT or not backup.name.startswith('backup-'):
                raise InstallError('Unexpected rollback directory.')
            current = engine.request('GET', '/containers/' + CONTAINER + '/json')
            original = json.loads((backup / 'original.json').read_text(encoding='utf-8'))
            replacement = (backup / 'replacement-id').read_text(encoding='utf-8').strip()
            if current['Id'] != replacement:
                raise InstallError('Current container has changed; automatic rollback refused.')
            if current['State'].get('Running'):
                already_paused = current['State'].get('Paused')
                if not already_paused:
                    engine.request('POST', '/containers/' + current['Id'] + '/pause')
                try:
                    if busy(engine.request('GET', '/containers/' + current['Id'] + '/top?ps_args=-eo%20args')['Processes']):
                        raise InstallError('Finish all Claude tasks and close CC clients before rollback.')
                    frozen_idle(current)
                except BaseException:
                    if not already_paused:
                        engine.request('POST', '/containers/' + current['Id'] + '/unpause')
                    raise
            restore(engine, original, replacement)
            (ROOT / 'installed.json').unlink(missing_ok=True)
            print('Original container restored. Current data retained.')
            return
        if args.origin != 'https://api.ghostapi.org' or not args.code or not re.fullmatch(r'[A-Za-z0-9_-]{43}', args.code) or not args.sha256 or not re.fullmatch(r'[a-f0-9]{64}', args.sha256):
            raise InstallError('Invalid installation command. Generate a new command in the account page.')
        # Workdir is root-private; delete the long-lived monitor token after use or failure.
        with tempfile.TemporaryDirectory(prefix='work-', dir=ROOT) as folder:
            install(args, engine, pathlib.Path(folder))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Installation cancelled.', file=sys.stderr)
        sys.exit(1)
    except InstallError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # No raw provider/HTTP/container exceptions: these may include credentials.
        print('Installation failed. If CC was stopped, automatic rollback was attempted. Check local backup; generate a new command to retry.', file=sys.stderr)
        sys.exit(1)
