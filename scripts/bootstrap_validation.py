"""Structural checks for source-built or explicitly relocated prebuilt runtimes."""
import json
from pathlib import PurePosixPath
import zipfile

APP_ID = 'io.carmo.mushi'
PREFIX = f'/data/data/{APP_ID}/files/usr'
ARCHES = ('aarch64', 'arm', 'i686', 'x86_64')
ELF = {'aarch64': (2, 183), 'arm': (1, 40), 'i686': (1, 3), 'x86_64': (2, 62)}
RUNTIME_PACKAGES = ('bun', 'git', 'ca-certificates')


def validate_archive(archive, arch):
    with zipfile.ZipFile(archive) as contents:
        names = contents.namelist()
        if len(names) != len(set(names)):
            raise ValueError(f'{archive.name}: duplicate archive entries')
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError(f'{archive.name}: unsafe archive path {name}')
        required = ('bin/bash', 'bin/bun', 'bin/git', 'bin/flock', 'etc/mushi/native.json')
        for name in required:
            if name not in names:
                raise ValueError(f'{archive.name} is missing {name}')
        for name in required[:4]:
            data = contents.read(name)
            elf_class, machine = ELF[arch]
            if len(data) < 20 or data[:4] != b'\x7fELF' or data[4] != elf_class or data[5] != 1 or int.from_bytes(data[18:20], 'little') != machine:
                raise ValueError(f'{archive.name}:{name} is not an Android-target {arch} ELF')
        metadata = json.loads(contents.read('etc/mushi/native.json'))
        if metadata.get('applicationId') != APP_ID or metadata.get('prefix') != PREFIX or metadata.get('architecture') != arch:
            raise ValueError(f'{archive.name}: runtime metadata identity mismatch')
        if set(metadata.get('runtimePackages', [])) != set(RUNTIME_PACKAGES):
            raise ValueError(f'{archive.name}: incomplete bundled runtime')
        if metadata.get('runtimeExecutable') != 'bun' or 'bin/node' in names:
            raise ValueError(f'{archive.name}: Mushi ships Bun, not a Node runtime/fallback')
        prebuilt = metadata.get('runtimeKind') == 'termux-prebuilt-relocated'
        if prebuilt:
            import hashlib
            for name in ('etc/mushi/environment.sh', 'etc/mushi/relocation.json', 'lib/libmushi-exec.so'):
                if name not in names:
                    raise ValueError(f'{archive.name}: missing prebuilt relocation component {name}')
            report = json.loads(contents.read('etc/mushi/relocation.json'))
            shim = contents.read('lib/libmushi-exec.so')
            if hashlib.sha256(shim).hexdigest() != report['execBridge']['sha256']:
                raise ValueError(f'{archive.name}: exec bridge checksum mismatch')
            elf_class, machine = ELF[arch]
            if len(shim) < 20 or shim[:4] != b'\x7fELF' or shim[4] != elf_class or int.from_bytes(shim[18:20], 'little') != machine:
                raise ValueError(f'{archive.name}: incompatible exec bridge')
        if 'etc/apt/sources.list' not in names:
            raise ValueError(f'{archive.name}: missing offline APT configuration')
        for entry in contents.infolist():
            name = entry.filename
            if name.startswith(('bin/', 'lib/', 'libexec/', 'etc/')) or name == 'SYMLINKS.txt':
                data = contents.read(entry)
                # Relocated prebuilts can retain compiled defaults: the narrow
                # bridge and explicit environment handle the tested subset.
                # Do not pretend every residual binary string is relocatable.
                binary = data.startswith(b'\x7fELF') or b'\0' in data
                audit_metadata = name in ('etc/mushi/native.json', 'etc/mushi/relocation.json')
                if b'/data/data/com.termux/' in data and (not prebuilt or (not binary and not audit_metadata)):
                    raise ValueError(f'{archive.name}:{name} still references the stock Termux prefix')
            if name == 'etc/apt/sources.list' or (name.startswith('etc/apt/sources.list.d/') and name.endswith(('.list', '.sources'))):
                active = [line.strip() for line in contents.read(entry).decode().splitlines() if line.strip() and not line.lstrip().startswith('#')]
                if active:
                    raise ValueError(f'{archive.name}:{name} has active package repositories; Mushi ships an offline native snapshot')
        return metadata
