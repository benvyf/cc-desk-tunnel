#!/usr/bin/env python3
"""Stable root-owned entry. Install with ExecStart=/usr/bin/python3 -I ...

The recovery core lives outside all signed candidate versions. A broken worker
or helper import therefore cannot disable boot recovery or maintenance rollback.
"""
import importlib.util
import os
from pathlib import Path
import stat
import sys

CORE = Path('/opt/cc-host-platform/host-platform.py')


def load_core():
    if os.name != 'posix' or os.geteuid() != 0:
        raise ValueError('host platform entry requires Linux root')
    for path in [CORE, *CORE.parents]:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unprotected stable platform core')
    spec = importlib.util.spec_from_file_location('cc_host_platform', CORE)
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    return core


def main(argv=None):
    load_core().main(sys.argv[1:] if argv is None else argv)


if __name__ == '__main__':
    main()
