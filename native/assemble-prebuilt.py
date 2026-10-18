#!/usr/bin/env python3
"""Relocate the locked runtime with ELF runpaths, text fixes and a tiny exec bridge.
No target library/program is rebuilt; only native/exec-prefix.c is compiled.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OLD_DATA = '/data/data/com.termux'
NEW_DATA = '/data/data/io.carmo.mushi'
OLD_PREFIX = OLD_DATA + '/files/usr'
PREFIX = NEW_DATA + '/files/usr'
TRIPLES = {'aarch64': 'aarch64-linux-android24', 'arm': 'armv7a-linux-androideabi24', 'i686': 'i686-linux-android24', 'x86_64': 'x86_64-linux-android24'}
RUNPATH = '$ORIGIN:$ORIGIN/..:$ORIGIN/../lib:$ORIGIN/../../lib'


def load_fetcher():
    spec = importlib.util.spec_from_file_location('prebuilt_fetch', ROOT / 'native/prebuilt-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def environment(prefix=PREFIX):
    # Android system libraries are supplied by the device, not this archive.
    return f'''# Mushi's relocated Bun runtime.
export PREFIX={shlex.quote(prefix)}
export PATH="$PREFIX/bin:/system/bin"
export TMPDIR="$PREFIX/tmp"
export LD_LIBRARY_PATH="$PREFIX/lib${{MUSHI_TEST_SYSTEM_LIBS:+:$MUSHI_TEST_SYSTEM_LIBS}}"
export LD_PRELOAD="$PREFIX/lib/libmushi-exec.so"
export SHELL="$PREFIX/bin/bash"
export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"
export SSL_CERT_DIR="$PREFIX/etc/tls/certs"
export CURL_CA_BUNDLE="$SSL_CERT_FILE"
export GIT_SSL_CAINFO="$SSL_CERT_FILE"
export NODE_EXTRA_CA_CERTS="$SSL_CERT_FILE"
export OPENSSL_CONF="$PREFIX/etc/tls/openssl.cnf"
export OPENSSL_MODULES="$PREFIX/lib/ossl-modules"
export GIT_EXEC_PATH="$PREFIX/libexec/git-core"
export GIT_TEMPLATE_DIR="$PREFIX/share/git-core/templates"
export GIT_CONFIG_SYSTEM="$PREFIX/etc/gitconfig"
export TERMINFO="$PREFIX/share/terminfo"
export TERMINFO_DIRS="$TERMINFO"
export BASH_LOADABLES_PATH="$PREFIX/lib/bash"
export BUN_INSTALL="$HOME/.bun"
'''


def replace_file(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    path.write_text(content)
    path.chmod(mode)


def compile_bridge(arch, runtime, ndk):
    toolchain = ndk / 'toolchains/llvm/prebuilt/linux-x86_64'
    versions = sorted((toolchain / 'lib/clang').iterdir())
    if len(versions) != 1:
        raise ValueError('Expected one NDK compiler resource directory')
    compiler = os.environ.get('MUSHI_RUNTIME_CC')
    if not compiler:
        compiler = str(toolchain / 'bin/clang') if platform.machine() == 'x86_64' else shutil.which('clang-21')
    if not compiler:
        raise ValueError('Install ARM64 clang-21 or set MUSHI_RUNTIME_CC; no QEMU fallback')
    linker = os.environ.get('MUSHI_RUNTIME_LD') or (str(toolchain / 'bin/ld.lld') if platform.machine() == 'x86_64' else shutil.which('ld.lld-21'))
    if not linker:
        raise ValueError('Install native lld-21 or set MUSHI_RUNTIME_LD')
    source = ROOT / 'native/exec-prefix.c'
    output = runtime / 'lib/libmushi-exec.so'
    command = [compiler, '--target=' + TRIPLES[arch], '--sysroot=' + str(toolchain / 'sysroot'),
               '-resource-dir', str(versions[0]), '--ld-path=' + linker,
               '--rtlib=compiler-rt', '--unwindlib=none', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
               '-Wl,-soname,libmushi-exec.so', '-Wl,-z,max-page-size=16384', str(source), '-ldl', '-o', str(output)]
    subprocess.run(command, check=True)
    return {'source': 'native/exec-prefix.c', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'command': command}


def relocate_tree(runtime):
    text_files, elf_files, residual = [], [], []
    for path in sorted(runtime.rglob('*')):
        relative = path.relative_to(runtime).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if target == OLD_DATA or target.startswith(OLD_DATA + '/'):
                path.unlink()
                path.symlink_to(NEW_DATA + target[len(OLD_DATA):])
            continue
        if not path.is_file():
            continue
        data = path.read_bytes()
        if data.startswith(b'\x7fELF'):
            kind = int.from_bytes(data[16:18], 'little')
            if kind not in (2, 3):
                continue
            dynamic = subprocess.run(['patchelf', '--print-rpath', str(path)], capture_output=True)
            if dynamic.returncode:
                continue
            # Bun links only Android system libc/m/dl and needs no relocation
            # of its own ELF. Avoid rewriting the large runtime unnecessarily.
            if relative != 'bin/bun':
                subprocess.run(['patchelf', '--page-size', '16384', '--set-rpath', RUNPATH, str(path)], check=True)
            needed = subprocess.check_output(['patchelf', '--print-needed', str(path)], text=True).splitlines()
            if relative == 'bin/bun' and any(name not in ('libc.so', 'libm.so', 'libdl.so') for name in needed):
                raise ValueError('Bun gained non-system library dependencies; review relocation before shipping')
            for name in needed:
                if name.startswith(OLD_PREFIX + '/'):
                    subprocess.run(['patchelf', '--replace-needed', name, Path(name).name, str(path)], check=True)
            if relative != 'bin/bun': elf_files.append(relative)
            if OLD_PREFIX.encode() in path.read_bytes():
                residual.append(relative)
        elif b'\0' not in data and OLD_DATA.encode() in data:
            try:
                text = data.decode('utf8')
            except UnicodeDecodeError:
                continue
            path.write_text(text.replace(OLD_DATA, NEW_DATA))
            text_files.append(relative)
    return {'elfRunpaths': elf_files, 'textPaths': text_files,
            'compiledDefaultsRemaining': residual,
            'note': 'Residual compiled defaults are not blindly binary-patched. Tested execution uses environment overrides and the exec-only bridge; arbitrary Termux packages are not guaranteed relocatable.'}


def pack(runtime, target):
    links = []
    temporary = target.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(runtime.rglob('*')):
            relative = path.relative_to(runtime).as_posix()
            if path.is_symlink():
                links.append(f'{os.readlink(path)}←{relative}')
            elif path.is_dir():
                info = zipfile.ZipInfo(relative + '/', (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o40700 << 16
                archive.writestr(info, b'')
            elif path.is_file():
                info = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o100000 | (path.stat().st_mode & 0o777)) << 16
                archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        info = zipfile.ZipInfo('SYMLINKS.txt', (1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100600 << 16
        archive.writestr(info, '\n'.join(links) + '\n')
    temporary.replace(target)


def assemble(arch, ndk, output, fetch=True):
    lock_file = ROOT / f'native/prebuilt-lock.{arch}.json'
    lock = json.loads(lock_file.read_text())
    if lock.get('runtimeExecutable') != 'bun' or any(p['runtime'] and p['name'].startswith('nodejs') for p in lock['packages']):
        raise ValueError('Mushi requires a Bun-only runtime lock; refresh and review the package lock')
    cache = ROOT / f'build/prebuilt/{arch}/debs'
    fetcher = load_fetcher()
    records = fetcher.fetch_locked(lock, cache) if fetch else [p for p in lock['packages'] if p['runtime']]
    base = ROOT / f'build/prebuilt/{arch}/assembled'
    # Explicitly generated workspace only; never touch an installed app prefix.
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True)
    for record in records:
        archive = cache / Path(record['filename']).name
        if hashlib.sha256(archive.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Unverified package archive: ' + str(archive))
        subprocess.run(['dpkg-deb', '-x', str(archive), str(base)], check=True)
    runtime = base / OLD_PREFIX.lstrip('/')
    # No postinst scripts are executed, and no public APT repos are activated.
    for directory in ['libexec/installed-tests', 'share/man', 'share/info']:
        shutil.rmtree(runtime / directory, ignore_errors=True)
    report = relocate_tree(runtime)
    report['execBridge'] = compile_bridge(arch, runtime, ndk)
    replace_file(runtime / 'etc/mushi/environment.sh', environment())
    replace_file(runtime / 'etc/mushi/bashrc', '. "${PREFIX}/etc/mushi/environment.sh"\nPS1="mushi:\\w\\$ "\n')
    replace_file(runtime / 'etc/profile', environment())
    replace_file(runtime / 'etc/apt/sources.list', '# Mushi prebuilt snapshot: no package repositories enabled.\n')
    # Disable helpers tied to the upstream Termux APK and package manager.
    disabled = [p for p in (runtime / 'bin').glob('termux-*')] + [runtime / 'bin/am', runtime / 'bin/pkg']
    for path in disabled:
        replace_file(path, f'#!{PREFIX}/bin/sh\necho "{path.name}: not supported by Mushi\'s relocated runtime" >&2\nexit 69\n', 0o700)
    replace_file(runtime / 'bin/login', f'#!{PREFIX}/bin/sh\n. "$PREFIX/etc/mushi/environment.sh"\nexec "$PREFIX/bin/bash" --rcfile "$PREFIX/etc/mushi/bashrc" -i "$@"\n', 0o700)
    metadata = {'applicationId': 'io.carmo.mushi', 'prefix': PREFIX, 'originalPrefix': OLD_PREFIX,
                'architecture': arch, 'runtimeKind': 'termux-prebuilt-relocated',
                'runtimePackages': ['bun', 'git', 'ca-certificates'], 'runtimeExecutable': 'bun', 'minimumAndroidApi': 28,
                'lockSha256': hashlib.sha256(lock_file.read_bytes()).hexdigest(),
                'repositorySignatures': lock['signatures'], 'androidDeviceVerified': False}
    replace_file(runtime / 'etc/mushi/native.json', json.dumps(metadata, indent=2) + '\n')
    replace_file(runtime / 'etc/mushi/relocation.json', json.dumps(report, indent=2) + '\n')
    (runtime / 'tmp').mkdir(exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    target = output / f'bootstrap-{arch}.zip'
    pack(runtime, target)
    manifest_file = output / 'manifest.json'
    manifest = {'applicationId': metadata['applicationId'], 'prefix': PREFIX,
                'runtimeKind': metadata['runtimeKind'], 'sha256': {arch: hashlib.sha256(target.read_bytes()).hexdigest()}}
    if manifest_file.exists():
        previous = json.loads(manifest_file.read_text())
        if previous.get('runtimeKind') != manifest['runtimeKind']:
            raise ValueError('Do not mix source-built and prebuilt archives in one output directory')
        manifest['sha256'] = previous['sha256'] | manifest['sha256']
    manifest_file.write_text(json.dumps(manifest, indent=2) + '\n')
    (output / f'packages-{arch}.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'Prebuilt runtime: {runtime}\nBootstrap: {target}')
    return runtime, target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--arch', choices=TRIPLES, default='aarch64')
    parser.add_argument('--ndk', type=Path, default=os.environ.get('NDK'))
    parser.add_argument('--output', type=Path, default=ROOT / 'build/prebuilt/bootstraps')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    if args.ndk is None:
        parser.error('--ndk or NDK is required only for the tiny exec compatibility bridge')
    assemble(args.arch, args.ndk.resolve(), args.output.resolve(), not args.offline)
