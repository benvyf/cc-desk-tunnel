# Copy this entire block into the FIRST Ubuntu console.
# Preparation only: no restart, deployment, network access or model calls.
# Creates a temporary transfer key; only its PUBLIC key is printed.
sudo python3 - <<'CC_MONITOR_PREPARE_PY'
import hashlib, json, os, shutil, socket, stat, subprocess
from pathlib import Path

if socket.gethostname().split('.')[0] != 'ubuntu-cc':
    raise SystemExit('STOP: run only on ubuntu-cc')

container = 'cc-desk-tunnel-ba938975-proxy-1'
expected_image = 'sha256:75e9c5895bfa232d78905bf1dbf127af173d9f5de88086dc93af80833c8a3b8f'

def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise SystemExit('STOP: preparation command failed; private output withheld')
    return result.stdout

info = json.loads(run(['docker', 'inspect', container]))[0]
if info['Image'] != expected_image or not info['State']['Running']:
    raise SystemExit('STOP: runtime changed; collect baseline again')
if not any(m.get('Type') == 'bind' and m.get('Source') == '/srv/cc-desk-tunnel'
           and m.get('Destination') == '/data' for m in info.get('Mounts', [])):
    raise SystemExit('STOP: unexpected data mount')

directory = Path('/var/lib/cc-monitor-pilot')
if directory.is_symlink():
    raise SystemExit('STOP: unexpected preparation path')
directory.mkdir(mode=0o700, exist_ok=True)
if directory.stat().st_uid != 0:
    raise SystemExit('STOP: preparation directory must be root owned')
directory.chmod(0o700)
recipe = directory / 'container-before.json'
if recipe.is_symlink():
    raise SystemExit('STOP: unexpected recipe path')
if recipe.exists():
    previous = json.loads(recipe.read_text())
    if previous.get('Id') != info['Id'] or previous.get('Image') != expected_image:
        raise SystemExit('STOP: previous preparation belongs to another runtime')
else:
    with os.fdopen(os.open(recipe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        json.dump(info, f)

key = directory / 'transfer-key'
if key.is_symlink() or Path(str(key) + '.pub').is_symlink():
    raise SystemExit('STOP: unexpected transfer key path')
if not key.exists():
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C',
         'ubuntu-cc-monitor-transfer', '-f', str(key)])
if key.stat().st_uid != 0 or stat.S_IMODE(key.stat().st_mode) != 0o600:
    raise SystemExit('STOP: unexpected transfer key permissions')
public_key = run(['ssh-keygen', '-y', '-f', str(key)]).strip()
if not public_key.startswith('ssh-ed25519 '):
    raise SystemExit('STOP: unexpected transfer public key')

process_reader = r'''
import json
from pathlib import Path
count = 0
for p in Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        args = (p/'cmdline').read_bytes().split(bytes([0]))
        command = (p/'comm').read_text().strip().lower()
        if 'claude' in command or any(Path(a.decode('utf-8', 'replace')).name in ['claude', 'cli.js'] for a in args if a):
            count += 1
    except (OSError, ValueError): pass
print(json.dumps({'active_cli_processes': count}))
'''
activity = json.loads(run(['docker', 'exec', '-i', container, 'python3', '-'], process_reader))
labels = info['Config'].get('Labels') or {}
networks = info.get('NetworkSettings', {}).get('Networks', {})
print(json.dumps({
    'kind': 'cc-monitor-pilot-prepared', 'node': 'ubuntu-cc',
    'container_id': info['Id'], 'image_id': expected_image,
    'public_key': public_key, 'active_cli_processes': activity['active_cli_processes'],
    'network_mode': info['HostConfig'].get('NetworkMode'),
    'networks': sorted(networks),
    'static_network_config': any(n.get('IPAMConfig') for n in networks.values()),
    'mounts': [{'type': m['Type'], 'destination': m['Destination'], 'read_only': not m['RW']}
               for m in info.get('Mounts', [])],
    'compose': {name: labels.get('com.docker.compose.' + name)
                for name in ['project', 'service', 'project.config_files', 'project.working_dir']},
    'free_disk_bytes': shutil.disk_usage('/var/lib').free,
    'production_changed': False
}, indent=2))
CC_MONITOR_PREPARE_PY
