"""Rotate proven superseded CC rollback containers and unreferenced CC images.

Caller holds upgrade.lock. Account/project/history directories are never removed.
"""
import datetime
import json
from pathlib import Path
import re


CC_IMAGE = re.compile(
    r'(?:cc-space-(?:runtime(?:-base)?|message-(?:base|review)|preview|terminal(?:-base)?|reviewed-base)'
    r'|cc-(?:bootstrap-(?:snapshot|candidate|preflight)|monitor-(?:local-snapshot|offline-test|local-base)))'
    r':[A-Za-z0-9_.-]+|cc-desk-tunnel:(?:local|rollback-[0-9]{8}-[a-f0-9]{12}'
    r'|(?:managed-bootstrap|passive-monitor|native-paths|native-review|native-review-base|moderation|moderation-base|before-moderation|pilot)-[A-Za-z0-9_.-]+)')


def rotate(retirement, root, container_name, keep_image, base=Path('/var/lib'), apply=True):
    containers = retirement.inventory()
    current, keep = retirement.preserved_rollback(containers, root, container_name)
    original = json.loads((keep/'original.json').read_bytes())
    protected_ids = {current['Id'], original['Id']}
    live_data = next(m['Source'] for m in current['Mounts'] if m['Destination'] == '/data')
    protected_images = {current['Image'], original['Image']}
    retired_containers = {}
    # Only records explicitly retired by the verified backup retention workflow
    # can release a managed rollback container. Unrelated stopped containers stay.
    for root_name, pattern in retirement.LEGACY:
        directory = base/root_name
        if not directory.exists():
            continue
        retirement.physical(directory)
        for backup in directory.glob(pattern):
            retirement.physical(backup)
            if not backup.is_dir():
                continue
            source = backup/'original.json'
            if not source.exists():
                source = backup/'production.json'
            if not source.exists():
                retirement.need(not any((backup/name).exists() for name in retirement.PAYLOADS),
                                'Unmapped rollback payload reference; image retirement stopped: ' + str(backup))
                continue
            retirement.physical(source)
            saved = json.loads(source.read_bytes())
            if not isinstance(saved, dict) or 'Image' not in saved:
                raise RuntimeError('Unknown rollback image reference: ' + str(source))
            marker = backup/'RETIRED-BACKUP.json'
            retired = False
            if marker.exists() and backup != keep:
                retirement.physical(marker)
                # The marker precedes deletion; an interrupted retirement must
                # retain its container/image until every payload is gone.
                retired = not any((backup/name).exists() for name in retirement.PAYLOADS)
                json.loads(marker.read_bytes())
            if not retired:
                protected_images.add(saved['Image'])
                for metadata in backup.glob('*.json'):
                    retirement.physical(metadata)
                    def protect(value):
                        if isinstance(value, str):
                            if re.fullmatch(r'sha256:[a-f0-9]{64}', value) or CC_IMAGE.fullmatch(value):
                                protected_images.add(value)
                        elif isinstance(value, dict):
                            for child in value.values(): protect(child)
                        elif isinstance(value, list):
                            for child in value: protect(child)
                    protect(json.loads(metadata.read_bytes()))
                continue
            candidate = next((c for c in containers if c['Id'] == saved.get('Id')), None)
            if candidate is None or candidate['Id'] in protected_ids:
                continue
            name = candidate['Name'].lstrip('/')
            mounts = candidate.get('Mounts', [])
            data = [m for m in mounts if m['Destination'] == '/data']
            writable = [m for m in mounts if m.get('RW')]
            environment = dict(value.split('=', 1) for value in candidate.get('Config', {}).get('Env', []) if '=' in value)
            data_locations = all(environment.get(key, default).startswith('/data/')
                                 for key, default in [('HOME', ''), ('CLAUDE_CONFIG_DIR', '/data/home/.claude'), ('PROXY_DATA_DIR', '/data/state')])
            managed_name = name.startswith(container_name + '-before-') or name.startswith(container_name + '-managed-backup-') or name.startswith(container_name + '-monitor-backup-')
            if (managed_name and data_locations and candidate['Image'] == saved['Image']
                    and candidate['State']['Status'] == 'exited'
                    and len(data) == 1 and data[0]['Type'] == 'bind' and data[0]['Source'] == live_data
                    and all(m['Type'] == 'bind' and m['Source'] == live_data and m['Destination'] == '/data' for m in writable)):
                retired_containers[candidate['Id']] = candidate
    plan = {'containers': sorted(retired_containers), 'images': [], 'removedContainers': [], 'removedImages': []}
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    audit = root/('image-retirement-' + stamp + '.json')
    def save():
        if apply:
            audit.write_text(json.dumps(plan) + '\n')
            audit.chmod(0o600)
    save()
    if apply:
        for identifier in plan['containers']:
            latest = retirement.inventory()
            retirement.need(retirement.references(latest) == retirement.references(containers),
                            'Container references changed; image retirement stopped')
            retirement.docker('rm', identifier)  # No --force or --volumes.
            containers = [c for c in containers if c['Id'] != identifier]
            plan['removedContainers'].append(identifier)
            save()
    else:
        containers = [c for c in containers if c['Id'] not in retired_containers]
    protected_images.update(c['Image'] for c in containers)
    rows = retirement.docker('image', 'ls', '--no-trunc', '--format', '{{json .}}')
    tags = {row['Repository'] + ':' + row['Tag'] for line in rows.splitlines()
            for row in [json.loads(line)] if row['Repository'] != '<none>' and row['Tag'] != '<none>'}
    for tag in sorted(tags):
        if not CC_IMAGE.fullmatch(tag) or tag == keep_image:
            continue
        image = json.loads(retirement.docker('image', 'inspect', tag))[0]
        image_tags = image.get('RepoTags') or []
        if image['Id'] in protected_images or any(t in protected_images or t == keep_image or not CC_IMAGE.fullmatch(t) for t in image_tags):
            continue
        if any(t in plan['images'] for t in image_tags):
            continue
        plan['images'].extend(image_tags)
    save()
    if apply:
        for tag in plan['images']:
            latest = retirement.inventory()
            retirement.need(retirement.references(latest) == retirement.references(containers),
                            'Container references changed; image deletion stopped')
            retirement.docker('image', 'rm', tag)  # Docker also checks references.
            plan['removedImages'].append(tag)
            save()
    plan['state'] = 'completed' if apply else 'planned'
    save()
    print('IMAGE_RETENTION: ' + json.dumps(plan), flush=True)
    return plan
