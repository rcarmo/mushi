#!/usr/bin/env python3
"""Stage validated Mushi bootstraps; never silently substitute a runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import zipfile
from bootstrap_validation import APP_ID, PREFIX, ARCHES, validate_archive


def stage(source: Path, destination: Path, architectures=('aarch64',)):
    manifest = json.loads((source / 'manifest.json').read_text())
    if manifest.get('applicationId') != APP_ID or manifest.get('prefix') != PREFIX:
        raise ValueError(f'Bootstraps must be rebuilt for {APP_ID} ({PREFIX})')
    if not architectures or any(arch not in ARCHES for arch in architectures):
        raise ValueError('Unsupported or empty MUSHI_ARCHITECTURES')
    # Validate the complete selected set before overwriting any archive.
    for arch in architectures:
        archive = source / f'bootstrap-{arch}.zip'
        expected = manifest.get('sha256', {}).get(arch)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if not isinstance(expected, str) or expected != actual:
            raise ValueError(f'Checksum mismatch for {archive.name}')
        validate_archive(archive, arch)
    destination.mkdir(parents=True, exist_ok=True)
    for arch in architectures:
        name = f'bootstrap-{arch}.zip'
        shutil.copyfile(source / name, destination / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    source = os.environ.get('MUSHI_BOOTSTRAP_DIR')
    if not source:
        raise ValueError('Set MUSHI_BOOTSTRAP_DIR or run bun run runtime:build to assemble the Bun runtime.')
    stage(Path(source).resolve(), args.destination.resolve(), tuple(os.environ.get('MUSHI_ARCHITECTURES', 'aarch64').split(',')))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        sys.exit(f'Mushi bootstrap error: {error}')
