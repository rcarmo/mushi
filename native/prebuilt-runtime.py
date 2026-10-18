#!/usr/bin/env python3
"""Fetch a signed, frozen Termux package closure. Never execute target packages."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = 'https://packages.termux.dev/apt/termux-main/'
ROOTS = ['bun', 'bash', 'git', 'ca-certificates', 'coreutils', 'findutils', 'grep', 'sed', 'diffutils', 'util-linux', 'termux-licenses']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    if not url.startswith(REPOSITORY):
        raise ValueError('Unexpected repository URL')
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()


def parse_packages(text):
    packages = {}
    for paragraph in text.strip().split('\n\n'):
        entry, key = {}, None
        for line in paragraph.splitlines():
            if line.startswith(' ') and key:
                entry[key] += '\n' + line
            elif ': ' in line:
                key, value = line.split(': ', 1)
                entry[key] = value
        if 'Package' in entry:
            packages[entry['Package']] = entry
    return packages


def version_matches(actual, operator, requested):
    return subprocess.run(['dpkg', '--compare-versions', actual, operator, requested]).returncode == 0


def closure(packages, roots):
    selected, todo = {}, [(root, None, None) for root in roots]
    while todo:
        name, operator, version = todo.pop()
        entry = packages.get(name)
        if entry is None:
            raise ValueError(f'Missing package: {name}')
        if operator and not version_matches(entry['Version'], operator, version):
            raise ValueError(f'Unsatisfied dependency {name} ({operator} {version})')
        if name in selected:
            continue
        selected[name] = entry
        for group in (entry.get('Pre-Depends', '') + ',' + entry.get('Depends', '')).split(','):
            if not group.strip():
                continue
            for alternative in group.split('|'):
                match = re.fullmatch(r'\s*([a-z0-9+.-]+)(?::(?:any|native))?(?:\s*\((<<|<=|=|>=|>>)\s*([^ )]+)\))?\s*', alternative)
                if not match:
                    raise ValueError(f'Unsupported dependency syntax: {alternative}')
                dep, op, ver = match.groups()
                candidate = packages.get(dep)
                if candidate and (not op or version_matches(candidate['Version'], op, ver)):
                    todo.append((dep, op, ver))
                    break
            else:
                raise ValueError(f'No satisfiable dependency alternative: {name}: {group}')
    return selected


def make_lock(architecture, destination):
    if architecture not in ('aarch64', 'arm', 'i686', 'x86_64'):
        raise ValueError('Unsupported architecture')
    release = fetch(REPOSITORY + 'dists/stable/InRelease')
    evidence = ROOT / f'build/prebuilt/{architecture}/metadata'
    evidence.mkdir(parents=True, exist_ok=True)
    release_file = evidence / 'InRelease'
    release_file.write_bytes(release)
    keys = ROOT / 'vendor/termux-packages/packages/termux-keyring'
    command = ['gpg', '--batch', '--no-default-keyring', '--status-fd', '1']
    for name in ['grimler.gpg', 'termux-autobuilds.gpg']:
        command += ['--keyring', str(keys / name)]
    verified = subprocess.run(command + ['--verify', str(release_file)], text=True, capture_output=True, check=True)
    signatures = re.findall(r'\[GNUPG:\] VALIDSIG ([A-F0-9]+)', verified.stdout)
    if not signatures:
        raise ValueError('Repository metadata has no valid pinned-key signature')
    # Only the SHA256 section of the authenticated Release is authoritative.
    text = release.decode().split('SHA256:\n', 1)[1].split('\nSHA512:', 1)[0]
    relative = f'main/binary-{architecture}/Packages.gz'
    match = re.search(r'^ ([a-f0-9]{64})\s+(\d+)\s+' + re.escape(relative) + r'$', text, re.M)
    if not match:
        raise ValueError('Signed package-index checksum is missing')
    index = fetch(REPOSITORY + 'dists/stable/' + relative)
    if digest(index) != match[1] or len(index) != int(match[2]):
        raise ValueError('Package index does not match signed repository metadata')
    (evidence / 'Packages.gz').write_bytes(index)
    packages = parse_packages(gzip.decompress(index).decode())
    runtime = closure(packages, ROOTS)
    # aosp-libs supplies host-side Bionic for testing on Linux/ARM64 only.
    # It is deliberately NOT installed in the Android APK's runtime.
    testing = closure(packages, ['aosp-libs'])
    records = []
    for name, entry in sorted((runtime | testing).items()):
        path = entry['Filename']
        if not path.startswith('pool/') or '..' in Path(path).parts:
            raise ValueError('Unsafe repository filename')
        records.append({'name': name, 'version': entry['Version'], 'architecture': entry['Architecture'],
                        'filename': path, 'size': int(entry['Size']), 'sha256': entry['SHA256'],
                        'runtime': name in runtime})
    lock = {'schema': 1, 'repository': REPOSITORY, 'architecture': architecture, 'runtimeExecutable': 'bun', 'roots': ROOTS,
            'inReleaseSha256': digest(release), 'indexSha256': digest(index), 'signatures': signatures,
            'packages': records}
    destination.write_text(json.dumps(lock, indent=2) + '\n')
    return lock


def fetch_locked(lock, cache, testing=False):
    if lock['repository'] != REPOSITORY or lock['schema'] != 1:
        raise ValueError('Unsupported lockfile')
    cache.mkdir(parents=True, exist_ok=True)
    def download(package):
        filename = Path(package['filename']).name
        target = cache / filename
        data = target.read_bytes() if target.exists() else None
        if data is None or digest(data) != package['sha256']:
            data = fetch(REPOSITORY + package['filename'])
            if digest(data) != package['sha256'] or len(data) != package['size']:
                raise ValueError(f'Package integrity failure: {filename}')
            temporary = target.with_suffix('.partial')
            temporary.write_bytes(data)
            temporary.replace(target)
        print(f'{package["name"]} {package["version"]}: verified', flush=True)
    selected = [p for p in lock['packages'] if p['runtime'] or testing]
    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(download, selected))
    return selected


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch', choices=('aarch64', 'arm', 'i686', 'x86_64'), default='aarch64')
    parser.add_argument('--refresh-lock', action='store_true')
    parser.add_argument('--testing-libs', action='store_true')
    args = parser.parse_args()
    lock_path = ROOT / f'native/prebuilt-lock.{args.arch}.json'
    lock = make_lock(args.arch, lock_path) if args.refresh_lock else json.loads(lock_path.read_text())
    packages = fetch_locked(lock, ROOT / f'build/prebuilt/{args.arch}/debs', args.testing_libs)
    print(f'Fetched {len(packages)} verified prebuilt packages; no target compilation.')
