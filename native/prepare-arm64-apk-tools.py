#!/usr/bin/env python3
"""Adapt only the APK's small NDK/JNI build to native Linux ARM64 LLVM.
Target headers, libraries and compiler runtimes remain the original NDK's.
No userland compilation, x86 interpreter or QEMU wrapper is introduced.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shlex
import shutil


def write(path, text):
    path.unlink(missing_ok=True)  # Never modify a hard-linked original NDK file.
    path.write_text(text)
    path.chmod(0o755)


def link(path, target):
    path.unlink(missing_ok=True)
    path.symlink_to(target)


def prepare(base, output, llvm):
    if platform.machine() not in ('aarch64', 'arm64'):
        raise ValueError('This adapter is for ARM64 Linux hosts')
    for name in ('clang', 'clang++', 'ld.lld', 'llvm-ar', 'llvm-strip'):
        data = (llvm / 'bin' / name).read_bytes()
        if data[:4] != b'\x7fELF' or int.from_bytes(data[18:20], 'little') != 183:
            raise ValueError(f'{name} is not a native ARM64 executable')
    if output.exists():
        raise ValueError('Choose a new output directory; do not overwrite a live toolchain')
    shutil.copytree(base, output, copy_function=os.link, symlinks=True)
    tools = output / 'toolchains/llvm/prebuilt/linux-x86_64'
    resources = list((tools / 'lib/clang').iterdir())
    if len(resources) != 1:
        raise ValueError('Ambiguous NDK compiler resources')
    # linux-x86_64 is retained solely as the directory tag expected by NDK make
    # scripts. Its executable files are replaced with ARM64 tools or fail-closed
    # stubs; this does not emulate the x86 ISA.
    for path in (tools / 'bin').iterdir():
        if not path.is_file() or path.read_bytes()[:4] != b'\x7fELF':
            continue
        candidate = llvm / 'bin' / path.name
        if path.name in ('ld', 'lld', 'ld.lld'):
            candidate = llvm / 'bin/ld.lld'
        if candidate.exists():
            link(path, candidate)
        else:
            write(path, f'#!/bin/sh\necho "Unported optional NDK host tool: {path.name}" >&2\nexit 126\n')
    for name, driver in [('clang', 'clang'), ('clang-21', 'clang'), ('clang++', 'clang++')]:
        extra = ' -stdlib=libc++' if driver == 'clang++' else ''
        write(tools / 'bin' / name, '#!/bin/sh\nexec ' + shlex.quote(str(llvm / 'bin' / driver)) +
              ' --sysroot=' + shlex.quote(str(tools / 'sysroot')) +
              ' -resource-dir ' + shlex.quote(str(resources[0])) +
              ' --ld-path=' + shlex.quote(str(llvm / 'bin/ld.lld')) +
              ' --rtlib=compiler-rt --unwindlib=libunwind -Wno-unused-command-line-argument' + extra + ' "$@"\n')
    common = output / 'build/tools/ndk_bin_common.sh'
    text = common.read_text().replace('  arm64) HOST_ARCH=arm64;;',
        '  aarch64|arm64) HOST_ARCH=x86_64;; # Mushi: compatibility directory tag; tools are native ARM64')
    write(common, text)
    prebuilt = output / 'prebuilt/linux-x86_64/bin'
    link(prebuilt / 'make', shutil.which('make'))
    for python in (output / 'python3/bin/python3', tools / 'python3/bin/python3'):
        if python.parent.exists():
            write(python, '#!/bin/sh\nunset PYTHONHOME PYTHONPATH\nexec /usr/bin/python3 "$@"\n')
    # Some NDK revisions keep Python in prebuilt/<host>/bin instead.
    for name in ('python', 'python3'):
        if (prebuilt / name).exists():
            write(prebuilt / name, '#!/bin/sh\nunset PYTHONHOME PYTHONPATH\nexec /usr/bin/python3 "$@"\n')
    (output / 'mushi-host-adapter.json').write_text(json.dumps({'host': 'linux-arm64', 'llvm': str(llvm), 'baseNdk': str(base), 'emulation': False}, indent=2) + '\n')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ndk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--llvm', type=Path, default=Path('/usr/lib/llvm-21'))
    args = parser.parse_args()
    print(prepare(args.ndk.resolve(), args.output.resolve(), args.llvm.resolve()))
