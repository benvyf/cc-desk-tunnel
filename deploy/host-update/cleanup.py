"""Reclaim only disposable host-update resources; called under upgrade.lock."""
import json
from pathlib import Path
import re
import shutil
import subprocess


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=300).stdout


def paths(value):
    if isinstance(value, str) and Path(value).is_absolute():
        yield Path(value)
    elif isinstance(value, dict):
        for item in value.values():
            yield from paths(item)
    elif isinstance(value, list):
        for item in value:
            yield from paths(item)


def referenced(target, protected):
    return any(target == path or target in path.parents or path in target.parents for path in protected)


def clean(root, program, keep_image):
    root, program = root.resolve(), program.resolve()
    before = shutil.disk_usage(root).free
    # Downloaded .deb files are cache only; never autoremove installed packages.
    if shutil.which('apt-get'):
        command(['apt-get', 'clean'])
        print('CLEANUP: apt download cache cleared; installed software retained.', flush=True)
    command(['docker', 'builder', 'prune', '--all', '--force'])

    ids = command(['docker', 'ps', '-aq']).split()
    containers = []
    for start in range(0, len(ids), 64):
        containers.extend(json.loads(command(['docker', 'inspect', *ids[start:start + 64]])))
    # Every container counts, including stopped rollback containers.
    protected_images = {container['Image'] for container in containers}
    protected_paths = {program}
    for container in containers:
        protected_paths.update(Path(mount['Source']) for mount in container.get('Mounts', []) if mount.get('Source'))
    for record in root.glob('backup-*/original.json'):
        if record.is_symlink():
            raise RuntimeError('Unexpected linked rollback configuration; cleanup stopped')
        value = json.loads(record.read_bytes())
        protected_images.add(value['Image'])
        protected_paths.update(paths(value))

    # Only remove verified CC runtime candidate tags. Never use image/system/volume
    # prune, --force, or delete images by age. Docker rechecks container references.
    rows = command(['docker', 'image', 'ls', '--no-trunc', '--format', '{{json .}}', 'cc-space-runtime'])
    candidates = set()
    for line in rows.splitlines():
        row = json.loads(line)
        tag = row['Repository'] + ':' + row['Tag']
        if re.fullmatch(r'cc-space-runtime:build\d+-[a-f0-9]{12}-[a-f0-9]{12}', tag) and tag != keep_image:
            candidates.add(tag)
    for tag in sorted(candidates):
        image = json.loads(command(['docker', 'image', 'inspect', tag]))[0]
        if image['Id'] in protected_images:
            continue
        tags = image.get('RepoTags') or []
        if any(value not in candidates for value in tags):
            continue
        for value in tags:
            command(['docker', 'image', 'rm', value])
            print('CLEANUP: removed unused CC candidate tag ' + value, flush=True)

    # Work folders also carry policies and diagnostic logs. Remove only program/,
    # and only if no live container or recorded rollback references this work tree.
    for work in root.iterdir():
        if not re.fullmatch(r'build\d+-[a-z0-9_]{8}', work.name) or work.is_symlink() or not work.is_dir():
            continue
        if referenced(work, protected_paths):
            continue
        target = work / 'program'
        if target.is_symlink() or not target.is_dir():
            continue
        if target.resolve().parent != work.resolve() or work.resolve().parent != root:
            raise RuntimeError('Unexpected build path; cleanup stopped')
        shutil.rmtree(target)
        print('CLEANUP: removed old unpacked program ' + str(target) + '; policy and logs retained.', flush=True)
    after = shutil.disk_usage(root).free
    print(f'CLEANUP: available_before={before}; available_after={after}; reclaimed={after-before} bytes; active services, data and rollback references retained.', flush=True)
