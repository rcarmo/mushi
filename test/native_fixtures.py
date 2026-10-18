"""Synthetic ELF/DEB inputs for packaging tests. Never ship these as a runtime."""
import hashlib
import json
from pathlib import Path
import zipfile

PREFIX = '/data/data/io.carmo.mushi/files/usr'
MACHINES = {'aarch64': (2, 183), 'arm': (1, 40), 'i686': (1, 3), 'x86_64': (2, 62)}


def elf(arch):
    data = bytearray(64)
    data[:4] = b'\x7fELF'
    data[4], machine = MACHINES[arch]
    data[5] = 1
    data[18:20] = machine.to_bytes(2, 'little')
    return bytes(data) + b'SYNTHETIC TEST FIXTURE ' + PREFIX.encode()


def bootstrap(directory: Path, arch='aarch64'):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'bootstrap-{arch}.zip'
    with zipfile.ZipFile(path, 'w') as z:
        for binary in ['bash', 'bun', 'git', 'flock']:
            z.writestr(f'bin/{binary}', elf(arch))
        z.writestr('bin/pkg', b'#!/bin/sh\necho original pkg\n')
        z.writestr('etc/apt/sources.list', '# offline\n')
        z.writestr('etc/mushi/native.json', json.dumps({'applicationId': 'io.carmo.mushi', 'prefix': PREFIX, 'architecture': arch, 'runtimeExecutable': 'bun', 'runtimePackages': ['bun', 'git', 'ca-certificates']}))
    return path


def manifest(directory: Path, arches=('aarch64',)):
    (directory / 'manifest.json').write_text(json.dumps({'applicationId': 'io.carmo.mushi', 'prefix': PREFIX,
        'sha256': {arch: hashlib.sha256((directory / f'bootstrap-{arch}.zip').read_bytes()).hexdigest() for arch in arches}}))
