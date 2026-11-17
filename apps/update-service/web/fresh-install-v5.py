#!/usr/bin/env python3
"""Dedicated Ubuntu 24.04 x64 deployment. Never executes Claude or requests provider APIs."""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import platform
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = pathlib.Path('/var/lib/cc-fresh-install')
DATA = pathlib.Path('/srv/cc-desk-tunnel')
CONTAINER = 'cc-desk-tunnel'
LOGIN = pathlib.Path('/usr/local/bin/cc-claude-login')
ORIGIN = 'https://api.ghostapi.org'
SUPPORT_SHA = '270c5899ebf247d09055fe2ec7bf0e038fa596845f6e9bfad73de48b5b797ae0'
NODE_SHA = 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'
NODE_RUNTIMES = {
    'node24-cli2.1.295-v1': ('24.21.0', NODE_SHA),
    'node24-cli2.1.295-v2': ('24.22.2', '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75'),
    'node24-cli2.1.295-v3': ('24.22.2', '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75'),
    'node24-cli2.1.295-v4': ('24.22.2', '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75'),
    'node24-cli2.1.325-v4': ('24.22.2', '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75'),
}
CLI_ARCHIVE_SHA = 'd45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95'
CLI_SHA = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
CLI_RUNTIMES = {
    'node24-cli2.1.325-v4': ('2.1.325', 'e8735d37521f49c31d65c3dcd8c0c8babe6d1f5f72c2066346b3ae88d32ac31d',
                           '0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf'),
}
KEYS = {'managed-vps-2026-10-23': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAH4kVnTl+XgMx+Up2F5Om4YlRfZVi+1bXed67n+Q+yGI=\n-----END PUBLIC KEY-----\n'}
BUILD_SPACE = 6 * 1024 ** 3
OPERATING_RESERVE = 512 * 1024 ** 2
RECOVERY_SUPPORT = {
    'scripts/install-cc-space-037.py': '30fac9186307a804a61353582413b76402afcda5a14506b033559ca56d80bd52',
    'scripts/retire-ubuntu-cc-backups.py': 'e6be3d622b0825cf00a7419b0eac565bf04c9c4d66834704f458e5c6856e0d24',
}
RECOVERY_MODULE_SHA = '6234b2b59e9d762f7f8c6f500b255a8d93d12bb16786ecf858c0268a4310a11d'


class InstallError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def download(url, limit, data=None, token=None):
    headers = {'content-type': 'application/json'} if data is not None else {}
    if token: headers['authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
        chunks, size, last = [], 0, time.monotonic()
        while size <= limit:
            block = response.read(min(1048576, limit + 1 - size))
            if not block: break
            chunks.append(block)
            size += len(block)
            if time.monotonic() - last >= 15:
                print('DOWNLOADING: %s MiB received...' % (size // 1048576), flush=True)
                last = time.monotonic()
        result = b''.join(chunks)
    if len(result) > limit: raise InstallError('Download exceeded its size limit.')
    return result


def private_json(path, value):
    temporary = path.with_suffix('.next')
    if temporary.is_symlink() or path.is_symlink():
        raise InstallError('Unexpected linked installation record.')
    with temporary.open('w') as stream:
        temporary.chmod(0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    if os.name == 'posix':
        descriptor = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)


def storage_paths():
    paths = [ROOT, DATA.parent]
    if shutil.which('docker'):
        value = run(['docker', 'info', '--format', '{{.DockerRootDir}}'], capture=True, timeout=30)
        docker = pathlib.Path(value)
        if not value or not docker.is_absolute() or not docker.is_dir():
            raise InstallError('Docker storage path is unavailable; no service change.')
        paths.append(docker)
        for path in [pathlib.Path('/var/lib/containerd'), docker / 'containerd']:
            if path.is_dir(): paths.append(path)
    return list(dict.fromkeys(path.resolve() for path in paths))


def check_space(stage, required):
    shortages = []
    for path in storage_paths():
        free = shutil.disk_usage(path).free
        deficit = max(0, required - free)
        print(f'SPACE: stage={stage}; path={path}; available={free}; required={required}; '
              f'deficit={deficit} bytes; available={free / 1024**3:.2f} GiB; '
              f'required={required / 1024**3:.2f} GiB.', flush=True)
        if deficit: shortages.append(f'path={path}; deficit={deficit} bytes')
    if shortages:
        raise InstallError('Insufficient installation space; ' + '; '.join(shortages) +
                           '. No cutover requested; existing service retained.')


def prepare_space(stage, required):
    paths = storage_paths()
    before = {str(path): shutil.disk_usage(path).free for path in paths}
    if shutil.which('docker'):
        print('CLEANUP: removing unused Docker build cache; keeping running service and rollback.', flush=True)
        run(['docker', 'builder', 'prune', '--all', '--force'], timeout=300)
    for path in paths:
        after = shutil.disk_usage(path).free
        print(f'CLEANUP: path={path}; available_before={before[str(path)]}; '
              f'available_after={after}; reclaimed={after - before[str(path)]} bytes.', flush=True)
    check_space(stage, required)


def cached_enrollment(args):
    cached = ROOT / 'enrollment.json'
    if not cached.is_file() or cached.is_symlink():
        if getattr(args, 'resume', False):
            raise InstallError('Local installation cache missing; resume cannot redeem a new installation code.')
        return None
    bundle = json.loads(cached.read_text())
    if bundle.get('nodeId') != args.node or bundle.get('origin') != args.origin:
        raise InstallError('Local installation cache belongs to another node or origin.')
    return bundle


def save_resume_installer(args):
    installer = ROOT / 'installer.py'
    if installer.is_symlink():
        raise InstallError('Local resume installer cannot be a symlink.')
    content = pathlib.Path(__file__).read_bytes()
    temporary = ROOT / 'installer.next'
    if temporary.is_symlink():
        raise InstallError('Local resume staging cannot be a symlink.')
    temporary.write_bytes(content)
    temporary.chmod(0o700)
    temporary.replace(installer)
    command = ['sudo', 'python3', str(installer), '--origin', args.origin,
               '--node', args.node, '--resume']
    if getattr(args, 'reset_existing', False):
        command += ['--reset-existing', '--confirm-host', args.node]
    result = shlex.join(command)
    private_json(ROOT / 'resume.json', {'nodeId': args.node, 'command': result})
    print('RESUME_COMMAND: ' + result, flush=True)
    return result


def load_recovery(program=None):
    directory = ROOT / 'recovery-support'
    if directory.is_symlink(): raise InstallError('Linked recovery support directory.')
    directory.mkdir(mode=0o700, exist_ok=True)
    modules = []
    for relative, expected in RECOVERY_SUPPORT.items():
        target = directory / pathlib.Path(relative).name
        source = program / relative if program is not None else target
        if source.is_symlink() or not source.is_file():
            raise InstallError('Verified offline recovery support missing; no cutover.')
        content = source.read_bytes()
        if hashlib.sha256(content).hexdigest() != expected:
            raise InstallError('Offline recovery support checksum mismatch; no cutover.')
        if target.is_symlink(): raise InstallError('Linked offline recovery support file.')
        if program is not None: target.write_bytes(content)
        spec = importlib.util.spec_from_file_location('fresh_' + target.stem.replace('-', '_'), target)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules.append(module)
    target = ROOT / 'recovery.py'
    if target.is_symlink(): raise InstallError('Linked recovery helper.')
    if program is not None:
        content = download(ORIGIN + '/cc-updates/admin/fresh-install-recovery.py', 262144)
        if hashlib.sha256(content).hexdigest() != RECOVERY_MODULE_SHA:
            raise InstallError('Recovery helper checksum mismatch; no cutover.')
        target.write_bytes(content)
    elif not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != RECOVERY_MODULE_SHA:
        raise InstallError('Cached recovery helper missing or changed; keep installation directory.')
    spec = importlib.util.spec_from_file_location('fresh_recovery', target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Recovery(ROOT, DATA, socket.gethostname(), support_module(reuse=True), *modules)


def run(args, timeout=1800, capture=False):
    if capture:
        return subprocess.check_output(args, timeout=timeout).decode().strip()
    log = ROOT / 'install.log'
    with log.open('ab') as output:
        child = subprocess.Popen(args, stdout=output, stderr=output,
                                 env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
        start = time.monotonic()
        while True:
            try:
                code = child.wait(timeout=15)
                break
            except subprocess.TimeoutExpired:
                elapsed = int(time.monotonic() - start)
                print('RUNNING: %ss; log=%s (%s bytes). Keep this console open.' %
                      (elapsed, log, log.stat().st_size), flush=True)
                if elapsed >= timeout:
                    child.terminate()
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()
                    raise InstallError('Step timed out. Details: ' + str(log))
            except BaseException:
                child.terminate()
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired: child.kill(); child.wait()
                raise
    if code: raise InstallError('Installation step failed. Details: ' + str(log))


def support_module(reuse=False):
    path = ROOT / 'support.py'
    if reuse:
        if not path.is_file(): raise InstallError('Cached readiness helper missing; keep the installation directory.')
        content = path.read_bytes()
    else:
        content = download(ORIGIN + '/cc-updates/admin/server-bootstrap.py', 262144)
    if hashlib.sha256(content).hexdigest() != SUPPORT_SHA:
        raise InstallError('Pinned extraction/readiness helper changed.')
    if not reuse: path.write_bytes(content)
    spec = importlib.util.spec_from_file_location('cc_install_support', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_index(index):
    envelope = json.loads(index)
    if set(envelope) != {'payload', 'keyId', 'signature'} or envelope['keyId'] not in KEYS:
        raise InstallError('Unknown signed index.')
    values = []
    for field in ('payload', 'signature'):
        text = envelope[field]
        if not isinstance(text, str) or not re.fullmatch('[A-Za-z0-9_-]+', text):
            raise InstallError('Invalid signature encoding.')
        value = base64.urlsafe_b64decode(text + '===')
        if base64.urlsafe_b64encode(value).decode().rstrip('=') != text:
            raise InstallError('Non-canonical signature encoding.')
        values.append(value)
    payload, signature = values
    if len(signature) != 64: raise InstallError('Invalid Ed25519 signature.')
    for name, value in [('release.payload', payload), ('release.sig', signature),
                        ('release.pem', KEYS[envelope['keyId']].encode())]:
        (ROOT / name).write_bytes(value)
    run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(ROOT / 'release.pem'),
         '-rawin', '-in', str(ROOT / 'release.payload'), '-sigfile', str(ROOT / 'release.sig')])
    p = json.loads(payload)
    if [p[k] for k in ('schema', 'product', 'channel', 'platform', 'arch')] != [
            1, 'cc-desk-tunnel-managed-server', 'pilot', 'linux', 'x64']:
        raise InstallError('Wrong release identity.')
    issued, expires = [datetime.datetime.fromisoformat(p[k].replace('Z', '+00:00')).timestamp()
                       for k in ('issuedAt', 'expiresAt')]
    if issued > time.time() + 60 or expires <= time.time() or not 0 < expires - issued <= 31 * 86400:
        raise InstallError('Release expired or system clock incorrect. Regenerate the command.')
    r = p['release']
    if r['runtimeLevel'] not in NODE_RUNTIMES or r['size'] > 64 * 1024 * 1024:
        raise InstallError('Unsupported runtime or release size.')
    if (not re.fullmatch(r'[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-zA-Z0-9.]{1,40})?', r['appVersion'])
            or type(r['build']) is not int or r['build'] < 1):
        raise InstallError('Invalid release version.')
    return r


# A fresh machine provisions pinned runtimes directly; it does not call legacy install-linux.sh,
# whose post-install version command would execute Claude. The signed application tree stays intact.
DOCKERFILE = '''FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget openssl openssh-client git rsync bash tini tar xz-utils unzip zip jq ripgrep file less vim-tiny python3 python3-pip python3-venv build-essential pkg-config procps lsof iproute2 dnsutils netcat-openbsd sqlite3 && rm -rf /var/lib/apt/lists/*
RUN userdel -r ubuntu && useradd --uid 1000 --create-home --shell /bin/bash ccdesktunnel && install -d -o ccdesktunnel -g ccdesktunnel /app
COPY --chown=root:root runtime/ /opt/runtime/
ENV PATH=/opt/runtime/node/bin:/opt/runtime/cli/bin:$PATH
COPY --chown=ccdesktunnel:ccdesktunnel program/ /app/
WORKDIR /app
USER ccdesktunnel
RUN npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol && npm cache clean --force
USER root
COPY program/deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint
COPY program/deploy/docker/healthcheck.mjs /app/healthcheck.mjs
COPY program/deploy/docker/runtime-level /opt/runtime/level
RUN if [ -f /app/deploy/docker/terminal-runtime.mjs ]; then /opt/runtime/node/bin/node /app/deploy/docker/terminal-runtime.mjs --record; fi && chmod 755 /usr/local/bin/proxy-entrypoint && chown -R root:root /app /opt/runtime && chmod -R go-w /app /opt/runtime && mkdir -p /data/workspace && chown -R 1000:1000 /data
ENV HOME=/data/home
USER ccdesktunnel
WORKDIR /data/workspace
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "--env-file=/data/config/service.env", "/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/proxy-entrypoint"]
CMD ["server"]
'''


def provision_runtime(work, runtime_level='node24-cli2.1.295-v1'):
    version, node_sha = NODE_RUNTIMES[runtime_level]
    runtime = work / 'runtime'
    if runtime.exists(): shutil.rmtree(runtime)
    (runtime / 'node').mkdir(parents=True)
    (runtime / 'cli/bin').mkdir(parents=True)
    node = download(f'https://nodejs.org/dist/v{version}/node-v{version}-linux-x64.tar.xz', 80 * 1024 * 1024)
    if hashlib.sha256(node).hexdigest() != node_sha: raise InstallError('Node archive digest mismatch.')
    with tarfile.open(fileobj=io.BytesIO(node), mode='r:xz') as archive:
        archive.extractall(work / 'node-extract', filter='data')
    shutil.rmtree(runtime / 'node')
    (work / f'node-extract/node-v{version}-linux-x64').rename(runtime / 'node')
    provision_cli(work, runtime_level)
    for directory in [runtime] + [p for p in runtime.rglob('*') if p.is_dir()]:
        directory.chmod(0o755)


def provision_cli(work, runtime_level):
    if runtime_level not in NODE_RUNTIMES: raise InstallError('Unsupported CLI runtime.')
    version, archive_sha, binary_sha = CLI_RUNTIMES.get(runtime_level, ('2.1.295', CLI_ARCHIVE_SHA, CLI_SHA))
    cli = download(f'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-{version}.tgz', 300 * 1024 * 1024)
    if hashlib.sha256(cli).hexdigest() != archive_sha: raise InstallError('Official Claude archive digest mismatch.')
    with tarfile.open(fileobj=io.BytesIO(cli), mode='r:gz') as archive:
        binary = archive.extractfile('package/claude').read(512 * 1024 * 1024)
    if hashlib.sha256(binary).hexdigest() != binary_sha: raise InstallError('Official Claude binary digest mismatch.')
    runtime = work / 'runtime'
    (runtime / 'cli/bin').mkdir(parents=True, exist_ok=True)
    (runtime / 'cli/bin/claude').write_bytes(binary)
    (runtime / 'cli/bin/claude').chmod(0o755)
    for directory in [runtime, runtime / 'cli', runtime / 'cli/bin']:
        directory.chmod(0o755)


def check_port_available():
    with socket.socket() as probe:
        try: probe.bind(('0.0.0.0', 8787))
        except OSError: raise InstallError('Port 8787 is already in use; installation stopped.')


def ensure_prerequisites(reuse_docker=False):
    if reuse_docker:
        # An existing host must not upgrade/restart Docker or unrelated services via apt/needrestart.
        if not shutil.which('openssl'):
            raise InstallError('Install the missing openssl prerequisite before retrying; existing Docker was not changed.')
        run(['docker', 'info'], capture=True, timeout=30)
        return
    run(['apt-get', 'update'])
    run(['apt-get', 'install', '-y', '--no-install-recommends', 'docker.io', 'ca-certificates', 'openssl', 'xz-utils'])
    run(['systemctl', 'enable', '--now', 'docker'])


def prepared_installation(bundle):
    record = json.loads((ROOT / 'prepared.json').read_text())
    if (record['nodeId'] != bundle['nodeId'] or
            record['indexSha256'] != hashlib.sha256(bundle['index'].encode()).hexdigest() or
            not re.fullmatch(r'sha256:[0-9a-f]{64}', record['image'])):
        raise InstallError('Prepared installation identity mismatch; inspect reset.json before retrying.')
    image = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', record['image']], capture=True, timeout=30)
    if image != record['image']:
        raise InstallError('Prepared image missing or changed; keep the installation directory and isolated data.')
    program = ROOT / 'build/program'
    policy = program / 'deploy/docker/managed-settings.json'
    if not policy.is_file() or hashlib.sha256(policy.read_bytes()).hexdigest() != record['policySha256']:
        raise InstallError('Prepared policy missing or changed; keep the installation directory and isolated data.')
    # This private receipt is written only after signed release verification and offline preflight.
    # Resume that exact admitted release even if its publication has since expired; never rebuild it.
    return record['release'], support_module(reuse=True), program, image


def check_empty_machine(rollback=None):
    if DATA.exists() or DATA.is_symlink():
        raise InstallError('Existing /srv/cc-desk-tunnel detected. Ordinary installation never replaces existing data.')
    check_port_available()
    if shutil.which('docker'):
        daemon = subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        if daemon.returncode: return
        containers = run(['docker', 'ps', '-a', '--format', '{{.Names}}'], capture=True).splitlines()
        if rollback:
            name = 'cc-desk-tunnel-before-' + pathlib.Path(rollback['backup']).name
            if name in containers:
                previous = json.loads(run(['docker', 'inspect', rollback['containerId']], capture=True))[0]
                if (previous.get('Id') != rollback['containerId'] or previous.get('Name') != '/' + name or
                        previous['State'].get('Running') or previous['State'].get('Paused')):
                    raise InstallError('Recorded rollback container changed; installation stopped.')
                containers.remove(name)
        if CONTAINER in containers or any(n.startswith('cc-desk-tunnel-') for n in containers):
            raise InstallError('Existing CC container detected; use its managed upgrade instead.')


def reset_inventory():
    ids = run(['docker', 'ps', '-aq'], capture=True, timeout=30).splitlines()
    return json.loads(run(['docker', 'inspect', *ids], capture=True, timeout=30)) if ids else []


def reset_fingerprint(container):
    value = {k: container[k] for k in ('Id', 'Name', 'Image', 'Config', 'HostConfig')}
    value['Mounts'] = sorted(container['Mounts'], key=lambda m: json.dumps(m, sort_keys=True))
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def reset_target(containers):
    targets = []
    for container in containers:
        name = container['Name'].lstrip('/')
        related = name == CONTAINER or name.startswith('cc-desk-tunnel-')
        for mount in container['Mounts']:
            if mount.get('Type') == 'bind':
                source = pathlib.Path(mount['Source']).resolve()
                if source == DATA or source in DATA.parents or DATA in source.parents:
                    related = True
        if related:
            targets.append(container)
    if len(targets) != 1:
        raise InstallError('Clean reinstall requires exactly one unshared CC deployment.')
    target = targets[0]
    if not re.fullmatch(r'cc-desk-tunnel(?:-[0-9a-f]{8}-proxy-1)?', target['Name'].lstrip('/')):
        raise InstallError('Unrecognized CC container; clean reinstall refused.')
    mounts = target['Mounts']
    data_mounts = [m for m in mounts if m.get('Type') == 'bind' and
                   m.get('Source') == str(DATA) and m.get('Destination') == '/data' and m.get('RW') is True]
    if len(data_mounts) != 1 or any(m != data_mounts[0] and not (
            m.get('Type') == 'bind' and m.get('Destination') == '/etc/claude-code' and m.get('RW') is False)
            for m in mounts):
        raise InstallError('Unexpected CC mounts; clean reinstall refused.')
    return target


def prepare_reset(args):
    enabled = getattr(args, 'reset_existing', False)
    confirmation = getattr(args, 'confirm_host', None)
    journal = ROOT / 'reset.json'
    if journal.exists():
        previous = json.loads(journal.read_text())
        rolled_back = previous.get('phase') == 'rolled-back'
        if previous.get('recoveryVersion') == 1:
            backup = pathlib.Path(previous.get('backup', ''))
            if backup.parent != ROOT or not backup.name.startswith('backup-') or backup.resolve() != backup:
                raise InstallError('Unexpected recovery record; no replay requested.')
            record = json.loads((backup / 'record.json').read_text())
            rolled_back = rolled_back or record.get('phase') == 'rolled-back'
        if rolled_back:
            raise InstallError('Previous attempt restored the pre-installation environment. '
                               'Automatic replay is disabled; inspect the recorded backup before another reinstall.')
        if getattr(args, 'resume', False) and previous.get('recoveryVersion') == 1:
            enabled, confirmation = True, args.node
            args.reset_existing, args.confirm_host = True, args.node
            print('RESUME_MODE: continuing the locally recorded clean reinstall; no new reset requested.', flush=True)
    if not enabled:
        if confirmation:
            raise InstallError('--confirm-host requires --reset-existing.')
        if (ROOT / 'reset.json').exists() and json.loads((ROOT / 'reset.json').read_text())['phase'] != 'done':
            raise InstallError('Pending clean reinstall; rerun the original command with hostname confirmation.')
        return None
    if not confirmation or confirmation != socket.gethostname():
        raise InstallError('Clean reinstall requires --confirm-host matching this machine hostname.')
    if journal.exists():
        plan = json.loads(journal.read_text())
        if plan['nodeId'] != args.node or plan['hostname'] != confirmation:
            raise InstallError('Clean reinstall belongs to another node or hostname.')
        if plan['phase'] == 'rolled-back':
            raise InstallError('Previous attempt restored the pre-installation environment. '
                               'Automatic replay is disabled; inspect the recorded backup before another reinstall.')
        return plan
    if any((ROOT / name).exists() for name in ('configured.json', 'installed.json')):
        raise InstallError('This managed installation already has data; the original command will not reset it.')
    if DATA.is_symlink() or DATA.resolve() != DATA or not DATA.is_dir() or os.path.ismount(DATA):
        raise InstallError('Clean reinstall requires the real, non-mounted CC data directory.')
    target = reset_target(reset_inventory())
    info = DATA.stat()
    return {'nodeId': args.node, 'hostname': confirmation, 'phase': 'prepared',
            'containerId': target['Id'], 'fingerprint': reset_fingerprint(target),
            'wasRunning': target['State'].get('Running') is True,
            'dataIdentity': [info.st_dev, info.st_ino],
            'archive': str(DATA.with_name(DATA.name + '.before-reset-' + secrets.token_hex(8)))}


def finish_reset(plan):
    if not plan or plan['phase'] == 'done':
        return
    archive = pathlib.Path(plan['archive'])
    if (archive.parent != DATA.parent or not archive.name.startswith(DATA.name + '.before-reset-')
            or archive.is_symlink() or DATA.is_symlink() or DATA.resolve() != DATA):
        raise InstallError('Unsafe clean reinstall paths; inspect the private reset journal.')
    containers = reset_inventory()
    old = next((c for c in containers if c['Id'] == plan['containerId']), None)
    if old:
        if reset_target(containers)['Id'] != old['Id'] or reset_fingerprint(old) != plan['fingerprint']:
            raise InstallError('Original CC configuration changed; clean reinstall stopped.')
    elif not archive.is_dir():
        raise InstallError('Original CC container disappeared before data isolation.')
    if DATA.exists():
        info = DATA.stat()
        if archive.exists() or [info.st_dev, info.st_ino] != plan['dataIdentity']:
            raise InstallError('CC data directory changed; clean reinstall stopped.')
    elif not archive.is_dir():
        raise InstallError('CC data and isolation directory are missing.')
    if archive.exists():
        info = archive.stat()
        if [info.st_dev, info.st_ino] != plan['dataIdentity']:
            raise InstallError('CC isolation directory changed; clean reinstall stopped.')
    private_json(ROOT / 'reset.json', plan)
    print('CLEAN_REINSTALL: verified host=' + plan['hostname'] + '; old data isolation=' + str(archive), flush=True)
    if old:
        run(['docker', 'stop', '--time', '30', old['Id']])
        stopped = reset_target(reset_inventory())
        if (reset_fingerprint(stopped) != plan['fingerprint'] or stopped['State'].get('Running')
                or stopped['State'].get('Paused')):
            raise InstallError('CC did not stop with its original configuration; inspect reset.json.')
        try:
            check_port_available()
        except InstallError:
            if plan['wasRunning']:
                run(['docker', 'start', old['Id']])
            raise
    if DATA.exists():
        info = DATA.stat()
        if DATA.is_symlink() or archive.exists() or [info.st_dev, info.st_ino] != plan['dataIdentity']:
            raise InstallError('CC data changed while stopping; inspect reset.json.')
        DATA.rename(archive)
    if old:
        run(['docker', 'rm', old['Id']])
    plan['phase'] = 'done'
    private_json(ROOT / 'reset.json', plan)
    print('CLEAN_REINSTALL_READY: old data isolated and old image retained; retries will not reset new data.', flush=True)


def publish_configuration(record):
    stage = pathlib.Path(record['stage']) if 'stage' in record else None
    if stage and stage.exists():
        if DATA.exists(): raise InstallError('Existing data conflicts with pending configuration; no data was replaced.')
        stage.rename(DATA)
    if not DATA.is_dir(): raise InstallError('Configured data directory is missing; no data was reset.')


def configure(bundle, program, image):
    # Build private configuration beside DATA, so publishing it is one atomic same-filesystem rename.
    # A crash before the marker leaves DATA absent; after the marker a retry finishes the rename.
    data = pathlib.Path(tempfile.mkdtemp(prefix='.cc-desk-tunnel-install-', dir=DATA.parent))
    for name in ('config', 'tls', 'home', 'state', 'workspace'):
        (data / name).mkdir(mode=0o700)
        os.chown(data / name, 1000, 1000)
    policy = ROOT / 'policy'
    policy.mkdir(exist_ok=True, mode=0o755)
    policy.chmod(0o755)
    (policy / 'managed-settings.json').write_bytes((program / 'deploy/docker/managed-settings.json').read_bytes())
    private_json(policy / 'moderation-node.json', {
        'endpoint': ORIGIN + '/cc-updates/v1/moderation/check',
        'nodeId': bundle['nodeId'], 'token': bundle['moderationToken']})
    # The container's uid 1000 reads the policy through the mandatory read-only bind mount.
    for path in policy.iterdir(): path.chmod(0o644)
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '365',
         '-subj', '/CN=cc-desk-tunnel.local', '-addext', 'subjectAltName=DNS:cc-desk-tunnel.local',
         '-addext', 'basicConstraints=critical,CA:FALSE',
         '-keyout', str(data / 'tls/control.key'), '-out', str(data / 'tls/control.crt')])
    token = secrets.token_hex(32)
    env = {
        'PROXY_ADAPTER': 'claude-code', 'PROXY_TOKEN': token, 'PROXY_HOST': '0.0.0.0',
        'PROXY_PORT': '8787', 'PROXY_TLS_MODE': 'direct', 'PROXY_TLS_CERT': '/data/tls/control.crt',
        'PROXY_TLS_KEY': '/data/tls/control.key', 'PROXY_CERT_NAME': 'cc-desk-tunnel.local',
        'HOME': '/data/home', 'CLAUDE_CONFIG_DIR': '/data/home/.claude', 'PROXY_DATA_DIR': '/data/state',
        'CLAUDE_CONTEXT_RETENTION_DAYS': '3650', 'CLAUDE_SETTINGS_PATH': '/data/config/provider.json',
        'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1', 'DISABLE_AUTOUPDATER': '1',
        'PROXY_MONITOR_URL': ORIGIN + '/cc-updates/admin/api/monitor/report',
        'PROXY_MONITOR_NODE_ID': bundle['nodeId'], 'PROXY_MONITOR_TOKEN': bundle['monitorToken'],
    }
    (data / 'config/service.env').write_text(''.join(k + '=' + v + '\n' for k, v in env.items()))
    (data / 'config/provider.json').write_text('{}\n')
    for folder in ('config', 'tls'):
        for path in (data / folder).iterdir():
            path.chmod(0o600)
            os.chown(path, 1000, 1000)
    fingerprint = run(['openssl', 'x509', '-in', str(data / 'tls/control.crt'), '-noout', '-fingerprint', '-sha256'], capture=True).split('=', 1)[1]
    ips = run(['hostname', '-I'], capture=True).split()
    ips = [ip for ip in ips if re.fullmatch(r'[0-9]+(?:\.[0-9]+){3}', ip) and not ip.startswith(('127.', '172.17.'))]
    addresses = ['wss://' + ip + ':8787/ws' for ip in ips] or ['wss://<Ubuntu-IP>:8787/ws']
    details = '\n'.join(['节点：' + bundle['nodeId'], '服务地址（选择与 Windows 可互通的 Ubuntu IP）：',
                         *addresses, '证书指纹：' + fingerprint, '服务凭据：' + token,
                         '如沿用原虚拟机端口转发，请将转发目标改为这台 Ubuntu 的 IP:8787。']) + '\n'
    (ROOT / 'connection.txt').write_text(details)
    (ROOT / 'connection.txt').chmod(0o600)
    os.chown(data, 1000, 1000)
    data.chmod(0o755)
    record = {'nodeId': bundle['nodeId'], 'image': image, 'stage': str(data)}
    private_json(ROOT / 'configured.json', record)
    publish_configuration(record)


def show_connection():
    print((ROOT / 'connection.txt').read_text(), flush=True)
    print('再次查看连接信息：sudo cat /var/lib/cc-fresh-install/connection.txt')
    print('程序部署完成。需要登录自己的 Claude 账号时，请执行：sudo /usr/local/bin/cc-claude-login')


HOST_DATA = pathlib.Path('/var/lib/cc-host-updater')
HOST_PROGRAM = pathlib.Path('/opt/cc-host-platform')
HOST_SOURCES = ('host-platform.py', 'host-platform-entry.py', 'host-bootstrap.py',
                'host-bootstrap-entry.py', 'host-operations.py')


def check_host_platform(bundle=None):
    state_path = HOST_DATA / 'agent-platform/state.json'
    if state_path.is_symlink(): raise InstallError('Linked host platform state.')
    config_path = HOST_DATA / 'config.json'
    if config_path.is_symlink(): raise InstallError('Linked host configuration.')
    if config_path.exists():
        config = json.loads(config_path.read_text())
        if bundle and bundle.get('hostToken') and config == {
                'nodeId': bundle['nodeId'], 'origin': bundle['origin'], 'keys': KEYS, 'token': bundle['hostToken']}:
            return
        raise InstallError('Host configuration belongs to another installation; no fresh enrollment requested.')
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if state.get('current') or state.get('floor'):
        raise InstallError('Host platform is already active; use its normal update action without re-enrollment.')


def cache_host_bootstrap(program, release):
    # program was extracted only after signed app archive verification. Retain these
    # exact bytes outside build/temp directories before any application cutover.
    directory = ROOT / 'host-bootstrap'
    if directory.is_symlink(): raise InstallError('Linked host bootstrap cache.')
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    hashes = {}
    for name in (*HOST_SOURCES, 'host-updater-install.py', 'server-upgrade.cjs'):
        source = program / 'apps/update-service/web' / name
        target = directory / name
        if source.is_symlink() or target.is_symlink(): raise InstallError('Linked host bootstrap source.')
        raw = source.read_bytes()
        if len(raw) > 512 * 1024: raise InstallError('Host bootstrap source too large.')
        hashes[name] = hashlib.sha256(raw).hexdigest()
        temporary = directory / (name + '.next')
        if temporary.is_symlink(): raise InstallError('Linked host bootstrap staging.')
        with temporary.open('wb') as stream:
            temporary.chmod(0o600); stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(target)
    private_json(directory / 'manifest.json', {'build': release['build'], 'sha256': release['sha256'], 'hashes': hashes})


def cached_host_bootstrap(release):
    directory = ROOT / 'host-bootstrap'
    if directory.is_symlink(): raise InstallError('Linked host bootstrap cache.')
    manifest_path = directory / 'manifest.json'
    if manifest_path.is_symlink(): raise InstallError('Linked host bootstrap manifest.')
    manifest = json.loads(manifest_path.read_text())
    if any(manifest.get(key) != release[key] for key in ('build', 'sha256')):
        raise InstallError('Host bootstrap cache does not match the signed application.')
    sources = {}
    for name in (*HOST_SOURCES, 'host-updater-install.py', 'server-upgrade.cjs'):
        path = directory / name
        if path.is_symlink(): raise InstallError('Linked host bootstrap source.')
        raw = path.read_bytes()
        if len(raw) > 512 * 1024 or hashlib.sha256(raw).hexdigest() != manifest['hashes'].get(name):
            raise InstallError('Host bootstrap source checksum mismatch.')
        sources[name] = raw
    spec = importlib.util.spec_from_file_location('cc_fresh_host_install', directory / 'host-updater-install.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    bundle = {'origin': ORIGIN, 'keys': KEYS,
              'sources': {name: base64.b64encode(sources[name]).decode() for name in HOST_SOURCES},
              'hashes': {name: manifest['hashes'][name] for name in HOST_SOURCES},
              'probe': base64.b64encode(sources['server-upgrade.cjs']).decode(),
              'probeSha256': manifest['hashes']['server-upgrade.cjs']}
    return helper, bundle


def complete_host_channel(bundle, release):
    marker = ROOT / 'host-channel.json'
    if marker.is_symlink(): raise InstallError('Linked host channel marker.')
    if marker.exists():
        if json.loads(marker.read_text()) != {'nodeId': bundle['nodeId']}:
            raise InstallError('Host channel marker belongs to another node.')
        return
    if not re.fullmatch('[A-Za-z0-9_-]{43}', bundle.get('hostToken', '')):
        raise InstallError('Application remains installed; host channel credential missing from legacy enrollment cache.')
    helper, trusted = cached_host_bootstrap(release)
    check_host_platform(bundle)
    if HOST_DATA.is_symlink(): raise InstallError('Linked host channel directory.')
    HOST_DATA.mkdir(mode=0o700, exist_ok=True)
    with helper.enrollment_lock(HOST_DATA):
        helper.install_platform(bundle['nodeId'], None, trusted, HOST_DATA, HOST_PROGRAM,
                                pathlib.Path('/etc/systemd/system'), pathlib.Path('/opt/cc-host-updater'),
                                fresh_token=bundle['hostToken'])
    private_json(marker, {'nodeId': bundle['nodeId']})


def install(args):
    if os.geteuid() != 0: raise InstallError('Run this command with sudo.')
    system = platform.freedesktop_os_release()
    if system.get('ID') != 'ubuntu' or system.get('VERSION_ID') != '24.04' or platform.machine() != 'x86_64':
        raise InstallError('Only Ubuntu 24.04 LTS x64 is supported.')
    if args.origin != ORIGIN or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,63}', args.node):
        raise InstallError('Invalid installation origin or node name.')
    os.umask(0o077)
    ROOT.mkdir(exist_ok=True, mode=0o700)
    if ROOT.is_symlink(): raise InstallError('Installation directory cannot be a symlink.')
    ROOT.chmod(0o700)
    login_source = '#!/bin/sh\nexec docker exec -it ' + CONTAINER + ' /opt/runtime/node/bin/node --env-file=/data/config/service.env --input-type=commonjs -e '\
        + "'const p=require(\"node:child_process\").spawn(\"/opt/runtime/cli/bin/claude\",[\"auth\",\"login\"],{stdio:\"inherit\",env:process.env});p.on(\"exit\",c=>process.exit(c??1));'\n"
    with (ROOT / 'install.lock').open('w') as lock:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if LOGIN.is_symlink() or (LOGIN.exists() and LOGIN.read_text() != login_source):
            raise InstallError('Login helper already exists or is a symlink; refusing to overwrite it.')
        bundle = cached_enrollment(args)
        check_host_platform(bundle)
        if bundle is None and not getattr(args, 'code', None):
            raise InstallError('An installation code is required for first enrollment; use --resume only with local cache.')
        reset = prepare_reset(args)
        save_resume_installer(args)
        cached = ROOT / 'enrollment.json'
        if bundle is None:
            if not reset: check_empty_machine()
            print('1/6 Redeeming this machine\'s one-time installation code...', flush=True)
            attempt_path = ROOT / 'enrollment-attempt.json'
            attempt = json.loads(attempt_path.read_text()) if attempt_path.exists() else {}
            if attempt.get('nodeId') != args.node:
                attempt = {'nodeId': args.node, 'installationId': secrets.token_urlsafe(32)}
                private_json(attempt_path, attempt)
            bundle = json.loads(download(ORIGIN + '/cc-updates/admin/api/fresh-nodes/redeem',
                                         262144, data=json.dumps({'installationId': attempt['installationId'], 'hostChannel': True}).encode(), token=args.code))
            if bundle['nodeId'] != args.node or bundle['origin'] != ORIGIN:
                raise InstallError('Enrollment identity mismatch.')
            private_json(cached, bundle)
        if (ROOT / 'installed.json').exists():
            complete_host_channel(bundle, json.loads((ROOT / 'installed.json').read_text()))
            print('Already installed. Use the client for subsequent server updates.')
            show_connection()
            return
        # Once data exists, never reset it or roll back account/session state on a retry.
        initialized = (ROOT / 'configured.json').exists()
        recovery = None
        if initialized:
            record = json.loads((ROOT / 'configured.json').read_text())
            if record['nodeId'] != args.node: raise InstallError('Configuration belongs to another node.')
            publish_configuration(record)
        if not initialized:
            if not reset: check_empty_machine()
        if initialized:
            if (ROOT / 'prepared.json').exists():
                release, support, program, image = prepared_installation(bundle)
                if image != record['image']: raise InstallError('Configured and prepared images disagree; installation stopped.')
            else:
                release = verify_index(bundle['index'])
                support = support_module()
                image = record['image']
            print('Resuming the configured installation; keeping the existing image and credentials.', flush=True)
        elif (ROOT / 'prepared.json').exists():
            release, support, program, image = prepared_installation(bundle)
            print('Resuming the verified image and policy; no download, dependency installation or rebuild.', flush=True)
            if reset and (reset.get('recoveryVersion') or reset['phase'] != 'done'):
                recovery = load_recovery() if reset.get('recoveryVersion') else load_recovery(program)
            check_space('cutover', OPERATING_RESERVE)
        else:
            print('2/6 Installing Docker and prerequisites (first run can take several minutes)...', flush=True)
            prepare_space('build', BUILD_SPACE)
            ensure_prerequisites(reuse_docker=bool(reset))
            check_space('build', BUILD_SPACE)
            if not reset: check_empty_machine()
            print('3/6 Verifying the signed server release and pinned official runtime...', flush=True)
            release = verify_index(bundle['index'])
            support = support_module()
            work = ROOT / 'build'
            work.mkdir(exist_ok=True, mode=0o755)
            program = work / 'program'
            if program.exists(): shutil.rmtree(program)
            url = ORIGIN + '/cc-updates/server/v1/artifacts/%s/linux-x64/cc-desk-tunnel-server-%s-build%s.tar.gz' % (
                release['build'], release['appVersion'], release['build'])
            support.unpack(download(url, 64 * 1024 * 1024), program, release)
            identity = json.loads((program / 'deploy/managed-server.json').read_text())
            if identity['keys'] != KEYS or identity['origin'] != ORIGIN or identity['build'] != release['build']:
                raise InstallError('Unexpected managed server trust identity.')
            if hashlib.sha256((program / 'package-lock.json').read_bytes()).hexdigest() != release['packageLockSha256']:
                raise InstallError('Dependency lockfile mismatch.')
            if bundle.get('hostToken'): cache_host_bootstrap(program, release)
            provision_runtime(work, release['runtimeLevel'])
            (work / 'Dockerfile').write_text(DOCKERFILE)
            image = 'cc-desk-tunnel:fresh-' + str(release['build'])
            print('4/6 Building the service image; progress is printed every 15 seconds...', flush=True)
            run(['docker', 'build', '-t', image, str(work)], timeout=3600)
            if reset:
                image = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], capture=True, timeout=30)
                if not re.fullmatch(r'sha256:[0-9a-f]{64}', image): raise InstallError('Invalid prepared image identity.')
            print('5/6 Checking readiness offline, with no account data and no Claude execution...', flush=True)
            support.offline_preflight(image, work, release, ROOT / 'install.log')
            prepare_space('cutover', OPERATING_RESERVE)
            if reset:
                recovery = load_recovery(program)
                recovery.legacy.check_space()

                private_json(ROOT / 'prepared.json', {
                    'nodeId': bundle['nodeId'], 'indexSha256': hashlib.sha256(bundle['index'].encode()).hexdigest(),
                    'release': release, 'image': image,
                    'policySha256': hashlib.sha256((program / 'deploy/docker/managed-settings.json').read_bytes()).hexdigest()})
        if initialized and reset and reset.get('recoveryVersion'):
            recovery = load_recovery()
        activate_installation(args, bundle, release, support, image,
                              program if not initialized else None, reset, recovery, initialized, login_source)


def activate_installation(args, bundle, release, support, image, program, reset, recovery, initialized, login_source):
    changed = bool(initialized and recovery)
    try:
        if not initialized:
            if reset:
                if recovery:
                    if reset['phase'] != 'done': recovery.legacy.check_space()
                    reset = recovery.prepare(reset)
                    changed = True
                    recovery.cutover(reset)
                else:
                    finish_reset(reset)
            check_empty_machine(reset if recovery else None)
            configure(bundle, program, image)
        names = run(['docker', 'ps', '-a', '--format', '{{.Names}}'], capture=True).splitlines()
        if CONTAINER not in names:
            labels = ['--label', 'cc.fresh.node=' + args.node]
            if recovery:
                nonce = secrets.token_hex(16)
                private_json(pathlib.Path(reset['backup']) / 'replacement-intent.json',
                             {'image': image, 'nonce': nonce, 'originalId': reset['containerId']})
                labels += ['--label', 'org.cc-desk-tunnel.bootstrap=' + nonce]
            run(['docker', 'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
                 *labels, '--security-opt', 'no-new-privileges:true',
                 '--cap-drop', 'ALL', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                 '-p', '8787:8787', '--mount', 'type=bind,src=' + str(DATA) + ',dst=/data',
                 '--mount', 'type=bind,src=' + str(ROOT / 'policy') + ',dst=/etc/claude-code,readonly', image])
        else:
            label = run(['docker', 'inspect', '--format', '{{index .Config.Labels "cc.fresh.node"}}', CONTAINER], capture=True)
            if label != args.node: raise InstallError('Existing container belongs to a different installation.')
            run(['docker', 'start', CONTAINER])
        if recovery:
            current = support.Engine().request('GET', '/containers/' + CONTAINER + '/json')
            intent = json.loads((pathlib.Path(reset['backup']) / 'replacement-intent.json').read_text())
            if (current.get('Image') != intent['image'] or
                    current.get('Config', {}).get('Labels', {}).get('org.cc-desk-tunnel.bootstrap') != intent['nonce']):
                raise InstallError('Replacement identity changed; keep recovery records.')
            private_json(pathlib.Path(reset['backup']) / 'replacement-record.json', {'id': current['Id']})
            support.wait_healthy(support.Engine(), current['Id'])
        support.live_status(CONTAINER, release)
        if recovery:
            current = support.Engine().request('GET', '/containers/' + CONTAINER + '/json')
            recovery.commit(reset, current)
        login = LOGIN
        if login.is_symlink() or (login.exists() and login.read_text() != login_source):
            raise InstallError('Login helper already exists; refusing to overwrite it.')
        login.write_text(login_source)
        login.chmod(0o755)
        private_json(ROOT / 'installed.json', {'nodeId': args.node, 'build': release['build'], 'sha256': release['sha256']})
        print('6/6 SUCCESS: managed service installed. No Claude/provider queries were made.', flush=True)
        show_connection()
    except BaseException:
        if changed and recovery:
            try:
                recovery.rollback(reset)
                print('RECOVERY: pre-installation environment restored and health checked.', flush=True)
            except BaseException as error:
                print('RECOVERY_REQUIRED: automatic recovery did not complete; keep the backup and inspect its rollback command. Error=' + type(error).__name__, flush=True)
        raise
    # Host-channel failure must never enter the application rollback transaction.
    complete_host_channel(bundle, release)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--code')
    parser.add_argument('--resume', action='store_true', help='Resume only this node local cached enrollment; never redeem another code.')
    parser.add_argument('--reset-existing', action='store_true', help='Isolate old CC data and replace its verified container after offline preflight.')
    parser.add_argument('--confirm-host', help='Required for clean reinstall; must equal this Ubuntu hostname.')
    try:
        install(parser.parse_args())
    except KeyboardInterrupt:
        print('\nInterrupted. Keep the installation directory; rerun the same command to resume.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # HTTP errors omit Authorization; subprocess errors never include credential arguments.
        print('INSTALL FAILED: ' + str(error) + '\nDetails: /var/lib/cc-fresh-install/install.log. For clean reinstall, inspect reset.json for data isolation state; rerun the same command to resume.', file=sys.stderr)
        sys.exit(1)
