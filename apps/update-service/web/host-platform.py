"""Root-owned, stable host-agent verifier and activation/recovery runtime.

Packages contain code only. Identity/configuration stays in the independent data
root. The stable core and entry script are installed by the installer, never by
an agent bundle, so rollback never imports candidate code.
"""
import base64
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

OPENSSL = 'openssl'
PROGRAM_ROOT = Path('/opt/cc-host-platform')
DATA_ROOT = Path('/var/lib/cc-host-updater')
MAX_ARCHIVE = 2 * 1024 * 1024
MAX_EXPANDED = 8 * 1024 * 1024
MAX_FILES = 128
PROOF_FIELDS = ('nodeId', 'version', 'sha256', 'instanceId', 'nonce')


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs)
    except (TypeError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('invalid JSON') from exc


def _b64(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('invalid base64url')
    try:
        result = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    except Exception as exc:
        raise ValueError('invalid base64url') from exc
    if base64.urlsafe_b64encode(result).decode().rstrip('=') != value:
        raise ValueError('noncanonical base64url')
    return result


def _positive(value):
    return type(value) is int and value > 0


def _record(record, maximum):
    if not isinstance(record, dict) or set(record) != {'sha256', 'size'}:
        raise ValueError('invalid digest record')
    if not isinstance(record['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', record['sha256']):
        raise ValueError('invalid sha256')
    if type(record['size']) is not int or not 0 <= record['size'] <= maximum:
        raise ValueError('invalid size')


def _code_path(name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.(?:py|cjs)', name):
        raise ValueError('invalid code path')
    forbidden = {'config', 'token', 'tokens', 'data', 'secret', 'secrets', 'credentials', 'identity'}
    if any(part.lower() in forbidden for part in name.rsplit('.', 1)[0].split('/')):
        raise ValueError('package may contain code only')


def _inventory(manifest, files=None):
    if not isinstance(manifest, dict) or set(manifest) != {'schema', 'product', 'platform', 'version', 'issuedAt', 'expiresAt', 'archive', 'files'}:
        raise ValueError('invalid manifest fields')
    if type(manifest['schema']) is not int or manifest['schema'] != 1 or manifest['product'] != 'cc-host-agent' or manifest['platform'] != 'linux-x64' or not _positive(manifest['version']):
        raise ValueError('unsupported manifest')
    _record(manifest['archive'], MAX_ARCHIVE)
    inventory = manifest['files']
    if not isinstance(inventory, dict) or not 1 <= len(inventory) <= MAX_FILES or 'worker.py' not in inventory:
        raise ValueError('invalid file inventory')
    total = 0
    case_names = set()
    for name, record in inventory.items():
        _code_path(name); _record(record, MAX_EXPANDED)
        if name.lower() in case_names:
            raise ValueError('ambiguous file names')
        case_names.add(name.lower()); total += record['size']
    if total > MAX_EXPANDED:
        raise ValueError('expanded size exceeded')
    if files is not None:
        if set(files) != set(inventory):
            raise ValueError('file inventory mismatch')
        for name, data in files.items():
            if not isinstance(data, bytes) or len(data) != inventory[name]['size'] or _digest(data) != inventory[name]['sha256']:
                raise ValueError('file digest or size mismatch')


def _date(value):
    if not isinstance(value, str):
        raise ValueError('invalid timestamp')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError('timezone required')
        return result
    except (ValueError, OverflowError) as exc:
        raise ValueError('invalid timestamp') from exc


def _check_floor(manifest, floor):
    if floor is None:
        return
    version, sha = manifest['version'], manifest['archive']['sha256']
    if not isinstance(floor, dict) or not _positive(floor.get('version')) or not re.fullmatch('[0-9a-f]{64}', str(floor.get('sha256', ''))):
        raise ValueError('invalid version floor')
    if version < floor['version'] or (version == floor['version'] and sha != floor['sha256']):
        raise ValueError('version rollback or conflicting version')


def verify_signed_payload(envelope, keys):
    """Authenticate bounded envelope bytes; product policy stays with each caller."""
    if not isinstance(envelope, dict) or set(envelope) != {'payload', 'keyId', 'signature'}:
        raise ValueError('invalid signed envelope')
    if not isinstance(envelope['keyId'], str) or envelope['keyId'] not in keys:
        raise ValueError('unknown signing key')
    if not isinstance(envelope['payload'], str) or len(envelope['payload']) > 128 * 1024:
        raise ValueError('manifest size exceeded')
    raw, signature = _b64(envelope['payload']), _b64(envelope['signature'])
    if len(signature) != 64:
        raise ValueError('invalid Ed25519 signature')
    key = keys[envelope['keyId']]
    pem = re.fullmatch(r'\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*', key) if isinstance(key, str) else None
    try:
        der = base64.b64decode(re.sub(r'\s', '', pem[1]), validate=True) if pem else b''
    except ValueError as exc:
        raise ValueError('invalid public key') from exc
    # RFC 8410 SubjectPublicKeyInfo: id-Ed25519 OID, absent parameters,
    # and exactly 32 public-key bytes. Do not silently accept RSA/ECDSA keys.
    if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100'):
        raise ValueError('configured key must be Ed25519 PUBLIC KEY PEM')
    # OpenSSL pkeyutl requires real input files for Ed25519 one-shot verification.
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / 'key.pem').write_text(key, encoding='ascii')
        (root / 'payload').write_bytes(raw); (root / 'signature').write_bytes(signature)
        try:
            verified = subprocess.run([OPENSSL, 'pkeyutl', '-verify', '-pubin', '-inkey', str(root / 'key.pem'), '-rawin', '-in', str(root / 'payload'), '-sigfile', str(root / 'signature')], capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError('signature verifier unavailable') from exc
        if verified.returncode:
            raise ValueError('signature verification failed')
    return raw


def verify_bundle(envelope, archive, keys, floor, now=None):
    """Verify canonical signed manifest and bounded tar.gz inventory in memory."""
    if not isinstance(archive, bytes) or len(archive) > MAX_ARCHIVE:
        raise ValueError("archive size exceeded")
    raw = verify_signed_payload(envelope, keys)
    manifest = _json(raw)
    if _canonical(manifest) != raw:
        raise ValueError("manifest must be canonical JSON")
    _inventory(manifest)
    issued, expires = _date(manifest['issuedAt']), _date(manifest['expiresAt'])
    now = now or datetime.now(timezone.utc)
    if not issued <= now < expires or expires - issued > timedelta(days=31):
        raise ValueError('manifest expired or invalid lifetime')
    if manifest['archive'] != {'sha256': _digest(archive), 'size': len(archive)}:
        raise ValueError('archive digest or size mismatch')
    _check_floor(manifest, floor)
    files = {}
    try:
        # Bound the entire decompressed stream, including GNU/PAX metadata, before
        # tarfile can allocate memory based on an attacker-controlled header.
        limit = MAX_EXPANDED + MAX_FILES * 1024 + 10240
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as compressed:
            expanded = compressed.read(limit + 1)
        if len(expanded) > limit:
            raise ValueError('expanded archive size exceeded')
        with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as tar:
            for entry in tar:
                if not entry.isreg() or entry.name not in manifest['files'] or entry.name in files or entry.pax_headers:
                    raise ValueError('unexpected archive entry')
                expected = manifest['files'][entry.name]
                if entry.size != expected['size'] or len(files) >= MAX_FILES:
                    raise ValueError('archive entry size exceeded')
                files[entry.name] = tar.extractfile(entry).read(expected['size'] + 1)
            if any(expanded[tar.offset:]):
                raise ValueError('unexpected trailing archive data')
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise ValueError('invalid archive') from exc
    _inventory(manifest, files)
    return manifest, files


def _protect(path, directory=False):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('symlink in protected path')
    if os.name == 'posix':
        info = path.stat()
        if info.st_uid != 0:
            raise ValueError('platform files must be root-owned')
        if info.st_mode & 0o022:
            raise ValueError('platform files must not be writable by group or others')
    if directory and not path.is_dir():
        raise ValueError('expected directory')


def _directory(path):
    path = Path(path)
    # Check existing ancestors before creating any directories through them.
    for parent in reversed([path] + list(path.parents)):
        if parent.exists() or parent.is_symlink():
            # A root-owned sticky temporary ancestor is safe: other users cannot
            # replace our private child. The protected root itself is never sticky.
            info = parent.lstat()
            if not (parent != path and os.name == 'posix' and info.st_uid == 0 and info.st_mode & stat.S_ISVTX and stat.S_ISDIR(info.st_mode)):
                _protect(parent, True)
    for parent in reversed([path] + list(path.parents)):
        if not parent.exists():
            parent.mkdir(mode=0o700)
            _sync_dir(parent.parent)
    if os.name == 'posix':
        os.chmod(path, 0o700)
    _protect(path, True)
    return path


def _sync_dir(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def _write(path, data):
    """Atomic private write, durable before the caller mutates service state."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path); _sync_dir(path.parent)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def _state_path(data_root):
    return Path(data_root) / 'agent-platform' / 'state.json'


def _state(data_root):
    path = _state_path(data_root)
    if not path.exists():
        return {'phase': 'steady', 'current': None, 'previous': None, 'candidate': None, 'floor': None}
    _protect(path)
    return _json(path.read_bytes())


def _save(data_root, state):
    _write(_state_path(data_root), _canonical(state))


@contextmanager
def _file_lock(path):
    path = Path(path)
    _protect(path.parent, True)
    if path.exists(): _protect(path)
    with open(path, 'a+b') as stream:
        if os.name == 'posix':
            import fcntl
            os.chmod(path, 0o600); fcntl.flock(stream, fcntl.LOCK_EX)
        else:
            import msvcrt
            if not path.stat().st_size: stream.write(b'0'); stream.flush()
            stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        try: yield
        finally:
            if os.name == 'posix': fcntl.flock(stream, fcntl.LOCK_UN)
            else:
                stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


@contextmanager
def _locked(program_root, data_root):
    _directory(program_root); _directory(Path(data_root) / 'agent-platform')
    with _file_lock(Path(data_root) / 'agent-platform' / 'lock'):
        yield


@contextmanager
def _operation_locked(data_root):
    """Shared gate for worker, relay, and manual host mutations.

    All host mutators must hold this same fixed root-owned file exclusively.
    It is separate from native upgrade.lock, which a child installer may need.
    Acquire this before the platform state lock; launch never acquires either.
    A worker must release this gate before requesting independent maintenance.
    """
    with _file_lock(Path(data_root) / 'operation.lock'):
        yield


def _version_files(program_root, candidate):
    sha = candidate.get('sha256')
    if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{64}', sha):
        raise ValueError('invalid candidate digest')
    root = Path(program_root) / 'versions' / sha
    _protect(root, True)
    manifest_path = root / 'manifest.json'; _protect(manifest_path)
    manifest = _json(manifest_path.read_bytes())
    # Publication versions can reuse identical archive bytes. This immutable
    # manifest describes artifact inventory; the protected state binds version.
    if manifest['archive']['sha256'] != sha or not _positive(candidate.get('version')):
        raise ValueError('candidate descriptor mismatch')
    files = {}
    for name in manifest['files']:
        _code_path(name)
        path = root / name
        for parent in path.parents:
            if parent == root: break
            _protect(parent, True)
        _protect(path)
        files[name] = path.read_bytes()
    _inventory(manifest, files)
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if not p.is_dir()}
    if actual != set(files) | {'manifest.json'}:
        raise ValueError('version directory inventory mismatch')
    return root, manifest


def stage_bundle(program_root, data_root, manifest, files):
    """Write an immutable verified version before any running process is stopped."""
    _inventory(manifest, files)
    with _locked(program_root, data_root):
        state = _state(data_root); _check_floor(manifest, state['floor'])
        if state['phase'] not in ('steady', 'staged'):
            raise ValueError('activation requires recovery')
        sha, version = manifest['archive']['sha256'], manifest['version']
        for existing in (state['current'], state['candidate']):
            if existing and existing['sha256'] == sha and existing['version'] == version:
                _version_files(program_root, existing)
                if existing == state['current'] and state['phase'] == 'staged':
                    state.update(candidate=None, phase='steady')
                    _save(data_root, state)
                return existing
        versions = _directory(Path(program_root) / 'versions')
        root = versions / sha
        candidate = {'sha256': sha, 'version': version,
            'nodeId': _json((Path(data_root) / 'config.json').read_bytes())['nodeId'],
            'instanceId': str(uuid.uuid4()), 'nonce': secrets.token_hex(32)}
        if not isinstance(candidate['nodeId'], str) or not candidate['nodeId']:
            raise ValueError('missing node identity')
        if root.exists() or root.is_symlink():
            _, installed = _version_files(program_root, candidate)
            if installed['files'] != manifest['files']:
                raise ValueError('existing artifact inventory mismatch')
        else:
            temporary = Path(tempfile.mkdtemp(prefix='.stage-', dir=versions))
            try:
                for name, data in files.items():
                    target = temporary / name; _directory(target.parent); _write(target, data)
                _write(temporary / 'manifest.json', _canonical(manifest))
                _sync_dir(temporary); os.replace(temporary, root); _sync_dir(versions)
            finally:
                if temporary.exists(): shutil.rmtree(temporary)
        state.update(candidate=candidate, phase='staged')
        _save(data_root, state)
        return candidate


def _matches(proof, candidate):
    return isinstance(proof, dict) and all(type(proof.get(key)) is type(candidate[key]) and proof[key] == candidate[key] for key in PROOF_FIELDS)


def _rollback(data_root, state, stop, start):
    state['phase'] = 'rollback'; _save(data_root, state)
    stop()
    state['current'] = state['previous']; _save(data_root, state)
    if state['current']: start()
    state.update(phase='steady', candidate=None, previous=None); _save(data_root, state)
    return state


def activate(program_root, data_root, candidate, stop, start, healthy):
    """Activate under maintenance supervision; callbacks never run in worker cgroup."""
    with _operation_locked(data_root), _locked(program_root, data_root):
        state = _state(data_root)
        if state['phase'] == 'steady' and state['current'] == candidate:
            return state
        if state['phase'] != 'staged' or state['candidate'] != candidate:
            raise ValueError('candidate is not staged')
        _version_files(program_root, candidate)
        _check_floor({'version': candidate['version'], 'archive': {'sha256': candidate['sha256']}}, state['floor'])
        state.update(previous=state['current'], phase='stopping'); _save(data_root, state)
        try:
            stop()
            state['phase'] = 'switching'; _save(data_root, state)
            state.update(current=candidate, phase='starting'); _save(data_root, state)
            start()
            if not _matches(healthy(candidate), candidate):
                raise ValueError('candidate health proof mismatch')
            committed = dict(state, phase='steady', previous=None, candidate=None,
                floor={'version': candidate['version'], 'sha256': candidate['sha256']})
            _save(data_root, committed)
            return committed
        except Exception:
            _rollback(data_root, state, stop, start)
            raise


def recover(program_root, data_root, stop, start):
    """Boot-time interrupted transactions always restore their pre-update version."""
    with _operation_locked(data_root), _locked(program_root, data_root):
        state = _state(data_root)
        if state['phase'] in ('steady', 'staged'):
            return state
        if state['previous']: _version_files(program_root, state['previous'])
        return _rollback(data_root, state, stop, start)


def launch_plan(program_root, data_root):
    """Return only the verified current worker and its bound health environment.

    Do not acquire the maintenance lock: systemctl start synchronously launches
    this process while activation owns that lock.
    """
    state = _state(data_root)
    if not state['current']:
        raise ValueError('no installed current agent')
    candidate = state['current']
    root, _ = _version_files(program_root, candidate)
    env = dict(os.environ)
    env.update(CC_HOST_PLATFORM_NONCE=candidate['nonce'],
        CC_HOST_AGENT_SHA256=candidate['sha256'],
        CC_HOST_AGENT_VERSION=str(candidate['version']),
        CC_HOST_AGENT_INSTANCE_ID=candidate['instanceId'],
        PYTHONDONTWRITEBYTECODE='1')
    # These variables could redirect imports into mutable host configuration.
    env.pop('PYTHONPATH', None); env.pop('PYTHONHOME', None)
    return root / 'worker.py', env


def wait_healthy(data_root, candidate, timeout=120, interval=1):
    """Wait for two distinct accepted heartbeat timestamps for this activation."""
    deadline = time.monotonic() + timeout
    seen = set()
    path = Path(data_root) / 'agent-health.json'
    while time.monotonic() < deadline:
        try:
            _protect(path)
            if path.stat().st_size > 4096:
                raise ValueError('health proof too large')
            proof = _json(path.read_bytes())
            if _matches(proof, candidate) and isinstance(proof.get('at'), str) and proof['at']:
                seen.add(proof['at'])
                if len(seen) >= 2:
                    return proof
        except (FileNotFoundError, ValueError):
            pass
        time.sleep(interval)
    raise ValueError('candidate health timeout')


def _service(action):
    subprocess.run(['systemctl', action, 'cc-host-updater.service'], check=True, timeout=45)


def main(argv=None):
    """Fixed service primitives; no configurable path, shell, or endpoint flags.

    maintain reads a local request from agent-platform/request/{envelope.json,
    archive.tar.gz}; trusted-keys.json belongs to the stable program root.
    recover is a BOOT-ONLY pointer recovery, before any worker starts; it avoids
    systemctl calls to a service ordered after the recovery unit. maintain uses
    full stop/start recovery for an already running host. The maintenance unit
    is independent from cc-host-updater.service and must never PartOf it.
    """
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or argv[0] not in ('launch', 'maintain', 'recover'):
        raise ValueError('expected launch, maintain, or recover')
    if os.name != 'posix' or os.geteuid() != 0:
        raise ValueError('host platform runtime requires Linux root')
    stop, start = lambda: _service('stop'), lambda: _service('start')
    if argv[0] == 'launch':
        worker, env = launch_plan(PROGRAM_ROOT, DATA_ROOT)
        os.execve(sys.executable, [sys.executable, '-B', str(worker)], env)
    elif argv[0] == 'recover':
        recover(PROGRAM_ROOT, DATA_ROOT, lambda: None, lambda: None)
    else:
        recover(PROGRAM_ROOT, DATA_ROOT, stop, start)
        request = DATA_ROOT / 'agent-platform' / 'request'
        _protect(request, True)
        envelope_path, archive_path = request / 'envelope.json', request / 'archive.tar.gz'
        key_path = PROGRAM_ROOT / 'trusted-keys.json'
        for path, limit in [(envelope_path, 128 * 1024), (archive_path, MAX_ARCHIVE), (key_path, 64 * 1024)]:
            _protect(path)
            if not path.is_file() or path.stat().st_size > limit:
                raise ValueError('invalid update input')
        manifest, files = verify_bundle(_json(envelope_path.read_bytes()), archive_path.read_bytes(),
            _json(key_path.read_bytes()), _state(DATA_ROOT)['floor'])
        candidate = stage_bundle(PROGRAM_ROOT, DATA_ROOT, manifest, files)
        activate(PROGRAM_ROOT, DATA_ROOT, candidate, stop, start,
            lambda current: wait_healthy(DATA_ROOT, current))


if __name__ == '__main__':
    main()
