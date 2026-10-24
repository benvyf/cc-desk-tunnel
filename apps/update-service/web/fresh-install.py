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
CLI_ARCHIVE_SHA = 'd45a2fa14a7ea0b8ab4f56e502de5893c2b816078c71c4d8ab2e4142148f3d95'
CLI_SHA = '4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358'
KEYS = {'managed-vps-2026-10-23': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAH4kVnTl+XgMx+Up2F5Om4YlRfZVi+1bXed67n+Q+yGI=\n-----END PUBLIC KEY-----\n'}


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
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path)


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


def support_module():
    content = download(ORIGIN + '/cc-updates/admin/server-bootstrap.py', 262144)
    if hashlib.sha256(content).hexdigest() != SUPPORT_SHA:
        raise InstallError('Pinned extraction/readiness helper changed.')
    path = ROOT / 'support.py'
    path.write_bytes(content)
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
    if r['runtimeLevel'] != 'node24-cli2.1.295-v1' or r['size'] > 64 * 1024 * 1024:
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
RUN chmod 755 /usr/local/bin/proxy-entrypoint && chown -R root:root /app /opt/runtime && chmod -R go-w /app /opt/runtime && mkdir -p /data/workspace && chown -R 1000:1000 /data
ENV HOME=/data/home
USER ccdesktunnel
WORKDIR /data/workspace
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "--env-file=/data/config/service.env", "/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/proxy-entrypoint"]
CMD ["server"]
'''


def provision_runtime(work):
    runtime = work / 'runtime'
    if runtime.exists(): shutil.rmtree(runtime)
    (runtime / 'node').mkdir(parents=True)
    (runtime / 'cli/bin').mkdir(parents=True)
    node = download('https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz', 80 * 1024 * 1024)
    if hashlib.sha256(node).hexdigest() != NODE_SHA: raise InstallError('Node archive digest mismatch.')
    with tarfile.open(fileobj=io.BytesIO(node), mode='r:xz') as archive:
        archive.extractall(work / 'node-extract', filter='data')
    shutil.rmtree(runtime / 'node')
    (work / 'node-extract/node-v24.21.0-linux-x64').rename(runtime / 'node')
    cli = download('https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.295.tgz', 300 * 1024 * 1024)
    if hashlib.sha256(cli).hexdigest() != CLI_ARCHIVE_SHA: raise InstallError('Official Claude archive digest mismatch.')
    with tarfile.open(fileobj=io.BytesIO(cli), mode='r:gz') as archive:
        binary = archive.extractfile('package/claude').read(300 * 1024 * 1024)
    if hashlib.sha256(binary).hexdigest() != CLI_SHA: raise InstallError('Official Claude binary digest mismatch.')
    (runtime / 'cli/bin/claude').write_bytes(binary)
    (runtime / 'cli/bin/claude').chmod(0o755)
    for directory in [runtime] + [p for p in runtime.rglob('*') if p.is_dir()]:
        directory.chmod(0o755)


def check_empty_machine():
    if DATA.exists() or DATA.is_symlink():
        raise InstallError('Existing /srv/cc-desk-tunnel detected. This installer never overwrites an existing deployment.')
    with socket.socket() as probe:
        try: probe.bind(('0.0.0.0', 8787))
        except OSError: raise InstallError('Port 8787 is already in use; no existing service was changed.')
    if shutil.which('docker'):
        daemon = subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        if daemon.returncode: return
        containers = run(['docker', 'ps', '-a', '--format', '{{.Names}}'], capture=True).splitlines()
        if CONTAINER in containers or any(n.startswith('cc-desk-tunnel-') for n in containers):
            raise InstallError('Existing CC container detected; use its managed upgrade instead.')


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
    with (ROOT / 'install.lock').open('w') as lock:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        cached = ROOT / 'enrollment.json'
        if cached.exists():
            bundle = json.loads(cached.read_text())
            if bundle['nodeId'] != args.node: raise InstallError('This machine is already assigned to another node.')
        else:
            check_empty_machine()
            print('1/6 Redeeming this machine\'s one-time installation code...', flush=True)
            attempt_path = ROOT / 'enrollment-attempt.json'
            attempt = json.loads(attempt_path.read_text()) if attempt_path.exists() else {}
            if attempt.get('nodeId') != args.node:
                attempt = {'nodeId': args.node, 'installationId': secrets.token_urlsafe(32)}
                private_json(attempt_path, attempt)
            bundle = json.loads(download(ORIGIN + '/cc-updates/admin/api/fresh-nodes/redeem',
                                         262144, data=json.dumps({'installationId': attempt['installationId']}).encode(), token=args.code))
            if bundle['nodeId'] != args.node or bundle['origin'] != ORIGIN:
                raise InstallError('Enrollment identity mismatch.')
            private_json(cached, bundle)
        if (ROOT / 'installed.json').exists():
            print('Already installed. Use the client for subsequent server updates.')
            show_connection()
            return
        # Once data exists, never reset it or roll back account/session state on a retry.
        initialized = (ROOT / 'configured.json').exists()
        if initialized:
            record = json.loads((ROOT / 'configured.json').read_text())
            if record['nodeId'] != args.node: raise InstallError('Configuration belongs to another node.')
            publish_configuration(record)
        if not initialized:
            check_empty_machine()
        if initialized:
            release = verify_index(bundle['index'])
            support = support_module()
            image = record['image']
            print('Resuming the configured installation; keeping the existing image and credentials.', flush=True)
        else:
            print('2/6 Installing Docker and prerequisites (first run can take several minutes)...', flush=True)
            if shutil.disk_usage('/').free < 6 * 1024 ** 3:
                raise InstallError('At least 6 GiB free disk space is required before building.')
            run(['apt-get', 'update'])
            run(['apt-get', 'install', '-y', '--no-install-recommends', 'docker.io', 'ca-certificates', 'openssl', 'xz-utils'])
            run(['systemctl', 'enable', '--now', 'docker'])
            check_empty_machine()
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
            provision_runtime(work)
            (work / 'Dockerfile').write_text(DOCKERFILE)
            image = 'cc-desk-tunnel:fresh-' + str(release['build'])
            print('4/6 Building the service image; progress is printed every 15 seconds...', flush=True)
            run(['docker', 'build', '-t', image, str(work)], timeout=3600)
            print('5/6 Checking readiness offline, with no account data and no Claude execution...', flush=True)
            support.offline_preflight(image, work, release, ROOT / 'install.log')
            configure(bundle, program, image)
        names = run(['docker', 'ps', '-a', '--format', '{{.Names}}'], capture=True).splitlines()
        if CONTAINER not in names:
            run(['docker', 'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
                 '--label', 'cc.fresh.node=' + args.node, '--security-opt', 'no-new-privileges:true',
                 '--cap-drop', 'ALL', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                 '-p', '8787:8787', '--mount', 'type=bind,src=' + str(DATA) + ',dst=/data',
                 '--mount', 'type=bind,src=' + str(ROOT / 'policy') + ',dst=/etc/claude-code,readonly', image])
        else:
            label = run(['docker', 'inspect', '--format', '{{index .Config.Labels "cc.fresh.node"}}', CONTAINER], capture=True)
            if label != args.node: raise InstallError('Existing container belongs to a different installation.')
            run(['docker', 'start', CONTAINER])
        support.live_status(CONTAINER, release)
        login = LOGIN
        login_source = '#!/bin/sh\nexec docker exec -it ' + CONTAINER + ' /opt/runtime/node/bin/node --env-file=/data/config/service.env --input-type=commonjs -e '\
            + "'const p=require(\"node:child_process\").spawn(\"/opt/runtime/cli/bin/claude\",[\"auth\",\"login\"],{stdio:\"inherit\",env:process.env});p.on(\"exit\",c=>process.exit(c??1));'\n"
        if login.exists() and login.read_text() != login_source:
            raise InstallError('Login helper already exists; refusing to overwrite it.')
        login.write_text(login_source)
        login.chmod(0o755)
        private_json(ROOT / 'installed.json', {'nodeId': args.node, 'build': release['build'], 'sha256': release['sha256']})
        print('6/6 SUCCESS: managed service installed. No Claude/provider queries were made.', flush=True)
        show_connection()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    parser.add_argument('--node', required=True)
    parser.add_argument('--code', required=True)
    try:
        install(parser.parse_args())
    except KeyboardInterrupt:
        print('\nInterrupted. Keep the installation directory; rerun the same command to resume.', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # HTTP errors omit Authorization; subprocess errors never include credential arguments.
        print('INSTALL FAILED: ' + str(error) + '\nDetails: /var/lib/cc-fresh-install/install.log. Existing CC data was not reset.', file=sys.stderr)
        sys.exit(1)
