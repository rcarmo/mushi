#!/usr/bin/env python3
"""Check that an APK contains the exact selected bootstrap, not a stale .incbin."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import zipfile

ABIS = {'arm64-v8a': 'aarch64', 'armeabi-v7a': 'arm', 'x86': 'i686', 'x86_64': 'x86_64'}


def embedded_bootstrap(library):
    end = library.rfind(b'PK\x05\x06')
    if end < 0 or end + 22 > len(library):
        raise ValueError('Missing embedded bootstrap ZIP')
    fields = struct.unpack_from('<4s4H2LH', library, end)
    directory_size, directory_offset, comment_length = fields[5:8]
    start = end - directory_size - directory_offset
    finish = end + 22 + comment_length
    if start < 0 or finish > len(library):
        raise ValueError('Invalid embedded bootstrap ZIP boundaries')
    return library[start:finish]


def verify(apk, bootstraps):
    manifest = json.loads((bootstraps / 'manifest.json').read_text())
    results = []
    with zipfile.ZipFile(apk) as package:
        for abi, arch in ABIS.items():
            name = f'lib/{abi}/libtermux-bootstrap.so'
            if name not in package.namelist():
                continue
            payload = embedded_bootstrap(package.read(name))
            digest = hashlib.sha256(payload).hexdigest()
            expected = manifest['sha256'].get(arch)
            if digest != expected:
                raise ValueError(f'APK has a stale or unexpected {arch} bootstrap')
            with zipfile.ZipFile(io.BytesIO(payload)) as runtime:
                metadata = json.loads(runtime.read('etc/mushi/native.json'))
                if metadata.get('applicationId') != 'io.carmo.mushi' or metadata.get('architecture') != arch:
                    raise ValueError('Embedded runtime identity mismatch')
                if metadata.get('runtimeExecutable') != 'bun' or 'bin/bun' not in runtime.namelist() or 'bin/node' in runtime.namelist():
                    raise ValueError('APK must contain Bun and no Node fallback')
                if any(path.startswith('opt/aosp/') for path in runtime.namelist()):
                    raise ValueError('Test-only host Bionic libraries must not ship on Android')
                results.append({'architecture': arch, 'bootstrapSha256': digest, 'runtimeKind': metadata.get('runtimeKind', 'source-built')})
    if not results:
        raise ValueError('APK has no Mushi native bootstrap')
    return {'apk': str(apk), 'applicationId': 'io.carmo.mushi', 'runtimes': results, 'androidDeviceVerified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--bootstraps', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.apk, args.bootstraps), indent=2))
