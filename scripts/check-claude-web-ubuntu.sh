#!/usr/bin/env bash
# Read-only inventory. No browser requests, profile reads, configuration changes or container exec.
(
set -euo pipefail
echo 'CC_WEB_READONLY_PREFLIGHT_V1'
hostname
uname -m
free -m
df -h /
ss -lnt '( sport = :5900 or sport = :6080 or sport = :6090 or sport = :9222 )'
sudo -v
sudo python3 - <<'PY'
import json
import subprocess

def docker(*args):
    return subprocess.run(
        ['docker', *args], check=True, capture_output=True, text=True, timeout=20
    ).stdout

def summary(container):
    # Never print raw inspect data, environment values, host mount sources or browser arguments.
    env = dict(item.partition('=')[::2] for item in (container['Config'].get('Env') or []))
    return {
        'name': container['Name'].lstrip('/'),
        'image': container['Image'][:19],
        'status': container['State']['Status'],
        'health': container['State'].get('Health', {}).get('Status', 'not-configured'),
        'networks': sorted((container['NetworkSettings'].get('Networks') or {}).keys()),
        'port_bindings': container['HostConfig'].get('PortBindings') or {},
        'mount_targets': [mount['Destination'] for mount in container.get('Mounts', [])],
        'managed_policy_mount_readonly': any(
            mount['Destination'] == '/etc/claude-code' and mount.get('RW') is False
            for mount in container.get('Mounts', [])
        ),
        'moderation_env_declared': bool(env.get('PROXY_MODERATION_CONFIG')),
        'browser_endpoint_env_declared': bool(env.get('PROXY_BROWSER_ENDPOINT')),
    }

try:
    names = [name for name in docker('ps', '-a', '--format', '{{.Names}}').splitlines()
             if name in ('cc-claude-web', 'cc-claude-web-trial')
             or (name.startswith('cc-desk-tunnel') and '-proxy-' in name)]
    rows = [summary(json.loads(docker('container', 'inspect', name))[0]) for name in names]
    print(json.dumps({'containers': rows}, ensure_ascii=False, indent=2))
    running = [row['name'] for row in rows if row['status'] == 'running']
    if running:
        print(docker('stats', '--no-stream', '--format',
                     '{{.Name}} | {{.MemUsage}} | CPU={{.CPUPerc}}', *running).strip())
    if not rows:
        print('No matching CC/browser containers found; do not guess a deployment target.')
    print('Environment presence is not effective policy: managed bootstrap can force moderation.')
    print('Shared network names do not prove browser reachability. No connection probe was made.')
except (subprocess.SubprocessError, OSError, ValueError, KeyError):
    # Docker errors/inspect payloads can contain private configuration; do not echo them.
    raise SystemExit('Read-only Docker inventory failed; check Docker access and container names locally.')
PY
)
