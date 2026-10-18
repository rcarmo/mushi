import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function python(code: string, ...args: string[]) {
  const run = Bun.spawnSync(['python3', '-c', code, ...args], { stdout: 'pipe', stderr: 'pipe' });
  expect(new TextDecoder().decode(run.stderr)).toBe(''); expect(run.exitCode).toBe(0);
  return new TextDecoder().decode(run.stdout);
}

test('frozen prebuilt lock pins the minimal runtime and not npm or the host Bionic libraries', async () => {
  const lock = JSON.parse(await readFile('native/prebuilt-lock.aarch64.json', 'utf8'));
  expect(lock.signatures).toContain('CC72CF8BA7DBFA0182877D045A897D96E57CF20C');
  expect(lock.indexSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(lock.runtimeExecutable).toBe('bun');
  expect(lock.packages.find((p: any) => p.name === 'bun').version).toMatch(/^1\.4\./);
  expect(lock.packages.some((p: any) => p.runtime && p.name.startsWith('nodejs'))).toBe(false);
  expect(lock.packages.find((p: any) => p.name === 'aosp-libs').runtime).toBe(false);
  expect(lock.packages.some((p: any) => p.name === 'npm' && p.runtime)).toBe(false);
  expect(lock.packages.some((p: any) => p.name === 'termux-licenses' && p.runtime)).toBe(true);
  for (const record of lock.packages) {
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.filename).toStartWith('pool/');
    expect(record.size).toBeGreaterThan(0);
  }
  expect(await readFile('scripts/build-apk.ts', 'utf8')).toContain("'scripts/build-runtime.ts'");
  expect(await readFile('.github/workflows/android.yml', 'utf8')).not.toContain('SYS_ADMIN');
});

test('dependency resolution enforces versions and alternatives, excludes recommendations, and text relocation does not patch binary strings', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mushi-prebuilt-unit-'));
  try {
    const output = python(`
import importlib.util, pathlib, sys

def load(name, file):
 s = importlib.util.spec_from_file_location(name, file); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
fetch = load('fetcher', 'native/prebuilt-runtime.py')
packages = fetch.parse_packages('Package: node\\nVersion: 24.0\\nDepends: absent | shell (>= 5), libc\\nRecommends: npm\\n\\nPackage: shell\\nVersion: 5.3\\n\\nPackage: libc\\nVersion: 1\\n\\nPackage: npm\\nVersion: 1\\n')
assert set(fetch.closure(packages, ['node'])) == {'node', 'shell', 'libc'}
packages['shell']['Version'] = '4.0'
try: fetch.closure(packages, ['node'])
except ValueError: pass
else: raise AssertionError('unsatisfied dependency was accepted')
assembly = load('assembly', 'native/assemble-prebuilt.py')
p = pathlib.Path(sys.argv[1]); (p / 'bin').mkdir(); (p / 'etc').mkdir()
script = p / 'bin/tool'; script.write_text('#!/data/data/com.termux/files/usr/bin/sh\\necho /data/data/com.termux/files/home\\n')
binary = p / 'etc/binary'; binary.write_bytes(b'\\x00/data/data/com.termux/files/usr')
(p / 'etc/link').symlink_to('/data/data/com.termux/files/home')
report = assembly.relocate_tree(p)
assert '/data/data/io.carmo.mushi/files/home' in script.read_text()
assert (p / 'etc/link').readlink() == pathlib.Path('/data/data/io.carmo.mushi/files/home')
assert binary.read_bytes() == b'\\x00/data/data/com.termux/files/usr'
assert report['textPaths'] == ['bin/tool']
print('dependency and relocation checks passed')
`, temporary);
    expect(output.trim()).toBe('dependency and relocation checks passed');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('APK verification detects an outdated embedded bootstrap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-apk-payload-'));
  try {
    const output = python(`
import hashlib, importlib.util, json, pathlib, sys, zipfile
sys.path.insert(0, 'test'); from native_fixtures import bootstrap
p = pathlib.Path(sys.argv[1]); blob = bootstrap(p).read_bytes()
(p / 'manifest.json').write_text(json.dumps({'sha256': {'aarch64': hashlib.sha256(blob).hexdigest()}}))
apk = p / 'test.apk'
with zipfile.ZipFile(apk, 'w') as z: z.writestr('lib/arm64-v8a/libtermux-bootstrap.so', b'synthetic ELF prefix' + blob + b'synthetic ELF suffix')
s = importlib.util.spec_from_file_location('verifier', 'scripts/verify-apk-runtime.py'); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
assert m.verify(apk, p)['runtimes'][0]['architecture'] == 'aarch64'
(p / 'manifest.json').write_text(json.dumps({'sha256': {'aarch64': '0' * 64}}))
try: m.verify(apk, p)
except ValueError as e: assert 'stale' in str(e)
else: raise AssertionError('stale APK bootstrap accepted')
print('APK payload checks passed')
`, directory);
    expect(output.trim()).toBe('APK payload checks passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('exec bridge redirects only the exact stock prefix, using a native host-C fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-exec-bridge-'));
  try {
    const output = python(`
import os, pathlib, subprocess, sys
p = pathlib.Path(sys.argv[1]); prefix = p / 'usr'; (prefix / 'bin').mkdir(parents=True)
(prefix / 'bin/sh').symlink_to('/bin/sh')
subprocess.run(['cc', '-shared', '-fPIC', '-O2', '-D_GNU_SOURCE', '-DMUSHI_PREFIX="' + str(prefix) + '"', 'native/exec-prefix.c', '-ldl', '-o', str(p / 'bridge.so')], check=True, stderr=subprocess.PIPE)
(p / 'caller.c').write_text('#include <unistd.h>\\nint main(int argc, char **argv) { char *args[] = {"sh", "-c", "printf bridge-ok", 0}; if (argc != 2) return 2; execvp(argv[1], args); return 19; }\\n')
subprocess.run(['cc', str(p / 'caller.c'), '-o', str(p / 'caller')], check=True)
env = dict(os.environ, LD_PRELOAD=str(p / 'bridge.so'))
ok = subprocess.run([str(p / 'caller'), '/data/data/com.termux/files/usr/bin/sh'], env=env, capture_output=True, text=True)
assert ok.returncode == 0 and ok.stdout == 'bridge-ok', (ok.returncode, ok.stdout, ok.stderr)
wrong = subprocess.run([str(p / 'caller'), '/data/data/com.termux/files/usrevil/bin/sh'], env=env, capture_output=True)
assert wrong.returncode == 19
print('native exec bridge checks passed')
`, directory);
    expect(output.trim()).toBe('native exec bridge checks passed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
