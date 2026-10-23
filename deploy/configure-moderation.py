#!/usr/bin/env python3
"""Import an already issued node credential; never enroll nodes or call a model."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import stat
import tempfile
from urllib.parse import urlsplit

TARGET = '/etc/claude-code'
NODE_PATH = TARGET + '/moderation-node.json'
POLICY = Path(__file__).parent / 'docker/managed-settings.json'
EVENTS = ('UserPromptSubmit', 'PostToolBatch', 'UserPromptExpansion', 'PreCompact')
EXPECTED_POLICY = {'hooks': {event: [{'hooks': [{'type': 'command',
    'command': '/opt/runtime/node/bin/node /app/apps/server/src/native-moderation-hook.ts',
    'timeout': 10, 'onFailure': 'block'}]}] for event in EVENTS}}


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def regular(path):
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'Managed paths must not contain symlinks')
    need(path.is_file() and stat.S_ISREG(path.stat().st_mode), 'Expected a regular file')


def node_bytes(path):
    regular(path)
    need(path.stat().st_size <= 4096, 'Node configuration is too large')
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
        need(isinstance(value, dict) and set(value) == {'endpoint', 'nodeId', 'token'},
             'Invalid node configuration')
        url = urlsplit(value['endpoint'])
        need(url.scheme == 'https' and bool(url.hostname) and not url.username and not url.password and
             not url.query and not url.fragment and url.path == '/cc-updates/v1/moderation/check',
             'Invalid node endpoint')
        need(isinstance(value['nodeId'], str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['nodeId']) and
             isinstance(value['token'], str) and re.fullmatch(r'[A-Za-z0-9_-]{43}', value['token']),
             'Invalid node identity or credential')
    except (ValueError, TypeError, KeyError):
        raise RuntimeError('Invalid node configuration') from None
    return raw


def owned(path, uid, gid):
    if hasattr(os, 'chown'):
        os.chown(path, uid, gid)


def directory(path, mode):
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'Managed paths must not contain symlinks')
    path.mkdir(mode=mode, exist_ok=True)
    need(path.is_dir(), 'Expected a managed directory')
    owned(path, 0, 0)
    path.chmod(mode)


def atomic(path, content, mode=None, owner=None):
    if path.exists():
        regular(path)
        previous = path.stat()
        mode = stat.S_IMODE(previous.st_mode) if mode is None else mode
        owner = (previous.st_uid, previous.st_gid) if owner is None else owner
    else:
        need(not path.is_symlink(), 'Managed path must not be a symlink')
        mode = 0o600 if mode is None else mode
        owner = (0, 0) if owner is None else owner
    descriptor, temporary = tempfile.mkstemp(prefix='.review-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
            output.flush()
            owned(temporary, *owner)
            os.chmod(temporary, mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def pattern(key):
    return re.compile(rb'^[ \t]*(?:export[ \t]+)?' + key.encode() + rb'[ \t]*=[^\n]*', re.M)


def value(content, key):
    lines = pattern(key).findall(content)
    need(len(lines) <= 1, 'Duplicate managed setting: ' + key)
    if not lines:
        return None
    parsed = shlex.split(lines[0].split(b'=', 1)[1].decode(), comments=False)
    need(len(parsed) == 1, 'Invalid managed setting: ' + key)
    return parsed[0]


def setting(content, key, text):
    need(not any(c in text for c in "'\r\n$`"), 'Unsupported managed path')
    value(content, key)
    line = (key + "='" + text + "'").encode()
    if pattern(key).search(content):
        return pattern(key).sub(lambda _: line, content, count=1)
    return content + (b'' if not content or content.endswith(b'\n') else b'\n') + line + b'\n'


def paths(data, config):
    need(data.is_absolute() and config.is_absolute(), 'Use absolute deployment paths')
    regular(data / '.cc-desk-tunnel-data')
    regular(data / 'config/service.env')
    regular(config)
    return data / '.managed', data / '.managed/claude-code'


def metadata(path):
    info = path.stat()
    return stat.S_IMODE(info.st_mode), (info.st_uid, info.st_gid)


def configure(data, config, source, policy=POLICY):
    # Validate all caller-provided input before writing any credential or live setting.
    credential = node_bytes(source)
    regular(policy)
    need(json.loads(policy.read_bytes()) == EXPECTED_POLICY, 'Required managed policy is invalid')
    private, managed = paths(data, config)
    service = data / 'config/service.env'
    original_service, original_config = service.read_bytes(), config.read_bytes()
    next_service = setting(setting(original_service, 'PROXY_MODERATION_CONFIG', NODE_PATH),
                           'PROXY_NATIVE_TERMINAL_REVIEW', '1')
    next_config = setting(original_config, 'MANAGED_CONFIG_DIR', str(managed))
    targets = [(managed / 'managed-settings.json', policy.read_bytes(), 0o644, (0, 0)),
               (managed / 'moderation-node.json', credential, 0o644, (0, 0)),
               (service, next_service, None, None), (config, next_config, None, None)]
    directory(private, 0o700)
    directory(managed, 0o755)
    originals = {}
    for path, content, mode, owner in targets:
        if path.exists():
            regular(path)
            mode_before, owner_before = metadata(path)
            originals[path] = (path.read_bytes(), mode_before, owner_before)
        else:
            need(not path.is_symlink(), 'Managed path must not be a symlink')
            originals[path] = None
    if all(originals[path] is not None and originals[path][0] == content and
           (owner is None or originals[path][2][0] == 0) and
           (mode is None or originals[path][1] == mode) for path, content, mode, owner in targets):
        check(data, config)
        return {'configured': True, 'changed': False}
    backup_root = private / 'backups'
    directory(backup_root, 0o700)
    backup = Path(tempfile.mkdtemp(prefix='configuration-', dir=backup_root))
    for index, (path, before) in enumerate(originals.items()):
        if before is not None:
            atomic(backup / (str(index) + '-' + path.name), before[0], 0o600, (0, 0))
    changed = []
    try:
        for path, content, mode, owner in targets:
            atomic(path, content, mode, owner)
            changed.append(path)
        check(data, config)
    except Exception:
        for path in reversed(changed):
            before = originals[path]
            if before is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, *before)
        raise
    return {'configured': True, 'changed': True, 'backupDirectory': str(backup)}


def protected(path):
    info = path.stat()
    need(info.st_uid == 0 and not info.st_mode & 0o022, 'Review files must be root owned and protected')


def check(data, config):
    private, managed = paths(data, config)
    for path in (private, managed, managed / 'managed-settings.json', managed / 'moderation-node.json'):
        for part in (path, *path.parents):
            need(not part.is_symlink(), 'Managed paths must not contain symlinks')
        protected(path)
    regular(managed / 'managed-settings.json')
    need(json.loads((managed / 'managed-settings.json').read_bytes()) == EXPECTED_POLICY,
         'Required managed policy is invalid')
    node_bytes(managed / 'moderation-node.json')
    service = (data / 'config/service.env').read_bytes()
    need(value(service, 'PROXY_MODERATION_CONFIG') == NODE_PATH and
         value(service, 'PROXY_NATIVE_TERMINAL_REVIEW') == '1' and
         value(config.read_bytes(), 'MANAGED_CONFIG_DIR') == str(managed),
         'Review configuration is incomplete; use moderation-config before starting')
    return {'configured': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    validate = sub.add_parser('validate-node')
    validate.add_argument('node_config', type=Path)
    for name in ('configure', 'check'):
        command = sub.add_parser(name)
        command.add_argument('--data', required=True, type=Path)
        command.add_argument('--deploy-config', required=True, type=Path)
        if name == 'configure':
            command.add_argument('--node-config', required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'validate-node':
            node_bytes(args.node_config)
            result = {'nodeConfigurationValid': True}
        else:
            need(os.name == 'posix' and os.geteuid() == 0, 'Use sudo for managed review configuration')
            os.umask(0o077)
            if args.command == 'check':
                print(json.dumps(check(args.data, args.deploy_config)))
                return
            # The data directory already exists; serialize explicit imports locally.
            paths(args.data, args.deploy_config)
            import fcntl
            private = args.data / '.managed'
            directory(private, 0o700)
            lock_path = private / 'configuration.lock'
            if lock_path.exists() or lock_path.is_symlink():
                regular(lock_path)
            descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = configure(args.data, args.deploy_config, args.node_config)
        print(json.dumps(result))
    except RuntimeError as error:
        # These messages are constants from this module, never credential JSON or parser input.
        raise SystemExit(str(error) + '; no model request sent.')
    except Exception:
        # Input may contain secrets. Do not print JSON, parser errors or raw exceptions.
        raise SystemExit('Review configuration failed. Check file paths, node JSON, root permissions and policy; no model request sent.')


if __name__ == '__main__':
    main()
