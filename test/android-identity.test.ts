import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const workspace = 'build/android/termux-app';
function python(args: string[], env: Record<string, string | undefined> = process.env) {
  const run = Bun.spawnSync(['python3', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: new TextDecoder().decode(run.stdout), error: new TextDecoder().decode(run.stderr) };
}

test('Mushi identity/icon overlay is idempotent in its own generated workspace', async () => {
  for (let i = 0; i < 2; i++) {
    const run = python(['scripts/prepare-android.py']);
    expect(run.error).toBe(''); expect(run.code).toBe(0);
  }
  const gradle = await readFile(`${workspace}/app/build.gradle`, 'utf8');
  expect(gradle).toContain('applicationId "io.carmo.mushi"');
  expect(gradle).toContain('namespace "com.termux"');
  expect(gradle).toContain('manifestPlaceholders.TERMUX_PACKAGE_NAME = "io.carmo.mushi"');
  expect(gradle).toContain('"mushi/prepare-bootstraps.py"');
  expect(gradle).toContain('ndk { abiFilters(*mushiArchitectures.collect { mushiAbiMap[it] }) }');
  const constants = await readFile(`${workspace}/termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java`, 'utf8');
  expect(constants).toContain('String TERMUX_PACKAGE_NAME = "io.carmo.mushi";');
  expect(constants).toContain('String BUILD_CONFIG_CLASS_NAME = "com.termux.BuildConfig";');
  expect(constants).toContain('String TERMUX_ACTIVITY_NAME = "com.termux.app.TermuxActivity";');
  const manifest = await readFile(`${workspace}/app/src/main/AndroidManifest.xml`, 'utf8');
  expect(manifest).not.toContain('android:sharedUserId');
  expect(manifest).toContain('.app.MushiActivity');
  expect(manifest).toContain('android:label="Mushi"');
  expect(await readFile(`${workspace}/gradle.properties`, 'utf8')).toContain('minSdkVersion=28');
  const shortcuts = await readFile(`${workspace}/app/src/main/res/xml/shortcuts.xml`, 'utf8');
  expect(shortcuts).toContain('android:targetPackage="io.carmo.mushi"');
  expect(await readFile('android/start-agent.sh', 'utf8')).toStartWith('#!/data/data/io.carmo.mushi/files/usr/bin/bash');
  expect(await readFile(`${workspace}/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml`, 'utf8')).toContain('<monochrome');
  expect(await readFile(`${workspace}/app/src/main/assets/mushi/mushi.svg`, 'utf8')).toContain('Mushi firefly');
});

test('bootstrap staging rejects missing, relabeled or corrupt native artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mushi-prefix-'));
  const source = join(directory, 'source'), destination = join(directory, 'output');
  const env = { ...process.env, MUSHI_BOOTSTRAP_DIR: source };
  try {
    const missing = python(['scripts/prepare-bootstraps.py', '--destination', destination], { ...process.env, MUSHI_BOOTSTRAP_DIR: undefined });
    expect(missing.code).not.toBe(0); expect(missing.error).toContain('Set MUSHI_BOOTSTRAP_DIR');
    const fixture = python(['-c', `
import pathlib, sys
sys.path.insert(0, 'test'); from native_fixtures import bootstrap, manifest
p = pathlib.Path(sys.argv[1])
for arch in ('aarch64', 'arm', 'i686', 'x86_64'): bootstrap(p, arch)
manifest(p, ('aarch64', 'arm', 'i686', 'x86_64'))
`, source]);
    expect(fixture.code).toBe(0);
    const args = ['scripts/prepare-bootstraps.py', '--destination', destination];
    const valid = python(args, env); expect(valid.error).toBe(''); expect(valid.code).toBe(0);
    const manifestPath = join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, applicationId: 'invalid.example.app' }));
    expect(python(args, env).error).toContain('must be rebuilt for io.carmo.mushi');
    await writeFile(manifestPath, JSON.stringify(manifest));
    const oldPrefix = python(['-c', `
import hashlib, json, pathlib, sys, zipfile
p = pathlib.Path(sys.argv[1]); archive = p / 'bootstrap-aarch64.zip'
with zipfile.ZipFile(archive) as z: entries = {e.filename: z.read(e) for e in z.infolist()}
entries['bin/bash'] += b'/data/data/com.termux/files/usr'
with zipfile.ZipFile(archive, 'w') as z:
    for name, data in entries.items(): z.writestr(name, data)
m = json.loads((p / 'manifest.json').read_text()); m['sha256']['aarch64'] = hashlib.sha256(archive.read_bytes()).hexdigest()
(p / 'manifest.json').write_text(json.dumps(m))
`, source]);
    expect(oldPrefix.code).toBe(0);
    expect(python(args, env).error).toContain('still references the stock Termux prefix');
    await writeFile(join(source, 'bootstrap-aarch64.zip'), 'corrupt');
    expect(python(args, env).error).toContain('Checksum mismatch');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
